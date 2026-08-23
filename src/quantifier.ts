import type { TExpr, Ty } from "./ir.js";

export const QUANTIFIER_LIMIT = 10_000;

export interface QuantifierBound {
  expression: TExpr;
  inclusive: boolean;
}

export interface BoundedIntegerQuantifier {
  kind: "forall" | "exists";
  variable: string;
  natural: boolean;
  body: TExpr;
  lowerBounds: QuantifierBound[];
  upperBounds: QuantifierBound[];
}

export type QuantifierPlan =
  | { ok: true; value: BoundedIntegerQuantifier }
  | { ok: false; reason: string };

/**
 * Recover a finite integer range from a typed quantifier without choosing an
 * evaluation domain. Exact checking evaluates the returned expressions as
 * bigint; runtime checking evaluates them as JavaScript numbers.
 */
export function planBoundedIntegerQuantifier(expr: TExpr): QuantifierPlan {
  if (expr.kind !== "forall" && expr.kind !== "exists") {
    return { ok: false, reason: `expression ${expr.kind} is not a quantifier` };
  }

  const kind = expr.kind;
  const variable = String(expr.var);
  const variableType = expr.varTy as Ty | undefined;
  const natural = variableType?.kind === "nat";
  if (variableType && variableType.kind !== "nat" && variableType.kind !== "int") {
    return { ok: false, reason: `${kind} variable '${variable}' is not an integer or natural` };
  }

  const body = expr.body as TExpr;
  const rangeExpression = kind === "forall"
    ? body.kind === "binop" && body.op === "==>"
      ? body.left as TExpr
      : null
    : body;
  if (!rangeExpression) {
    return { ok: false, reason: `forall variable '${variable}' has no bounding antecedent` };
  }

  const lowerBounds: QuantifierBound[] = [];
  const upperBounds: QuantifierBound[] = [];
  let dependentLower = false;
  let dependentUpper = false;

  for (const constraint of conjunctions(rangeExpression)) {
    if (constraint.kind !== "binop") continue;
    const sourceOp = String(constraint.op);
    if (!["<", "<=", ">", ">="].includes(sourceOp)) continue;

    const left = constraint.left as TExpr;
    const right = constraint.right as TExpr;
    const leftVariable = isVariable(left, variable);
    const rightVariable = isVariable(right, variable);
    if (!leftVariable && !rightVariable) continue;

    const op = leftVariable ? sourceOp : reverseComparison(sourceOp);
    const boundExpression = leftVariable ? right : left;
    const lower = op === ">" || op === ">=";
    if (mentionsFreeVariable(boundExpression, variable)) {
      if (lower) dependentLower = true;
      else dependentUpper = true;
      continue;
    }

    const bound = { expression: boundExpression, inclusive: op === ">=" || op === "<=" };
    if (lower) lowerBounds.push(bound);
    else upperBounds.push(bound);
  }

  if (upperBounds.length === 0) {
    return {
      ok: false,
      reason: dependentUpper
        ? `upper bound for '${variable}' depends on '${variable}'`
        : `no upper bound found for '${variable}'`,
    };
  }
  if (!natural && lowerBounds.length === 0) {
    return {
      ok: false,
      reason: dependentLower
        ? `lower bound for '${variable}' depends on '${variable}'`
        : `no lower bound found for '${variable}'`,
    };
  }

  return {
    ok: true,
    value: { kind, variable, natural, body, lowerBounds, upperBounds },
  };
}

function conjunctions(expr: TExpr): TExpr[] {
  return expr.kind === "binop" && expr.op === "&&"
    ? [...conjunctions(expr.left as TExpr), ...conjunctions(expr.right as TExpr)]
    : [expr];
}

function isVariable(expr: TExpr, name: string): boolean {
  return expr.kind === "var" && expr.name === name;
}

function reverseComparison(op: string): string {
  if (op === "<") return ">";
  if (op === "<=") return ">=";
  if (op === ">") return "<";
  return "<=";
}

function mentionsFreeVariable(expr: TExpr, name: string): boolean {
  if (expr.kind === "var") return expr.name === name;
  if ((expr.kind === "forall" || expr.kind === "exists") && expr.var === name) return false;
  if (expr.kind === "someMatch" && expr.binder === name) {
    return mentionsValue(expr.scrutinee, name) || mentionsValue(expr.noneBody, name);
  }
  if (expr.kind === "lambda") {
    const params = Array.isArray(expr.params) ? expr.params as { name?: unknown }[] : [];
    if (params.some(param => param.name === name)) return false;
  }
  return Object.entries(expr).some(([key, value]) =>
    key !== "ty" && key !== "varTy" && mentionsValue(value, name));
}

function mentionsValue(value: unknown, name: string): boolean {
  if (Array.isArray(value)) return value.some(entry => mentionsValue(entry, name));
  if (!value || typeof value !== "object") return false;
  if (typeof (value as { kind?: unknown }).kind === "string") {
    return mentionsFreeVariable(value as TExpr, name);
  }
  return Object.values(value as Record<string, unknown>).some(entry => mentionsValue(entry, name));
}
