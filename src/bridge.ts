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

export function encodeRuntime(
  ty: Ty,
  modelValue: unknown,
  context: BridgeContext,
  tsType?: string,
  path = "value",
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
        return failure(path, "JavaScript number cannot represent this integer exactly", modelValue);
      }
      return { ok: true, value: runtime };
    }
    case "real": {
      if (!(modelValue instanceof Rational)) return failure(path, "formal real is not an exact rational", modelValue);
      const runtime = Number(modelValue.numerator) / Number(modelValue.denominator);
      if (!Number.isFinite(runtime) || !Rational.fromDouble(runtime).equals(modelValue)) {
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
        const encoded = encodeRuntime(ty.elem, modelValue[index], context, undefined, `${path}[${index}]`);
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
        const encoded = encodeRuntime(elemTy, modelValue[index], context, undefined, `${path}[${index}]`);
        if (!encoded.ok) return encoded;
        output.push(encoded.value);
      }
      return { ok: true, value: output };
    }
    case "optional":
      return modelValue === undefined || modelValue === null
        ? { ok: true, value: undefined }
        : encodeRuntime(ty.inner, modelValue, context, tsType, path);
    case "set": {
      const values = modelValue instanceof Set ? [...modelValue] : Array.isArray(modelValue) ? modelValue : null;
      if (!values) return failure(path, "formal set has an invalid model value", modelValue);
      const output = new Set<unknown>();
      for (let index = 0; index < values.length; index++) {
        const encoded = encodeRuntime(ty.elem, values[index], context, undefined, `${path}{${index}}`);
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
        const key = encodeRuntime(ty.key, entry[0], context, undefined, `${path}.key${index}`);
        if (!key.ok) return key;
        const value = encodeRuntime(ty.value, entry[1], context, undefined, `${path}.value${index}`);
        if (!value.ok) return value;
        encodedEntries.push([key.value, value.value]);
      }
      if (tsType?.trim().startsWith("Map<")) return { ok: true, value: new Map(encodedEntries) };
      return { ok: true, value: Object.fromEntries(encodedEntries.map(([key, value]) => [String(key), value])) };
    }
    case "user":
      return encodeUser(ty.name, modelValue, context, path);
    case "void":
      return failure(path, "void cannot be used as an input", modelValue);
    case "fn":
      return failure(path, "function values have no Crosscheck representation", modelValue);
    case "unknown":
      return failure(path, "unknown LemmaScript type", modelValue);
  }
}

function encodeUser(name: string, value: unknown, context: BridgeContext, path: string): RuntimeEncodingResult {
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
        ? encodeRuntime(declaration.aliasOfTy, value, context, declaration.aliasOf, path)
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
        const encoded = encodeRuntime(
          field.type,
          fieldValue,
          context,
          field.tsType,
          `${path}.${field.name}`,
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
        return encodeRuntime(field.type, value, context, field.tsType, path);
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
        const encoded = encodeRuntime(
          field.type,
          fieldValue,
          context,
          field.tsType,
          `${path}.${field.name}`,
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
