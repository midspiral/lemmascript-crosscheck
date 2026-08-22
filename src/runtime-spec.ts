import type { TExpr, Ty, TypeDeclInfo, TypedConst, TypedFunction } from "./ir.js";

const QUANTIFIER_LIMIT = 10_000;

export class RuntimeSpecUnsupported extends Error {
  constructor(readonly reason: string) {
    super(`runtime contract is outside the supported expression fragment: ${reason}`);
    this.name = "RuntimeSpecUnsupported";
  }
}

export interface RuntimeSpecContext {
  env: ReadonlyMap<string, unknown>;
  constants: ReadonlyMap<string, TypedConst>;
  declarations: ReadonlyMap<string, TypeDeclInfo>;
  callRuntime(name: string, args: unknown[]): Promise<unknown>;
}

export type RuntimePostconditionResult =
  | { status: "ok" }
  | { status: "failed"; clause: number };

export async function satisfiesRuntimePreconditions(
  fn: TypedFunction,
  args: unknown[],
  constants: readonly TypedConst[],
  callRuntime: RuntimeSpecContext["callRuntime"],
  declarations: readonly TypeDeclInfo[] = [],
): Promise<boolean> {
  const context = runtimeContext(fn, args, constants, callRuntime, declarations);
  for (const clause of fn.requires) {
    if (await evaluateRuntimeSpec(clause, context) !== true) return false;
  }
  return true;
}

export async function checkRuntimePostconditions(
  fn: TypedFunction,
  args: unknown[],
  result: unknown,
  constants: readonly TypedConst[],
  callRuntime: RuntimeSpecContext["callRuntime"],
  declarations: readonly TypeDeclInfo[] = [],
): Promise<RuntimePostconditionResult> {
  const base = runtimeContext(fn, args, constants, callRuntime, declarations);
  const context = withBinding(base, "\\result", result);
  for (let index = 0; index < fn.ensures.length; index++) {
    if (await evaluateRuntimeSpec(fn.ensures[index]!, context) !== true) {
      return { status: "failed", clause: index + 1 };
    }
  }
  return { status: "ok" };
}

function runtimeContext(
  fn: TypedFunction,
  args: unknown[],
  constants: readonly TypedConst[],
  callRuntime: RuntimeSpecContext["callRuntime"],
  declarations: readonly TypeDeclInfo[],
): RuntimeSpecContext {
  return {
    env: new Map(fn.params.map((param, index) => [param.name, args[index]])),
    constants: new Map(constants.map(constant => [constant.name, constant])),
    declarations: new Map(declarations.map(declaration => [declaration.name, declaration])),
    callRuntime,
  };
}

export async function evaluateRuntimeSpec(expr: TExpr, context: RuntimeSpecContext): Promise<unknown> {
  switch (expr.kind) {
    case "var": {
      const name = String(expr.name);
      if (context.env.has(name)) return context.env.get(name);
      if (name === "undefined") return undefined;
      if (name === "null") return null;
      if (name === "Math") return Math;
      if (name === "Number") return Number;
      const constant = context.constants.get(name);
      if (constant) return await evaluateRuntimeSpec(constant.value, context);
      throw new RuntimeSpecUnsupported(`unbound variable ${name}`);
    }
    case "num": return Number(expr.value);
    case "bigint": return BigInt(String(expr.value));
    case "str": return String(expr.value);
    case "bool": return Boolean(expr.value);
    case "unop": {
      const value = await evaluateRuntimeSpec(expr.expr as TExpr, context);
      if (expr.op === "!") return !value;
      if (expr.op === "-") return jsNegate(value);
      if (expr.op === "+") return jsPositive(value);
      throw new RuntimeSpecUnsupported(`unary operator ${String(expr.op)}`);
    }
    case "binop": return await evaluateRuntimeBinary(expr, context);
    case "conditional":
      return await evaluateRuntimeSpec(
        await evaluateRuntimeSpec(expr.cond as TExpr, context)
          ? expr.then as TExpr
          : expr.else as TExpr,
        context,
      );
    case "nullish": {
      const left = await evaluateRuntimeSpec(expr.left as TExpr, context);
      return left === undefined || left === null
        ? await evaluateRuntimeSpec(expr.right as TExpr, context)
        : left;
    }
    case "field": {
      const object = await evaluateRuntimeSpec(expr.obj as TExpr, context);
      return runtimeField(object, String(expr.field));
    }
    case "index": {
      const object = await evaluateRuntimeSpec(expr.obj as TExpr, context);
      const index = await evaluateRuntimeSpec(expr.idx as TExpr, context);
      return runtimeIndex(object, index);
    }
    case "call": return await evaluateRuntimeCall(expr, context);
    case "arrayLiteral":
      return await Promise.all((expr.elems as TExpr[]).map(entry => evaluateRuntimeSpec(entry, context)));
    case "record": {
      const spread = expr.spread ? await evaluateRuntimeSpec(expr.spread as TExpr, context) : {};
      if (!spread || typeof spread !== "object") throw new RuntimeSpecUnsupported("record spread is not an object");
      const output = { ...spread } as Record<string, unknown>;
      for (const field of expr.fields as { name: string; value: TExpr }[]) {
        output[field.name] = await evaluateRuntimeSpec(field.value, context);
      }
      return output;
    }
    case "someMatch": {
      const value = await evaluateRuntimeSpec(expr.scrutinee as TExpr, context);
      if (value === undefined || value === null) return await evaluateRuntimeSpec(expr.noneBody as TExpr, context);
      return await evaluateRuntimeSpec(expr.someBody as TExpr, withBinding(context, String(expr.binder), value));
    }
    case "tagMatch": return await evaluateRuntimeTagMatch(expr, context);
    case "optChain": {
      let value = await evaluateRuntimeSpec(expr.obj as TExpr, context);
      for (const step of expr.chain as ({ kind: string } & Record<string, unknown>)[]) {
        if (value === undefined || value === null) return undefined;
        if (step.kind === "field") value = runtimeField(value, String(step.name));
        else if (step.kind === "index") value = runtimeIndex(value, await evaluateRuntimeSpec(step.idx as TExpr, context));
        else throw new RuntimeSpecUnsupported(`optional-chain step ${step.kind}`);
      }
      return value;
    }
    case "forall": case "exists": return await evaluateRuntimeQuantifier(expr, context);
    case "havoc": throw new RuntimeSpecUnsupported("havoc expression");
    default: throw new RuntimeSpecUnsupported(`expression ${expr.kind}`);
  }
}

async function evaluateRuntimeBinary(expr: TExpr, context: RuntimeSpecContext): Promise<unknown> {
  const op = String(expr.op);
  if (op === "&&") return Boolean(await evaluateRuntimeSpec(expr.left as TExpr, context))
    && Boolean(await evaluateRuntimeSpec(expr.right as TExpr, context));
  if (op === "||") return Boolean(await evaluateRuntimeSpec(expr.left as TExpr, context))
    || Boolean(await evaluateRuntimeSpec(expr.right as TExpr, context));
  if (op === "==>") return !Boolean(await evaluateRuntimeSpec(expr.left as TExpr, context))
    || Boolean(await evaluateRuntimeSpec(expr.right as TExpr, context));
  if (op === "<==>") return Boolean(await evaluateRuntimeSpec(expr.left as TExpr, context))
    === Boolean(await evaluateRuntimeSpec(expr.right as TExpr, context));

  const left = await evaluateRuntimeSpec(expr.left as TExpr, context);
  const right = await evaluateRuntimeSpec(expr.right as TExpr, context);
  switch (op) {
    case "===": return left === right;
    case "!==": return left !== right;
    case "==": return jsLooseEqual(left, right);
    case "!=": return !jsLooseEqual(left, right);
    case "<": return jsCompare(left, right, "<");
    case "<=": return jsCompare(left, right, "<=");
    case ">": return jsCompare(left, right, ">");
    case ">=": return jsCompare(left, right, ">=");
    case "+": return jsArithmetic(left, right, "+");
    case "-": return jsArithmetic(left, right, "-");
    case "*": return jsArithmetic(left, right, "*");
    case "/": return jsArithmetic(left, right, "/");
    case "%": return jsArithmetic(left, right, "%");
    case "in": return runtimeContains(right, left);
    default: throw new RuntimeSpecUnsupported(`binary operator ${op}`);
  }
}

async function evaluateRuntimeCall(expr: TExpr, context: RuntimeSpecContext): Promise<unknown> {
  const fn = expr.fn as TExpr;
  const args = await Promise.all((expr.args as TExpr[]).map(arg => evaluateRuntimeSpec(arg, context)));
  if (fn.kind === "var") return await context.callRuntime(String(fn.name), args);
  if (fn.kind !== "field") throw new RuntimeSpecUnsupported(`call target ${fn.kind}`);
  const receiver = await evaluateRuntimeSpec(fn.obj as TExpr, context);
  const name = String(fn.field);
  if (name === "includes" && (Array.isArray(receiver) || typeof receiver === "string")) {
    return receiver.includes(args[0] as never);
  }
  if (name === "indexOf" && (Array.isArray(receiver) || typeof receiver === "string")) {
    return receiver.indexOf(args[0] as never);
  }
  if (name === "has" && (receiver instanceof Set || receiver instanceof Map)) return receiver.has(args[0]);
  if (name === "toNat") {
    if (typeof receiver !== "number" && typeof receiver !== "bigint") {
      throw new RuntimeSpecUnsupported("toNat receiver is not numeric");
    }
    return receiver < 0 ? (typeof receiver === "bigint" ? 0n : 0) : receiver;
  }
  if (receiver === Math && typeof (Math as unknown as Record<string, unknown>)[name] === "function") {
    return ((Math as unknown as Record<string, (...values: unknown[]) => unknown>)[name]!)(...args);
  }
  throw new RuntimeSpecUnsupported(`method call ${name}`);
}

async function evaluateRuntimeTagMatch(expr: TExpr, context: RuntimeSpecContext): Promise<unknown> {
  const value = await evaluateRuntimeSpec(expr.scrutinee as TExpr, context);
  const typeName = String(expr.typeName);
  const declaration = context.declarations.get(typeName);
  if (!declaration?.discriminant) throw new RuntimeSpecUnsupported(`tag match type ${typeName} has no discriminant metadata`);
  const selected = declaration.discriminant === "__isArray__"
    ? Array.isArray(value) ? "ArrayBranch" : "NonArrayBranch"
    : value && typeof value === "object"
      ? (value as Record<string, unknown>)[declaration.discriminant]
      : undefined;
  for (const branch of expr.cases as { variant: string; body: TExpr }[]) {
    if (branch.variant === selected) return await evaluateRuntimeSpec(branch.body, context);
  }
  if (expr.fallthrough) return await evaluateRuntimeSpec(expr.fallthrough as TExpr, context);
  throw new RuntimeSpecUnsupported("tag match has no matching branch");
}

async function evaluateRuntimeQuantifier(expr: TExpr, context: RuntimeSpecContext): Promise<boolean> {
  const variable = String(expr.var);
  const body = expr.body as TExpr;
  const boundsExpr = quantifierBoundsExpression(expr.kind, body);
  if (!boundsExpr) throw new RuntimeSpecUnsupported("forall quantifier is not guarded by a finite-range implication");
  const bounds = await finiteIntegerBounds(variable, expr.varTy as Ty | undefined, boundsExpr, context);
  if (!bounds) throw new RuntimeSpecUnsupported(`${expr.kind} quantifier has no finite integer bounds`);
  const count = bounds.max - bounds.min + 1;
  if (!Number.isSafeInteger(count) || count < 0 || count > QUANTIFIER_LIMIT) {
    throw new RuntimeSpecUnsupported(`${expr.kind} quantifier exceeds the ${QUANTIFIER_LIMIT}-value work limit`);
  }
  for (let value = bounds.min; value <= bounds.max; value++) {
    const truth = Boolean(await evaluateRuntimeSpec(body, withBinding(context, variable, value)));
    if (expr.kind === "forall" && !truth) return false;
    if (expr.kind === "exists" && truth) return true;
  }
  return expr.kind === "forall";
}

function quantifierBoundsExpression(kind: string, body: TExpr): TExpr | null {
  if (kind === "forall" && body.kind === "binop" && body.op === "==>") return body.left as TExpr;
  return kind === "exists" ? body : null;
}

async function finiteIntegerBounds(
  variable: string,
  varTy: Ty | undefined,
  expr: TExpr,
  context: RuntimeSpecContext,
): Promise<{ min: number; max: number } | null> {
  let min = varTy?.kind === "nat" ? 0 : Number.NEGATIVE_INFINITY;
  let max = Number.POSITIVE_INFINITY;
  for (const constraint of conjunctions(expr)) {
    if (constraint.kind !== "binop" || !["<", "<=", ">", ">="].includes(String(constraint.op))) continue;
    const left = constraint.left as TExpr;
    const right = constraint.right as TExpr;
    const leftVar = left.kind === "var" && left.name === variable;
    const rightVar = right.kind === "var" && right.name === variable;
    if (leftVar === rightVar) continue;
    const boundExpr = leftVar ? right : left;
    const bound = await evaluateRuntimeSpec(boundExpr, context);
    if (typeof bound !== "number" || !Number.isFinite(bound) || !Number.isInteger(bound)) continue;
    const op = leftVar ? String(constraint.op) : reverseComparison(String(constraint.op));
    if (op === ">") min = Math.max(min, bound + 1);
    else if (op === ">=") min = Math.max(min, bound);
    else if (op === "<") max = Math.min(max, bound - 1);
    else if (op === "<=") max = Math.min(max, bound);
  }
  if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max)) return null;
  return max < min ? { min: 0, max: -1 } : { min, max };
}

function conjunctions(expr: TExpr): TExpr[] {
  return expr.kind === "binop" && expr.op === "&&"
    ? [...conjunctions(expr.left as TExpr), ...conjunctions(expr.right as TExpr)]
    : [expr];
}

function reverseComparison(op: string): string {
  if (op === "<") return ">";
  if (op === "<=") return ">=";
  if (op === ">") return "<";
  return "<=";
}

function runtimeField(value: unknown, field: string): unknown {
  if (value === undefined || value === null) throw new RuntimeSpecUnsupported(`field ${field} of nullish value`);
  return (value as Record<string, unknown>)[field];
}

function runtimeIndex(value: unknown, index: unknown): unknown {
  if (value === undefined || value === null) throw new RuntimeSpecUnsupported("index of nullish value");
  return (value as Record<PropertyKey, unknown>)[index as PropertyKey];
}

function runtimeContains(container: unknown, value: unknown): boolean {
  if (Array.isArray(container) || typeof container === "string") return container.includes(value as never);
  if (container instanceof Set || container instanceof Map) return container.has(value);
  if (container && typeof container === "object") return String(value) in container;
  throw new RuntimeSpecUnsupported("membership in unsupported runtime value");
}

function withBinding(context: RuntimeSpecContext, name: string, value: unknown): RuntimeSpecContext {
  const env = new Map(context.env);
  env.set(name, value);
  return { ...context, env };
}

function jsNegate(value: unknown): unknown {
  try { return -(value as any); }
  catch (error) { throw runtimeOperatorError("unary -", error); }
}

function jsPositive(value: unknown): unknown {
  try { return +(value as any); }
  catch (error) { throw runtimeOperatorError("unary +", error); }
}

function jsArithmetic(left: unknown, right: unknown, op: string): unknown {
  try {
    const a = left as any;
    const b = right as any;
    if (op === "+") return a + b;
    if (op === "-") return a - b;
    if (op === "*") return a * b;
    if (op === "/") return a / b;
    return a % b;
  } catch (error) {
    throw runtimeOperatorError(op, error);
  }
}

function jsCompare(left: unknown, right: unknown, op: string): boolean {
  try {
    const a = left as any;
    const b = right as any;
    if (op === "<") return a < b;
    if (op === "<=") return a <= b;
    if (op === ">") return a > b;
    return a >= b;
  } catch (error) {
    throw runtimeOperatorError(op, error);
  }
}

function jsLooseEqual(left: unknown, right: unknown): boolean {
  // Deliberately reproduce the source operator for runtime contract testing.
  return (left as any) == (right as any);
}

function runtimeOperatorError(op: string, error: unknown): RuntimeSpecUnsupported {
  return new RuntimeSpecUnsupported(`${op} failed: ${error instanceof Error ? error.message : String(error)}`);
}
