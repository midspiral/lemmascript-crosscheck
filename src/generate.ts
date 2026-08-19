import { stableKey } from "./codec.js";
import type { Ty, TypeDeclInfo, TypedFunction, TypedInfo } from "./ir.js";
import { Rational } from "./rational.js";

export const MAX_SAFE_INTEGER = 9_007_199_254_740_991n;

interface GenerationContext {
  declarations: ReadonlyMap<string, TypeDeclInfo>;
  active: ReadonlySet<string>;
}

class Rng {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0 || 0x9e3779b9;
  }

  next(): number {
    let value = this.state;
    value ^= value << 13;
    value ^= value >>> 17;
    value ^= value << 5;
    this.state = value >>> 0;
    return this.state / 0x1_0000_0000;
  }

  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  pick<T>(values: readonly T[]): T {
    const value = values[this.int(0, values.length - 1)];
    if (value === undefined) throw new Error("cannot choose from an empty list");
    return value;
  }
}

export function candidateCases(fn: TypedFunction, info: TypedInfo, randomCount: number, seed: number): unknown[][] {
  if (fn.params.length === 0) return [[]];
  const context: GenerationContext = {
    declarations: new Map(info.typeDecls.map(declaration => [declaration.name, declaration])),
    active: new Set(),
  };
  const perParam = fn.params.map(parameter => edgeValues(parameter.ty, context));
  const baseline = fn.params.map((parameter, index) => {
    const values = perParam[index];
    return values && values.length > 0 ? values[0] : baselineValue(parameter.ty, context);
  });
  const cases: unknown[][] = [baseline];

  for (let param = 0; param < fn.params.length; param++) {
    for (const value of perParam[param] ?? []) {
      const args = [...baseline];
      args[param] = value;
      cases.push(args);
    }
  }

  if (fn.params.length >= 2) {
    for (let leftIndex = 0; leftIndex < fn.params.length; leftIndex++) {
      for (let rightIndex = leftIndex + 1; rightIndex < fn.params.length; rightIndex++) {
        const left = (perParam[leftIndex] ?? []).slice(0, 12);
        const right = (perParam[rightIndex] ?? []).slice(0, 12);
        for (const leftValue of left) {
          for (const rightValue of right) {
            const args = [...baseline];
            args[leftIndex] = leftValue;
            args[rightIndex] = rightValue;
            cases.push(args);
          }
        }
      }
    }
  }

  const rng = new Rng(seed);
  for (let index = 0; index < Math.max(randomCount * 4, 40); index++) {
    cases.push(fn.params.map(parameter => randomValue(parameter.ty, context, rng, 0)));
  }
  return unique(cases);
}

export function edgeValues(ty: Ty, context: GenerationContext): unknown[] {
  switch (ty.kind) {
    case "bool": return [false, true];
    case "int": {
      const values = integerEdges(false);
      return ty.big ? values : values;
    }
    case "nat": return integerEdges(true);
    case "real":
      return [
        new Rational(0n), new Rational(1n), new Rational(-1n),
        new Rational(1n, 2n), new Rational(3n, 2n),
        new Rational(1n, 10n), new Rational(-1n, 10n), new Rational(1n, 3n),
      ];
    case "string": return ty.values?.length ? [...ty.values] : ["", "a", "0", "é", "😀"];
    case "array": return arrayEdges(ty.elem, context);
    case "tuple": {
      const baseline = ty.elems.map(elem => baselineValue(elem, context));
      const values: unknown[] = [baseline];
      for (let index = 0; index < ty.elems.length; index++) {
        for (const edge of edgeValues(ty.elems[index]!, context).slice(1, 5)) {
          const tuple = [...baseline];
          tuple[index] = edge;
          values.push(tuple);
        }
      }
      return values;
    }
    case "optional": return [undefined, ...edgeValues(ty.inner, context).slice(0, 6)];
    case "set": return [new Set(), ...edgeValues(ty.elem, context).slice(0, 5).map(value => new Set([value]))];
    case "map": {
      const keys = edgeValues(ty.key, context).slice(0, 4);
      const values = edgeValues(ty.value, context).slice(0, 4);
      return [new Map(), ...keys.map((key, index) => new Map([[key, values[index % Math.max(values.length, 1)]]]))];
    }
    case "user": return userEdges(ty.name, context);
    case "void": case "fn": case "unknown": return [];
  }
}

function integerEdges(natural: boolean): bigint[] {
  const positive = [
    0n, 1n, 2n, 3n, 7n, 10n,
    2_147_483_647n, 2_147_483_648n,
    MAX_SAFE_INTEGER - 1n, MAX_SAFE_INTEGER, MAX_SAFE_INTEGER + 1n, MAX_SAFE_INTEGER + 2n,
  ];
  if (natural) return positive;
  return [0n, 1n, -1n, 2n, -2n, 3n, -3n, 7n, -7n, 10n, -10n,
    2_147_483_647n, 2_147_483_648n, -2_147_483_648n,
    MAX_SAFE_INTEGER - 1n, MAX_SAFE_INTEGER, MAX_SAFE_INTEGER + 1n, MAX_SAFE_INTEGER + 2n,
    -MAX_SAFE_INTEGER, -(MAX_SAFE_INTEGER + 2n)];
}

function arrayEdges(elem: Ty, context: GenerationContext): unknown[] {
  const elements = edgeValues(elem, context);
  const arrays: unknown[][] = [[]];
  for (const element of elements.slice(0, 16)) arrays.push([element]);
  for (let index = 0; index + 1 < Math.min(elements.length, 12); index++) {
    arrays.push([elements[index], elements[index + 1]]);
  }
  if (elem.kind === "int" || elem.kind === "nat") {
    arrays.push(
      [MAX_SAFE_INTEGER, 1n],
      [MAX_SAFE_INTEGER, 2n],
      [2n, MAX_SAFE_INTEGER],
      [MAX_SAFE_INTEGER + 2n],
      [0n, 0n],
      [0n, 1n, 2n],
    );
    if (elem.kind === "int") arrays.push([-MAX_SAFE_INTEGER, -2n], [-1n, 0n, 1n]);
  }
  return unique(arrays);
}

function baselineValue(ty: Ty, context: GenerationContext): unknown {
  const edges = edgeValues(ty, context);
  if (edges.length > 0) return edges[0];
  throw new Error(`no generator for ${ty.kind}`);
}

function randomValue(ty: Ty, context: GenerationContext, rng: Rng, depth: number): unknown {
  if (depth > 4) return baselineValue(ty, context);
  switch (ty.kind) {
    case "bool": return rng.next() < 0.5;
    case "int": case "nat": {
      if (rng.next() < 0.3) return rng.pick(integerEdges(ty.kind === "nat"));
      const magnitude = BigInt(rng.int(0, 1_000_000));
      return ty.kind === "nat" || rng.next() < 0.5 ? magnitude : -magnitude;
    }
    case "real": {
      const numerator = BigInt(rng.int(-1_000_000, 1_000_000));
      const denominator = rng.pick([1n, 2n, 4n, 8n, 10n, 16n, 3n]);
      return new Rational(numerator, denominator);
    }
    case "string": {
      if (ty.values?.length) return rng.pick(ty.values);
      const alphabet = ["a", "b", "0", "é", "😀"];
      return Array.from({ length: rng.int(0, 8) }, () => rng.pick(alphabet)).join("");
    }
    case "array": {
      const values = Array.from({ length: rng.int(0, 7) }, () => randomValue(ty.elem, context, rng, depth + 1));
      if (rng.next() < 0.35 && (ty.elem.kind === "int" || ty.elem.kind === "nat" || ty.elem.kind === "real")) {
        values.sort(compareModelNumbers);
      }
      return values;
    }
    case "tuple": return ty.elems.map(elem => randomValue(elem, context, rng, depth + 1));
    case "optional": return rng.next() < 0.25 ? undefined : randomValue(ty.inner, context, rng, depth + 1);
    case "set": {
      const output = new Set<unknown>();
      for (let index = 0; index < rng.int(0, 5); index++) output.add(randomValue(ty.elem, context, rng, depth + 1));
      return output;
    }
    case "map": {
      const output = new Map<unknown, unknown>();
      for (let index = 0; index < rng.int(0, 5); index++) {
        output.set(randomValue(ty.key, context, rng, depth + 1), randomValue(ty.value, context, rng, depth + 1));
      }
      return output;
    }
    case "user": return randomUser(ty.name, context, rng, depth + 1);
    case "void": case "fn": case "unknown": throw new Error(`no generator for ${ty.kind}`);
  }
}

function userEdges(name: string, outer: GenerationContext): unknown[] {
  const declaration = outer.declarations.get(name);
  if (!declaration || outer.active.has(name)) return [];
  const context = { ...outer, active: new Set(outer.active).add(name) };
  switch (declaration.kind) {
    case "string-union": return declaration.values ? [...declaration.values] : [];
    case "alias": return declaration.aliasOfTy ? edgeValues(declaration.aliasOfTy, context) : [];
    case "record": {
      const fields = declaration.fields ?? [];
      const baseline = Object.fromEntries(fields.map(field => [field.name, field.type ? baselineValue(field.type, context) : undefined]));
      const output: unknown[] = [baseline];
      for (const field of fields) {
        if (!field.type) continue;
        for (const edge of edgeValues(field.type, context).slice(1, 5)) output.push({ ...baseline, [field.name]: edge });
      }
      return output;
    }
    case "discriminated-union": {
      if (declaration.discriminant === "__isArray__") {
        return (declaration.variants ?? []).flatMap(variant => {
          const field = variant.fields[0];
          return field?.type ? edgeValues(field.type, context).slice(0, 4) : [];
        });
      }
      return (declaration.variants ?? []).map(variant => Object.fromEntries(variant.fields.map(field => [
        field.name,
        field.name === declaration.discriminant ? variant.name : field.type ? baselineValue(field.type, context) : undefined,
      ])));
    }
    case "opaque": return [];
  }
}

function randomUser(name: string, outer: GenerationContext, rng: Rng, depth: number): unknown {
  const declaration = outer.declarations.get(name);
  if (!declaration || outer.active.has(name)) throw new Error(`cannot generate user type ${name}`);
  const context = { ...outer, active: new Set(outer.active).add(name) };
  switch (declaration.kind) {
    case "string-union": return rng.pick(declaration.values ?? []);
    case "alias":
      if (!declaration.aliasOfTy) throw new Error(`alias ${name} has no target`);
      return randomValue(declaration.aliasOfTy, context, rng, depth);
    case "record": return Object.fromEntries((declaration.fields ?? []).map(field => [
      field.name,
      field.type ? randomValue(field.type, context, rng, depth) : undefined,
    ]));
    case "discriminated-union": {
      const variant = rng.pick(declaration.variants ?? []);
      if (declaration.discriminant === "__isArray__") {
        const field = variant.fields[0];
        if (!field?.type) throw new Error(`variant ${variant.name} has no payload`);
        return randomValue(field.type, context, rng, depth);
      }
      return Object.fromEntries(variant.fields.map(field => [
        field.name,
        field.name === declaration.discriminant ? variant.name : field.type ? randomValue(field.type, context, rng, depth) : undefined,
      ]));
    }
    case "opaque": throw new Error(`cannot generate opaque type ${name}`);
  }
}

function compareModelNumbers(left: unknown, right: unknown): number {
  if (typeof left === "bigint" && typeof right === "bigint") return left < right ? -1 : left > right ? 1 : 0;
  if (left instanceof Rational && right instanceof Rational) return left.compare(right);
  return 0;
}

function unique<T>(values: T[]): T[] {
  const seen = new Set<string>();
  return values.filter(value => {
    const key = stableKey(value);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
