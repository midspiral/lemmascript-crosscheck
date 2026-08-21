import { compareCodePoints } from "./codec.js";
import type { TExpr, Ty, TypeDeclInfo, TypedConst, TypedFunction } from "./ir.js";
import { Rational, asRational } from "./rational.js";

export class SpecUnsupported extends Error {
  constructor(readonly reason: string) {
    super(`precondition is outside the supported expression fragment: ${reason}`);
    this.name = "SpecUnsupported";
  }
}

export interface SpecContext {
  env: ReadonlyMap<string, unknown>;
  constants: ReadonlyMap<string, TypedConst>;
  declarations: ReadonlyMap<string, TypeDeclInfo>;
  callModel(name: string, args: unknown[]): Promise<unknown>;
}

export async function satisfiesPreconditions(
  fn: TypedFunction,
  args: unknown[],
  constants: readonly TypedConst[],
  callModel: SpecContext["callModel"],
  declarations: readonly TypeDeclInfo[] = [],
): Promise<boolean> {
  const env = new Map(fn.params.map((param, index) => [param.name, args[index]]));
  const context: SpecContext = {
    env,
    constants: new Map(constants.map(constant => [constant.name, constant])),
    declarations: new Map(declarations.map(declaration => [declaration.name, declaration])),
    callModel,
  };
  for (const clause of fn.requires) {
    if (await evaluateSpec(clause, context) !== true) return false;
  }
  return true;
}

export async function evaluateSpec(expr: TExpr, context: SpecContext): Promise<unknown> {
  switch (expr.kind) {
    case "var": {
      const name = String(expr.name);
      if (context.env.has(name)) return context.env.get(name);
      if (name === "undefined" || name === "null") return undefined;
      const constant = context.constants.get(name);
      if (constant) return await evaluateSpec(constant.value, context);
      throw new SpecUnsupported(`unbound variable ${name}`);
    }
    case "num": return numericLiteral(Number(expr.value), expr.ty);
    case "bigint": return BigInt(String(expr.value));
    case "str": return String(expr.value);
    case "bool": return Boolean(expr.value);
    case "unop": {
      const value = await evaluateSpec(expr.expr as TExpr, context);
      if (expr.op === "!") return value !== true;
      if (expr.op === "-") return typeof value === "bigint" ? -value : asRational(value).negate();
      if (expr.op === "+") return value;
      throw new SpecUnsupported(`unary operator ${String(expr.op)}`);
    }
    case "binop": return await evaluateBinary(expr, context);
    case "conditional":
      return await evaluateSpec(
        (await evaluateSpec(expr.cond as TExpr, context)) === true ? expr.then as TExpr : expr.else as TExpr,
        context,
      );
    case "nullish": {
      const left = await evaluateSpec(expr.left as TExpr, context);
      return left === undefined || left === null ? await evaluateSpec(expr.right as TExpr, context) : left;
    }
    case "field": {
      const object = await evaluateSpec(expr.obj as TExpr, context);
      return readField(object, String(expr.field));
    }
    case "index": {
      const object = await evaluateSpec(expr.obj as TExpr, context);
      const index = await evaluateSpec(expr.idx as TExpr, context);
      return readIndex(object, index);
    }
    case "call": return await evaluateCall(expr, context);
    case "arrayLiteral":
      return await Promise.all((expr.elems as TExpr[]).map(entry => evaluateSpec(entry, context)));
    case "record": {
      const spread = expr.spread ? await evaluateSpec(expr.spread as TExpr, context) : {};
      if (!spread || typeof spread !== "object") throw new SpecUnsupported("record spread is not an object");
      const output = { ...spread } as Record<string, unknown>;
      for (const field of expr.fields as { name: string; value: TExpr }[]) output[field.name] = await evaluateSpec(field.value, context);
      return output;
    }
    case "someMatch": {
      const value = await evaluateSpec(expr.scrutinee as TExpr, context);
      if (value === undefined || value === null) return await evaluateSpec(expr.noneBody as TExpr, context);
      return await evaluateSpec(expr.someBody as TExpr, withBinding(context, String(expr.binder), value));
    }
    case "tagMatch": {
      const value = await evaluateSpec(expr.scrutinee as TExpr, context);
      const typeName = String(expr.typeName);
      const declaration = context.declarations.get(typeName);
      if (!declaration?.discriminant) throw new SpecUnsupported(`tag match type ${typeName} has no discriminant metadata`);
      let selectedVariant: unknown;
      if (declaration.discriminant === "__isArray__") {
        selectedVariant = Array.isArray(value) ? "ArrayBranch" : "NonArrayBranch";
      } else {
        if (!value || typeof value !== "object") throw new SpecUnsupported("tag match value is not a record");
        selectedVariant = (value as Record<string, unknown>)[declaration.discriminant];
      }
      const selectedName = selectedVariant === undefined
        ? undefined
        : typeof selectedVariant === "string" ? selectedVariant : String(selectedVariant);
      for (const branch of expr.cases as { variant: string; body: TExpr }[]) {
        if (selectedName === branch.variant) return await evaluateSpec(branch.body, context);
      }
      if (expr.fallthrough) return await evaluateSpec(expr.fallthrough as TExpr, context);
      throw new SpecUnsupported("tag match has no matching branch");
    }
    case "optChain": {
      let value = await evaluateSpec(expr.obj as TExpr, context);
      for (const step of expr.chain as ({ kind: string } & Record<string, unknown>)[]) {
        if (value === undefined || value === null) return undefined;
        if (step.kind === "field") value = readField(value, String(step.name));
        else if (step.kind === "index") value = readIndex(value, await evaluateSpec(step.idx as TExpr, context));
        else throw new SpecUnsupported(`optional-chain step ${step.kind}`);
      }
      return value;
    }
    case "forall": case "exists":
      throw new SpecUnsupported(`${expr.kind} quantifier`);
    case "havoc": throw new SpecUnsupported("havoc expression");
    default: throw new SpecUnsupported(`expression ${expr.kind}`);
  }
}

async function evaluateBinary(expr: TExpr, context: SpecContext): Promise<unknown> {
  const op = String(expr.op);
  if (op === "&&") return (await evaluateSpec(expr.left as TExpr, context)) === true
    ? (await evaluateSpec(expr.right as TExpr, context)) === true : false;
  if (op === "||") return (await evaluateSpec(expr.left as TExpr, context)) === true
    ? true : (await evaluateSpec(expr.right as TExpr, context)) === true;
  if (op === "==>") return (await evaluateSpec(expr.left as TExpr, context)) === true
    ? (await evaluateSpec(expr.right as TExpr, context)) === true : true;
  if (op === "<==>") return ((await evaluateSpec(expr.left as TExpr, context)) === true)
    === ((await evaluateSpec(expr.right as TExpr, context)) === true);

  const left = await evaluateSpec(expr.left as TExpr, context);
  const right = await evaluateSpec(expr.right as TExpr, context);
  if (["===", "=="].includes(op)) return modelEqual(left, right);
  if (["!==", "!="].includes(op)) return !modelEqual(left, right);
  if (op === "in") return contains(right, left);
  if (["<", "<=", ">", ">="].includes(op)) {
    const comparison = compare(left, right);
    return op === "<" ? comparison < 0 : op === "<=" ? comparison <= 0 : op === ">" ? comparison > 0 : comparison >= 0;
  }
  if (op === "+" && (typeof left === "string" || typeof right === "string")) return String(left) + String(right);
  if (["+", "-", "*", "/", "%"].includes(op)) return numericBinary(op, left, right, expr.ty);
  throw new SpecUnsupported(`binary operator ${op}`);
}

function numericBinary(op: string, left: unknown, right: unknown, resultTy: Ty | undefined): unknown {
  if (resultTy?.kind === "real" || left instanceof Rational || right instanceof Rational || op === "/") {
    const a = asRational(left);
    const b = asRational(right);
    if (op === "+") return a.add(b);
    if (op === "-") return a.subtract(b);
    if (op === "*") return a.multiply(b);
    if (op === "/") return a.divide(b);
    throw new SpecUnsupported("real remainder");
  }
  if (typeof left !== "bigint" || typeof right !== "bigint") throw new SpecUnsupported("non-integer arithmetic");
  if (op === "+") return left + right;
  if (op === "-") return left - right;
  if (op === "*") return left * right;
  if (op === "%") {
    if (right === 0n) throw new SpecUnsupported("remainder by zero");
    return left % right;
  }
  throw new SpecUnsupported(`integer operator ${op}`);
}

async function evaluateCall(expr: TExpr, context: SpecContext): Promise<unknown> {
  const fn = expr.fn as TExpr;
  const args = await Promise.all((expr.args as TExpr[]).map(arg => evaluateSpec(arg, context)));
  if (fn.kind === "var") return await context.callModel(String(fn.name), args);
  if (fn.kind === "field") {
    const receiver = await evaluateSpec(fn.obj as TExpr, context);
    const name = String(fn.field);
    if (name === "includes") return Array.isArray(receiver) && receiver.some(value => modelEqual(value, args[0]));
    if (name === "indexOf") return Array.isArray(receiver)
      ? BigInt(receiver.findIndex(value => modelEqual(value, args[0]))) : -1n;
    if (name === "has") return receiver instanceof Set
      ? [...receiver].some(value => modelEqual(value, args[0]))
      : receiver instanceof Map ? [...receiver.keys()].some(value => modelEqual(value, args[0])) : false;
    if (name === "toNat") {
      if (typeof receiver !== "bigint") throw new SpecUnsupported("toNat receiver is not an integer");
      return receiver < 0n ? 0n : receiver;
    }
    throw new SpecUnsupported(`method call ${name}`);
  }
  throw new SpecUnsupported(`call target ${fn.kind}`);
}

function numericLiteral(value: number, ty: Ty | undefined): unknown {
  if ((ty?.kind === "int" || ty?.kind === "nat") && Number.isInteger(value)) return BigInt(value);
  return Rational.parseDecimal(String(value));
}

function readField(value: unknown, field: string): unknown {
  if (field === "length" && (Array.isArray(value) || typeof value === "string")) return BigInt(value.length);
  if (field === "size" && (value instanceof Set || value instanceof Map)) return BigInt(value.size);
  if (value && typeof value === "object" && field in value) return (value as Record<string, unknown>)[field];
  throw new SpecUnsupported(`field ${field}`);
}

function readIndex(value: unknown, index: unknown): unknown {
  if (typeof index !== "bigint") throw new SpecUnsupported("non-integer index");
  if (index < 0n || index > BigInt(Number.MAX_SAFE_INTEGER)) return undefined;
  const numeric = Number(index);
  if (Array.isArray(value) || typeof value === "string") return value[numeric];
  if (value instanceof Map) return value.get(index);
  if (value && typeof value === "object") return (value as Record<string, unknown>)[String(index)];
  throw new SpecUnsupported("indexed value");
}

function compare(left: unknown, right: unknown): number {
  if ((typeof left === "bigint" || left instanceof Rational) && (typeof right === "bigint" || right instanceof Rational)) {
    return asRational(left).compare(asRational(right));
  }
  if (typeof left === "string" && typeof right === "string") return left < right ? -1 : left > right ? 1 : 0;
  throw new SpecUnsupported("comparison of unsupported values");
}

function contains(container: unknown, value: unknown): boolean {
  if (Array.isArray(container)) return container.some(entry => modelEqual(entry, value));
  if (container instanceof Set) return [...container].some(entry => modelEqual(entry, value));
  if (container instanceof Map) return [...container.keys()].some(entry => modelEqual(entry, value));
  throw new SpecUnsupported("membership in unsupported value");
}

function modelEqual(left: unknown, right: unknown): boolean {
  if ((typeof left === "bigint" || left instanceof Rational) && (typeof right === "bigint" || right instanceof Rational)) {
    return asRational(left).equals(asRational(right));
  }
  if (left === right) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((entry, index) => modelEqual(entry, right[index]));
  }
  if (left instanceof Set && right instanceof Set) {
    return left.size === right.size && [...left].every(entry => [...right].some(candidate => modelEqual(entry, candidate)));
  }
  if (left instanceof Map && right instanceof Map) {
    return left.size === right.size && [...left].every(([key, value]) => [...right].some(([otherKey, otherValue]) => modelEqual(key, otherKey) && modelEqual(value, otherValue)));
  }
  if (left && right && typeof left === "object" && typeof right === "object") {
    const leftEntries = Object.entries(left).sort(([a], [b]) => compareCodePoints(a, b));
    const rightEntries = Object.entries(right).sort(([a], [b]) => compareCodePoints(a, b));
    return leftEntries.length === rightEntries.length
      && leftEntries.every(([key, value], index) => key === rightEntries[index]?.[0] && modelEqual(value, rightEntries[index]?.[1]));
  }
  return false;
}

function withBinding(context: SpecContext, name: string, value: unknown): SpecContext {
  const env = new Map(context.env);
  env.set(name, value);
  return { ...context, env };
}
