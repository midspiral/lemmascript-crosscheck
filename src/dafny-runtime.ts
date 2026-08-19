/* Dynamic access to the stable shape emitted by Dafny's JavaScript backend. */

import type { FieldInfo, Ty, TypeDeclInfo } from "./ir.js";
import { Rational } from "./rational.js";

export class MarshalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MarshalError";
  }
}

export interface DafnyRuntimeModule {
  _dafny: any;
  _module: any;
  BigNumber: any;
}

export interface MarshalTables {
  typeDecls: TypeDeclInfo[];
  nameMap: Record<string, string>;
}

export function dafnyToJsName(name: string): string {
  return name.replace(/_/g, "__").replace(/'/g, "_k").replace(/\?/g, "_q");
}

export class DafnyRuntime {
  private readonly declarations: ReadonlyMap<string, TypeDeclInfo>;

  constructor(private readonly runtime: DafnyRuntimeModule, private readonly tables: MarshalTables) {
    this.declarations = new Map(tables.typeDecls.map(declaration => [declaration.name, declaration]));
  }

  invoke(sourceName: string, paramTys: Ty[], args: unknown[]): unknown {
    const emittedName = this.nameOf(sourceName);
    const fn = this.runtime._module.__default?.[dafnyToJsName(emittedName)];
    if (typeof fn !== "function") throw new MarshalError(`compiled model has no callable ${sourceName}`);
    const values = args.map((arg, index) => {
      const ty = paramTys[index];
      if (!ty) throw new MarshalError(`missing formal type for argument ${index}`);
      return this.toDafny(ty, arg);
    });
    return fn(...values);
  }

  compareWithRuntime(ty: Ty, modelResult: unknown, runtimeResult: unknown): { equal: boolean; runtimeExact: string } {
    const runtimeValue = this.toDafny(ty, runtimeResult);
    return {
      equal: this.runtime._dafny.areEqual(modelResult, runtimeValue),
      runtimeExact: this.display(runtimeValue),
    };
  }

  display(value: unknown): string {
    try { return this.runtime._dafny.toString(value); }
    catch { return String(value); }
  }

  fromDafny(ty: Ty, value: any): unknown {
    switch (ty.kind) {
      case "bool": return Boolean(value);
      case "int": case "nat":
        if (!value || typeof value.toFixed !== "function") throw new MarshalError(`model ${ty.kind} has an unknown runtime shape`);
        return BigInt(value.toFixed());
      case "real":
        if (!value?.num || !value?.den) throw new MarshalError("model real has an unknown runtime shape");
        return new Rational(BigInt(value.num.toFixed()), BigInt(value.den.toFixed()));
      case "string":
        if (typeof value === "string") return value;
        if (!Array.isArray(value)) throw new MarshalError("model string has an unknown runtime shape");
        return value.map((codepoint: { value?: number }) => String.fromCodePoint(codepoint.value ?? 0)).join("");
      case "array":
        if (!Array.isArray(value)) throw new MarshalError("model sequence has an unknown runtime shape");
        return [...value].map(entry => this.fromDafny(ty.elem, entry));
      case "tuple":
        if (!Array.isArray(value) || value.length !== ty.elems.length) throw new MarshalError("model tuple has an unknown runtime shape");
        return [...value].map((entry, index) => this.fromDafny(ty.elems[index]!, entry));
      case "set":
        if (!Array.isArray(value)) throw new MarshalError("model set has an unknown runtime shape");
        return new Set([...value].map(entry => this.fromDafny(ty.elem, entry)));
      case "map":
        if (!Array.isArray(value)) throw new MarshalError("model map has an unknown runtime shape");
        return new Map([...value].map(([key, entry]) => [this.fromDafny(ty.key, key), this.fromDafny(ty.value, entry)]));
      case "optional":
      case "user":
        throw new MarshalError(`${ty.kind} model result decoding is not implemented`);
      case "void": return undefined;
      case "fn": case "unknown": throw new MarshalError(`${ty.kind} model result`);
    }
  }

  toDafny(ty: Ty, value: unknown): any {
    const { _dafny, BigNumber } = this.runtime;
    switch (ty.kind) {
      case "bool":
        if (typeof value !== "boolean") throw new MarshalError(`expected boolean, got ${typeof value}`);
        return value;
      case "int": case "nat": {
        if (typeof value === "bigint") return new BigNumber(value.toString());
        if (typeof value === "number" && Number.isFinite(value) && Number.isInteger(value)) return new BigNumber(value.toString());
        throw new MarshalError(`expected integer, got ${String(value)}`);
      }
      case "real": {
        const rational = value instanceof Rational
          ? value
          : typeof value === "bigint"
            ? new Rational(value)
            : typeof value === "number" && Number.isFinite(value)
              ? Rational.fromDouble(value)
              : null;
        if (!rational) throw new MarshalError(`expected finite exact real, got ${String(value)}`);
        return new _dafny.BigRational(
          new BigNumber(rational.numerator.toString()),
          new BigNumber(rational.denominator.toString()),
        );
      }
      case "string": {
        if (typeof value !== "string") throw new MarshalError(`expected string, got ${typeof value}`);
        for (let index = 0; index < value.length; index++) {
          const unit = value.charCodeAt(index);
          if (unit >= 0xd800 && unit <= 0xdfff) {
            const point = value.codePointAt(index);
            if (point === undefined || point <= 0xffff) throw new MarshalError("string contains a lone UTF-16 surrogate");
            index++;
          }
        }
        return _dafny.Seq.UnicodeFromString(value);
      }
      case "array": {
        if (!Array.isArray(value)) throw new MarshalError(`expected array, got ${typeof value}`);
        return _dafny.Seq.of(...value.map(entry => this.toDafny(ty.elem, entry)));
      }
      case "tuple": {
        if (!Array.isArray(value) || value.length !== ty.elems.length) throw new MarshalError(`expected ${ty.elems.length}-tuple`);
        return _dafny.Tuple.of(...value.map((entry, index) => this.toDafny(ty.elems[index]!, entry)));
      }
      case "set": {
        const values = value instanceof Set ? [...value] : Array.isArray(value) ? value : null;
        if (!values) throw new MarshalError("expected Set");
        return _dafny.Set.fromElements(...values.map(entry => this.toDafny(ty.elem, entry)));
      }
      case "map": {
        const entries = value instanceof Map
          ? [...value.entries()]
          : value && typeof value === "object" && !Array.isArray(value)
            ? Object.entries(value)
            : null;
        if (!entries) throw new MarshalError("expected Map or record");
        const output = new _dafny.Map();
        for (const [key, entry] of entries) {
          output.updateUnsafe(this.toDafny(ty.key, this.coerceObjectKey(ty.key, key)), this.toDafny(ty.value, entry));
        }
        return output;
      }
      case "optional": {
        const option = this.moduleType("Option");
        return value === undefined || value === null
          ? this.construct(option, "None", [])
          : this.construct(option, "Some", [this.toDafny(ty.inner, value)]);
      }
      case "user": return this.userToDafny(ty.name, value);
      case "void": case "fn": case "unknown": throw new MarshalError(`cannot marshal ${ty.kind}`);
    }
  }

  private userToDafny(name: string, value: unknown): any {
    const declaration = this.declarations.get(name);
    if (!declaration) throw new MarshalError(`missing declaration for ${name}`);
    if (declaration.typeParams?.length) throw new MarshalError(`generic user type ${name}`);
    switch (declaration.kind) {
      case "alias":
        if (!declaration.aliasOfTy) throw new MarshalError(`alias ${name} has no target`);
        return this.toDafny(declaration.aliasOfTy, value);
      case "opaque": throw new MarshalError(`opaque user type ${name}`);
      case "string-union": {
        if (typeof value !== "string" || !declaration.values?.includes(value)) throw new MarshalError(`invalid ${name} value`);
        return this.construct(this.moduleType(name), value, []);
      }
      case "record": {
        if (!value || typeof value !== "object") throw new MarshalError(`expected ${name} record`);
        const args = (declaration.fields ?? []).map(field => this.toDafny(this.fieldTy(name, field), (value as Record<string, unknown>)[field.name]));
        return this.construct(this.moduleType(name), name, args);
      }
      case "discriminated-union": {
        if (declaration.discriminant === "__isArray__") {
          const variant = declaration.variants?.find(candidate => candidate.name === (Array.isArray(value) ? "ArrayBranch" : "NonArrayBranch"));
          const field = variant?.fields[0];
          if (!variant || !field) throw new MarshalError(`incomplete synthetic union ${name}`);
          return this.construct(this.moduleType(name), variant.name, [this.toDafny(this.fieldTy(name, field), value)]);
        }
        if (!value || typeof value !== "object" || !declaration.discriminant) throw new MarshalError(`expected ${name} tagged record`);
        const tag = (value as Record<string, unknown>)[declaration.discriminant];
        const variant = declaration.variants?.find(candidate => candidate.name === tag);
        if (!variant) throw new MarshalError(`unknown ${name} variant ${String(tag)}`);
        const args = variant.fields
          .filter(field => field.name !== declaration.discriminant)
          .map(field => this.toDafny(this.fieldTy(name, field), (value as Record<string, unknown>)[field.name]));
        return this.construct(this.moduleType(name), variant.name, args);
      }
    }
  }

  private fieldTy(owner: string, field: FieldInfo): Ty {
    if (!field.type) throw new MarshalError(`unresolved field ${owner}.${field.name}`);
    return field.type;
  }

  private coerceObjectKey(ty: Ty, key: unknown): unknown {
    if (typeof key === "string" && (ty.kind === "int" || ty.kind === "nat") && /^-?\d+$/.test(key)) return BigInt(key);
    return key;
  }

  private nameOf(sourceName: string): string {
    return this.tables.nameMap[sourceName] ?? sourceName;
  }

  private moduleType(sourceName: string): any {
    const emitted = this.nameOf(sourceName);
    const type = this.runtime._module[dafnyToJsName(emitted)];
    if (!type) throw new MarshalError(`compiled model has no type ${sourceName}`);
    return type;
  }

  private construct(type: any, sourceConstructor: string, args: unknown[]): any {
    const emitted = this.nameOf(sourceConstructor);
    const create = type[`create_${dafnyToJsName(emitted)}`];
    if (typeof create !== "function") throw new MarshalError(`compiled model has no constructor ${sourceConstructor}`);
    return create.apply(type, args);
  }
}
