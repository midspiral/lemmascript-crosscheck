import type { Ty, TypeDeclInfo } from "./ir.js";
import { Rational } from "./rational.js";

export interface BridgeContext {
  declarations: ReadonlyMap<string, TypeDeclInfo>;
}

export interface RuntimeEncoding {
  ok: true;
  value: unknown;
}

export interface RuntimeEncodingFailure {
  ok: false;
  path: string;
  reason: string;
  formalValue: unknown;
}

export type RuntimeEncodingResult = RuntimeEncoding | RuntimeEncodingFailure;

export interface RuntimeProjectionLoss {
  path: string;
  formalValue: unknown;
  runtimeValue: number;
}

export interface RuntimeProjection {
  ok: true;
  value: unknown;
  losses: RuntimeProjectionLoss[];
}

export type RuntimeProjectionResult = RuntimeProjection | RuntimeEncodingFailure;

export function encodeRuntime(
  ty: Ty,
  modelValue: unknown,
  context: BridgeContext,
  tsType?: string,
  path = "value",
): RuntimeEncodingResult {
  return encodeRuntimeValue(ty, modelValue, context, tsType, path);
}

/**
 * Deliberately project an exact formal value into its JavaScript representation.
 * Unlike `encodeRuntime`, this records finite numeric rounding instead of hiding it.
 * Invalid formal shapes and non-finite projections still fail.
 */
export function projectRuntime(
  ty: Ty,
  modelValue: unknown,
  context: BridgeContext,
  tsType?: string,
  path = "value",
): RuntimeProjectionResult {
  const losses: RuntimeProjectionLoss[] = [];
  const encoded = encodeRuntimeValue(ty, modelValue, context, tsType, path, losses);
  return encoded.ok ? { ...encoded, losses } : encoded;
}

function encodeRuntimeValue(
  ty: Ty,
  modelValue: unknown,
  context: BridgeContext,
  tsType?: string,
  path = "value",
  losses?: RuntimeProjectionLoss[],
): RuntimeEncodingResult {
  switch (ty.kind) {
    case "bool":
      return typeof modelValue === "boolean"
        ? { ok: true, value: modelValue }
        : failure(path, "formal boolean has an invalid model value", modelValue);
    case "int":
    case "nat": {
      if (typeof modelValue !== "bigint") return failure(path, "formal integer is not exact", modelValue);
      if (ty.kind === "nat" && modelValue < 0n) return failure(path, "natural number is negative", modelValue);
      if (ty.big) return { ok: true, value: modelValue };
      const runtime = Number(modelValue);
      if (!Number.isFinite(runtime) || !Number.isInteger(runtime) || BigInt(runtime) !== modelValue) {
        if (losses && Number.isFinite(runtime) && Number.isInteger(runtime)) {
          losses.push({ path, formalValue: modelValue, runtimeValue: runtime });
          return { ok: true, value: runtime };
        }
        return failure(path, "JavaScript number cannot represent this integer exactly", modelValue);
      }
      return { ok: true, value: runtime };
    }
    case "real": {
      if (!(modelValue instanceof Rational)) return failure(path, "formal real is not an exact rational", modelValue);
      const runtime = Number(modelValue.numerator) / Number(modelValue.denominator);
      if (!Number.isFinite(runtime) || !Rational.fromDouble(runtime).equals(modelValue)) {
        if (losses && Number.isFinite(runtime)) {
          losses.push({ path, formalValue: modelValue, runtimeValue: runtime });
          return { ok: true, value: runtime };
        }
        return failure(path, "JavaScript number cannot represent this rational exactly", modelValue);
      }
      return { ok: true, value: runtime };
    }
    case "string":
      return typeof modelValue === "string"
        ? { ok: true, value: modelValue }
        : failure(path, "formal string has an invalid model value", modelValue);
    case "array": {
      if (!Array.isArray(modelValue)) return failure(path, "formal sequence is not an array", modelValue);
      const output: unknown[] = [];
      for (let index = 0; index < modelValue.length; index++) {
        const encoded = encodeRuntimeValue(ty.elem, modelValue[index], context, undefined, `${path}[${index}]`, losses);
        if (!encoded.ok) return encoded;
        output.push(encoded.value);
      }
      return { ok: true, value: output };
    }
    case "tuple": {
      if (!Array.isArray(modelValue) || modelValue.length !== ty.elems.length) {
        return failure(path, `formal tuple does not have arity ${ty.elems.length}`, modelValue);
      }
      const output: unknown[] = [];
      for (let index = 0; index < ty.elems.length; index++) {
        const elemTy = ty.elems[index];
        if (!elemTy) return failure(path, "tuple type is incomplete", modelValue);
        const encoded = encodeRuntimeValue(elemTy, modelValue[index], context, undefined, `${path}[${index}]`, losses);
        if (!encoded.ok) return encoded;
        output.push(encoded.value);
      }
      return { ok: true, value: output };
    }
    case "optional":
      return modelValue === undefined || modelValue === null
        ? { ok: true, value: undefined }
        : encodeRuntimeValue(ty.inner, modelValue, context, tsType, path, losses);
    case "set": {
      const values = modelValue instanceof Set ? [...modelValue] : Array.isArray(modelValue) ? modelValue : null;
      if (!values) return failure(path, "formal set has an invalid model value", modelValue);
      const output = new Set<unknown>();
      for (let index = 0; index < values.length; index++) {
        const encoded = encodeRuntimeValue(ty.elem, values[index], context, undefined, `${path}{${index}}`, losses);
        if (!encoded.ok) return encoded;
        output.add(encoded.value);
      }
      return { ok: true, value: output };
    }
    case "map": {
      const entries = modelValue instanceof Map
        ? [...modelValue.entries()]
        : modelValue && typeof modelValue === "object" && !Array.isArray(modelValue)
          ? Object.entries(modelValue)
          : null;
      if (!entries) return failure(path, "formal map has an invalid model value", modelValue);
      const encodedEntries: [unknown, unknown][] = [];
      for (let index = 0; index < entries.length; index++) {
        const entry = entries[index];
        if (!entry) continue;
        const key = encodeRuntimeValue(ty.key, entry[0], context, undefined, `${path}.key${index}`, losses);
        if (!key.ok) return key;
        const value = encodeRuntimeValue(ty.value, entry[1], context, undefined, `${path}.value${index}`, losses);
        if (!value.ok) return value;
        encodedEntries.push([key.value, value.value]);
      }
      if (tsType?.trim().startsWith("Map<")) return { ok: true, value: new Map(encodedEntries) };
      return { ok: true, value: Object.fromEntries(encodedEntries.map(([key, value]) => [String(key), value])) };
    }
    case "user":
      return encodeUser(ty.name, modelValue, context, path, losses);
    case "void":
      return failure(path, "void cannot be used as an input", modelValue);
    case "fn":
      return failure(path, "function values have no Crosscheck representation", modelValue);
    case "unknown":
      return failure(path, "unknown LemmaScript type", modelValue);
  }
}

function encodeUser(
  name: string,
  value: unknown,
  context: BridgeContext,
  path: string,
  losses?: RuntimeProjectionLoss[],
): RuntimeEncodingResult {
  const declaration = context.declarations.get(name);
  if (!declaration) return failure(path, `missing declaration for ${name}`, value);
  if (declaration.typeParams?.length) return failure(path, `generic user type ${name} is unsupported`, value);
  switch (declaration.kind) {
    case "string-union":
      return typeof value === "string" && declaration.values?.includes(value)
        ? { ok: true, value }
        : failure(path, `value is not a member of ${name}`, value);
    case "alias":
      return declaration.aliasOfTy
        ? encodeRuntimeValue(declaration.aliasOfTy, value, context, declaration.aliasOf, path, losses)
        : failure(path, `alias ${name} has no resolved type`, value);
    case "record": {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        return failure(path, `${name} is not a record`, value);
      }
      const output: Record<string, unknown> = {};
      for (const field of declaration.fields ?? []) {
        if (!field.type) return failure(`${path}.${field.name}`, "field type is unresolved", value);
        const fieldValue = (value as Record<string, unknown>)[field.name];
        if (field.type.kind === "optional" && (fieldValue === undefined || fieldValue === null)) continue;
        const encoded = encodeRuntimeValue(
          field.type,
          fieldValue,
          context,
          field.tsType,
          `${path}.${field.name}`,
          losses,
        );
        if (!encoded.ok) return encoded;
        output[field.name] = encoded.value;
      }
      return { ok: true, value: output };
    }
    case "discriminated-union": {
      if (declaration.discriminant === "__isArray__") {
        const variant = declaration.variants?.find(candidate => candidate.name === (Array.isArray(value) ? "ArrayBranch" : "NonArrayBranch"));
        const field = variant?.fields[0];
        if (!field?.type) return failure(path, `synthetic union ${name} is incomplete`, value);
        return encodeRuntimeValue(field.type, value, context, field.tsType, path, losses);
      }
      if (!value || typeof value !== "object" || !declaration.discriminant) {
        return failure(path, `${name} is not a tagged record`, value);
      }
      const tag = (value as Record<string, unknown>)[declaration.discriminant];
      const variant = declaration.variants?.find(candidate => candidate.name === tag);
      if (!variant) return failure(path, `${name} has an unknown variant`, value);
      const output: Record<string, unknown> = { [declaration.discriminant]: tag };
      for (const field of variant.fields) {
        if (field.name === declaration.discriminant) continue;
        if (!field.type) return failure(`${path}.${field.name}`, "field type is unresolved", value);
        const fieldValue = (value as Record<string, unknown>)[field.name];
        if (field.type.kind === "optional" && (fieldValue === undefined || fieldValue === null)) continue;
        const encoded = encodeRuntimeValue(
          field.type,
          fieldValue,
          context,
          field.tsType,
          `${path}.${field.name}`,
          losses,
        );
        if (!encoded.ok) return encoded;
        output[field.name] = encoded.value;
      }
      return { ok: true, value: output };
    }
    case "opaque":
      return failure(path, `opaque user type ${name} is unsupported`, value);
  }
}

type NumberBackedTy = Extract<Ty, { kind: "int" | "nat" | "real" }>;

interface ValueNumericSite {
  path: string;
  ty: NumberBackedTy;
  replace(root: unknown, replacement: unknown): unknown;
}

interface ArgumentNumericSite extends ValueNumericSite {
  param: number;
}

export interface NumericPrecisionVariant {
  key: string;
  args: unknown[];
}

// Binary64 represents 2^53 exactly, but rounds 2^53 + 1 back to 2^53.
const COLLISION_EXACT = 9_007_199_254_740_992n;
const COLLISION_ROUNDED = 9_007_199_254_740_993n;
const MAX_PRECISION_SITES = 8;

/**
 * Type-directed formal inputs that expose IEEE-754 input rounding. Variants
 * are derived from a concrete generated shape, not from function names or AST
 * operators. Single-site variants catch value-sensitive code; paired variants
 * catch distinct numeric inputs collapsing before equality/comparison.
 */
export function numericPrecisionVariants(
  params: readonly { name: string; ty: Ty }[],
  modelArgs: unknown[],
  context: BridgeContext,
): NumericPrecisionVariant[] {
  const sites: ArgumentNumericSite[] = [];
  for (let param = 0; param < params.length && sites.length < MAX_PRECISION_SITES; param++) {
    const parameter = params[param];
    if (!parameter) continue;
    const nested = valueNumericSites(parameter.ty, modelArgs[param], context, parameter.name, new Set());
    for (const site of nested) {
      sites.push({ ...site, param });
      if (sites.length >= MAX_PRECISION_SITES) break;
    }
  }

  const variants: NumericPrecisionVariant[] = [];
  for (const site of sites) {
    variants.push({
      key: `single:${site.path}`,
      args: applyNumericSite(modelArgs, site, boundaryValue(site.ty, COLLISION_ROUNDED)),
    });
  }
  for (let left = 0; left < sites.length; left++) {
    for (let right = left + 1; right < sites.length; right++) {
      const leftSite = sites[left];
      const rightSite = sites[right];
      if (!leftSite || !rightSite) continue;
      variants.push({
        key: `pair:${leftSite.path}:exact:${rightSite.path}:rounded`,
        args: applyNumericSite(
          applyNumericSite(modelArgs, leftSite, boundaryValue(leftSite.ty, COLLISION_EXACT)),
          rightSite,
          boundaryValue(rightSite.ty, COLLISION_ROUNDED),
        ),
      });
      variants.push({
        key: `pair:${leftSite.path}:rounded:${rightSite.path}:exact`,
        args: applyNumericSite(
          applyNumericSite(modelArgs, leftSite, boundaryValue(leftSite.ty, COLLISION_ROUNDED)),
          rightSite,
          boundaryValue(rightSite.ty, COLLISION_EXACT),
        ),
      });
    }
  }
  return variants;
}

function applyNumericSite(args: unknown[], site: ArgumentNumericSite, replacement: unknown): unknown[] {
  const output = [...args];
  output[site.param] = site.replace(output[site.param], replacement);
  return output;
}

function boundaryValue(ty: NumberBackedTy, value: bigint): unknown {
  return ty.kind === "real" ? Rational.integer(value) : value;
}

function valueNumericSites(
  ty: Ty,
  value: unknown,
  context: BridgeContext,
  path: string,
  seen: ReadonlySet<string>,
): ValueNumericSite[] {
  switch (ty.kind) {
    case "int":
    case "nat":
      return ty.big ? [] : [{ path, ty, replace: (_root, replacement) => replacement }];
    case "real":
      return [{ path, ty, replace: (_root, replacement) => replacement }];
    case "array": {
      if (!Array.isArray(value)) return [];
      return value.flatMap((entry, index) => valueNumericSites(ty.elem, entry, context, `${path}[${index}]`, seen)
        .map(site => ({
          ...site,
          replace: (root: unknown, replacement: unknown) => {
            if (!Array.isArray(root)) return root;
            const output = [...root];
            output[index] = site.replace(output[index], replacement);
            return output;
          },
        })));
    }
    case "tuple": {
      if (!Array.isArray(value)) return [];
      return ty.elems.flatMap((elem, index) => valueNumericSites(elem, value[index], context, `${path}[${index}]`, seen)
        .map(site => ({
          ...site,
          replace: (root: unknown, replacement: unknown) => {
            if (!Array.isArray(root)) return root;
            const output = [...root];
            output[index] = site.replace(output[index], replacement);
            return output;
          },
        })));
    }
    case "optional":
      return value === undefined || value === null ? [] : valueNumericSites(ty.inner, value, context, path, seen);
    case "set": {
      const entries = value instanceof Set ? [...value] : Array.isArray(value) ? value : null;
      if (!entries) return [];
      return entries.flatMap((entry, index) => valueNumericSites(ty.elem, entry, context, `${path}{${index}}`, seen)
        .map(site => ({
          ...site,
          replace: (root: unknown, replacement: unknown) => {
            const values = root instanceof Set ? [...root] : Array.isArray(root) ? [...root] : null;
            if (!values) return root;
            values[index] = site.replace(values[index], replacement);
            return root instanceof Set ? new Set(values) : values;
          },
        })));
    }
    case "map": {
      if (value instanceof Map) {
        const entries = [...value.entries()];
        return entries.flatMap((entry, index) => [
          ...valueNumericSites(ty.key, entry[0], context, `${path}.key${index}`, seen).map(site => ({
            ...site,
            replace: (root: unknown, replacement: unknown) => {
              if (!(root instanceof Map)) return root;
              const output = [...root.entries()];
              const current = output[index];
              if (!current) return root;
              output[index] = [site.replace(current[0], replacement), current[1]];
              return new Map(output);
            },
          })),
          ...valueNumericSites(ty.value, entry[1], context, `${path}.value${index}`, seen).map(site => ({
            ...site,
            replace: (root: unknown, replacement: unknown) => {
              if (!(root instanceof Map)) return root;
              const output = [...root.entries()];
              const current = output[index];
              if (!current) return root;
              output[index] = [current[0], site.replace(current[1], replacement)];
              return new Map(output);
            },
          })),
        ]);
      }
      if (!value || typeof value !== "object" || Array.isArray(value)) return [];
      return Object.entries(value).flatMap(([key, entry]) => valueNumericSites(ty.value, entry, context, `${path}.${key}`, seen)
        .map(site => ({
          ...site,
          replace: (root: unknown, replacement: unknown) => root && typeof root === "object" && !Array.isArray(root)
            ? { ...root, [key]: site.replace((root as Record<string, unknown>)[key], replacement) }
            : root,
        })));
    }
    case "user": {
      if (seen.has(ty.name)) return [];
      const declaration = context.declarations.get(ty.name);
      if (!declaration) return [];
      const nestedSeen = new Set(seen).add(ty.name);
      if (declaration.kind === "alias") {
        return declaration.aliasOfTy ? valueNumericSites(declaration.aliasOfTy, value, context, path, nestedSeen) : [];
      }
      if (declaration.kind === "record") {
        if (!value || typeof value !== "object" || Array.isArray(value)) return [];
        return (declaration.fields ?? []).flatMap(field => field.type
          ? valueNumericSites(field.type, (value as Record<string, unknown>)[field.name], context, `${path}.${field.name}`, nestedSeen)
            .map(site => ({
              ...site,
              replace: (root: unknown, replacement: unknown) => root && typeof root === "object" && !Array.isArray(root)
                ? { ...root, [field.name]: site.replace((root as Record<string, unknown>)[field.name], replacement) }
                : root,
            }))
          : []);
      }
      if (declaration.kind === "discriminated-union") {
        if (declaration.discriminant === "__isArray__") {
          const variant = declaration.variants?.find(candidate => candidate.name === (Array.isArray(value) ? "ArrayBranch" : "NonArrayBranch"));
          const field = variant?.fields[0];
          return field?.type ? valueNumericSites(field.type, value, context, path, nestedSeen) : [];
        }
        if (!value || typeof value !== "object" || !declaration.discriminant) return [];
        const tag = (value as Record<string, unknown>)[declaration.discriminant];
        const variant = declaration.variants?.find(candidate => candidate.name === tag);
        if (!variant) return [];
        return variant.fields.flatMap(field => field.name !== declaration.discriminant && field.type
          ? valueNumericSites(field.type, (value as Record<string, unknown>)[field.name], context, `${path}.${field.name}`, nestedSeen)
            .map(site => ({
              ...site,
              replace: (root: unknown, replacement: unknown) => root && typeof root === "object" && !Array.isArray(root)
                ? { ...root, [field.name]: site.replace((root as Record<string, unknown>)[field.name], replacement) }
                : root,
            }))
          : []);
      }
      return [];
    }
    case "bool": case "string": case "void": case "fn": case "unknown": return [];
  }
}

export interface PresenceVariant {
  args: unknown[];
  path: string;
}

/** Alternate runtime encodings of model `None` for TypeScript optional fields. */
export function optionalPresenceVariants(
  paramTys: readonly Ty[],
  modelArgs: unknown[],
  canonicalRuntimeArgs: unknown[],
  context: BridgeContext,
): PresenceVariant[] {
  const output: PresenceVariant[] = [];
  for (let index = 0; index < paramTys.length; index++) {
    const ty = paramTys[index];
    if (!ty) continue;
    for (const variant of valuePresenceVariants(ty, modelArgs[index], canonicalRuntimeArgs[index], context, `arg${index}`)) {
      const args = canonicalRuntimeArgs.map(cloneRuntimeValue);
      args[index] = variant.value;
      output.push({ args, path: variant.path });
    }
  }
  return output;
}

export function presentUndefinedPath(ty: Ty, value: unknown, context: BridgeContext, path = "result"): string | null {
  if (ty.kind === "array" && Array.isArray(value)) {
    for (let index = 0; index < value.length; index++) {
      const nested = presentUndefinedPath(ty.elem, value[index], context, `${path}[${index}]`);
      if (nested) return nested;
    }
    return null;
  }
  if (ty.kind === "tuple" && Array.isArray(value)) {
    for (let index = 0; index < ty.elems.length; index++) {
      const nested = presentUndefinedPath(ty.elems[index]!, value[index], context, `${path}[${index}]`);
      if (nested) return nested;
    }
    return null;
  }
  if (ty.kind === "optional") return value === undefined || value === null ? null : presentUndefinedPath(ty.inner, value, context, path);
  if (ty.kind !== "user") return null;
  const declaration = context.declarations.get(ty.name);
  if (!declaration || !value || typeof value !== "object") return null;
  if (declaration.kind === "alias" && declaration.aliasOfTy) return presentUndefinedPath(declaration.aliasOfTy, value, context, path);
  if (declaration.kind === "record") {
    for (const field of declaration.fields ?? []) {
      if (!field.type) continue;
      const has = Object.prototype.hasOwnProperty.call(value, field.name);
      const fieldValue = (value as Record<string, unknown>)[field.name];
      if (field.type.kind === "optional" && has && fieldValue === undefined) return `${path}.${field.name}`;
      if (has) {
        const nested = presentUndefinedPath(field.type, fieldValue, context, `${path}.${field.name}`);
        if (nested) return nested;
      }
    }
  }
  return null;
}

interface ValuePresenceVariant {
  value: unknown;
  path: string;
}

function valuePresenceVariants(
  ty: Ty,
  modelValue: unknown,
  runtimeValue: unknown,
  context: BridgeContext,
  path: string,
): ValuePresenceVariant[] {
  if (ty.kind === "array" && Array.isArray(modelValue) && Array.isArray(runtimeValue)) {
    return modelValue.flatMap((entry, index) => valuePresenceVariants(ty.elem, entry, runtimeValue[index], context, `${path}[${index}]`)
      .map(variant => {
        const value = runtimeValue.map(cloneRuntimeValue);
        value[index] = variant.value;
        return { value, path: variant.path };
      }));
  }
  if (ty.kind === "optional") {
    return modelValue === undefined || modelValue === null ? [] : valuePresenceVariants(ty.inner, modelValue, runtimeValue, context, path);
  }
  if (ty.kind !== "user") return [];
  const declaration = context.declarations.get(ty.name);
  if (!declaration || !modelValue || typeof modelValue !== "object" || !runtimeValue || typeof runtimeValue !== "object") return [];
  if (declaration.kind === "alias" && declaration.aliasOfTy) {
    return valuePresenceVariants(declaration.aliasOfTy, modelValue, runtimeValue, context, path);
  }
  if (declaration.kind !== "record") return [];
  const variants: ValuePresenceVariant[] = [];
  for (const field of declaration.fields ?? []) {
    if (!field.type) continue;
    const modelField = (modelValue as Record<string, unknown>)[field.name];
    const runtimeField = (runtimeValue as Record<string, unknown>)[field.name];
    if (field.type.kind === "optional" && (modelField === undefined || modelField === null)
      && !Object.prototype.hasOwnProperty.call(runtimeValue, field.name)) {
      variants.push({ value: { ...runtimeValue, [field.name]: undefined }, path: `${path}.${field.name}` });
      continue;
    }
    for (const nested of valuePresenceVariants(field.type, modelField, runtimeField, context, `${path}.${field.name}`)) {
      variants.push({ value: { ...runtimeValue, [field.name]: nested.value }, path: nested.path });
    }
  }
  return variants;
}

function cloneRuntimeValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(cloneRuntimeValue);
  if (value instanceof Set) return new Set([...value].map(cloneRuntimeValue));
  if (value instanceof Map) return new Map([...value].map(([key, entry]) => [cloneRuntimeValue(key), cloneRuntimeValue(entry)]));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, cloneRuntimeValue(entry)]));
  return value;
}

function failure(path: string, reason: string, formalValue: unknown): RuntimeEncodingFailure {
  return { ok: false, path, reason, formalValue };
}

export function typeSupportReason(ty: Ty, context: BridgeContext, seen = new Set<string>()): string | null {
  switch (ty.kind) {
    case "bool": case "nat": case "int": case "real": case "string": return null;
    case "array": case "set": return typeSupportReason(ty.elem, context, seen);
    case "optional": return typeSupportReason(ty.inner, context, seen);
    case "tuple":
      for (const elem of ty.elems) {
        const reason = typeSupportReason(elem, context, seen);
        if (reason) return reason;
      }
      return null;
    case "map": return typeSupportReason(ty.key, context, seen) ?? typeSupportReason(ty.value, context, seen);
    case "user": {
      if (seen.has(ty.name)) return `recursive user type ${ty.name}`;
      const declaration = context.declarations.get(ty.name);
      if (!declaration) return `missing declaration for ${ty.name}`;
      if (declaration.kind === "opaque") return `opaque user type ${ty.name}`;
      if (declaration.typeParams?.length) return `generic user type ${ty.name}`;
      const nested = new Set(seen).add(ty.name);
      const fields = declaration.fields ?? declaration.variants?.flatMap(variant => variant.fields) ?? [];
      for (const field of fields) {
        if (!field.type) return `unresolved field ${ty.name}.${field.name}`;
        const reason = typeSupportReason(field.type, context, nested);
        if (reason) return reason;
      }
      return declaration.aliasOfTy ? typeSupportReason(declaration.aliasOfTy, context, nested) : null;
    }
    case "void": return "void result";
    case "fn": return "function-typed value";
    case "unknown": return "unknown type";
  }
}
