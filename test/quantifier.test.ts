import assert from "node:assert/strict";
import test from "node:test";
import type { TExpr, Ty, TypedFunction, TypedParam } from "../src/ir.js";
import {
  RuntimeSpecUnsupported,
  satisfiesRuntimePreconditions,
} from "../src/runtime-spec.js";
import { satisfiesPreconditions, SpecUnsupported } from "../src/spec.js";

const boolTy = { kind: "bool" } as const satisfies Ty;
const intTy = { kind: "int" } as const satisfies Ty;
const natTy = { kind: "nat" } as const satisfies Ty;

const variable = (name: string, ty: Ty = intTy): TExpr => ({ kind: "var", name, ty });
const integer = (value: number): TExpr => ({ kind: "num", value, ty: intTy });
const boolean = (value: boolean): TExpr => ({ kind: "bool", value, ty: boolTy });
const binary = (op: string, left: TExpr, right: TExpr): TExpr => ({ kind: "binop", op, left, right, ty: boolTy });
const forall = (name: string, ty: Ty, range: TExpr, predicate: TExpr): TExpr => ({
  kind: "forall",
  var: name,
  varTy: ty,
  body: binary("==>", range, predicate),
  ty: boolTy,
});

function target(requires: TExpr, params: TypedParam[] = []): TypedFunction {
  return {
    name: "quantified",
    exported: true,
    typeParams: [],
    params,
    returnTy: boolTy,
    requires: [requires],
    ensures: [],
    decreases: null,
    contract: [],
    isPure: true,
    forcePure: false,
    autohavoc: false,
    bodyKinds: ["return"],
  };
}

const noCall = async (): Promise<never> => { throw new Error("unexpected predicate call"); };

test("exact and runtime preconditions evaluate bounded forall over arrays", async () => {
  const arr = variable("arr", { kind: "array", elem: intTy });
  const k = variable("k", natTy);
  const length: TExpr = { kind: "field", obj: arr, field: "length", ty: natTy };
  const entry: TExpr = { kind: "index", obj: arr, idx: k, ty: intTy };
  const fn = target(
    forall("k", natTy, binary("<", k, length), binary(">=", entry, integer(0))),
    [{ name: "arr", ty: { kind: "array", elem: intTy }, tsType: "number[]" }],
  );

  assert.equal(await satisfiesPreconditions(fn, [[0n, 2n]], [], noCall), true);
  assert.equal(await satisfiesPreconditions(fn, [[0n, -1n]], [], noCall), false);
  assert.equal(await satisfiesRuntimePreconditions(fn, [[0, 2]], [], noCall), true);
  assert.equal(await satisfiesRuntimePreconditions(fn, [[0, -1]], [], noCall), false);
});

test("negative integer witnesses are enumerated instead of mistaken for success", async () => {
  const i = variable("i", intTy);
  const negativeOne: TExpr = { kind: "unop", op: "-", expr: integer(1), ty: intTy };
  const range = binary("&&", binary("<=", negativeOne, i), binary("<", i, integer(0)));
  const fn = target(forall("i", intTy, range, boolean(false)));

  assert.equal(await satisfiesPreconditions(fn, [], [], noCall), false);
  assert.equal(await satisfiesRuntimePreconditions(fn, [], [], noCall), false);
});

test("reversed, inclusive, and empty bounds preserve forall semantics", async () => {
  const i = variable("i", intTy);
  const reversedRange = binary("&&", binary(">", integer(2), i), binary(">=", i, integer(0)));
  const reversed = target(forall("i", intTy, reversedRange, binary("<=", i, integer(1))));
  const emptyRange = binary("&&", binary("<=", integer(0), i), binary("<", i, integer(0)));
  const empty = target(forall("i", intTy, emptyRange, boolean(false)));

  assert.equal(await satisfiesPreconditions(reversed, [], [], noCall), true);
  assert.equal(await satisfiesRuntimePreconditions(reversed, [], [], noCall), true);
  assert.equal(await satisfiesPreconditions(empty, [], [], noCall), true);
  assert.equal(await satisfiesRuntimePreconditions(empty, [], [], noCall), true);
});

test("self-dependent forall bounds fail closed in both evaluators", async () => {
  const i = variable("i", natTy);
  const dependentUpper = binary("<", i, {
    kind: "binop",
    op: "+",
    left: i,
    right: integer(1),
    ty: intTy,
  });
  const fn = target(forall("i", natTy, dependentUpper, boolean(true)));

  await assert.rejects(
    satisfiesPreconditions(fn, [], [], noCall),
    (error: unknown) => error instanceof SpecUnsupported && /upper bound.*depends/.test(error.reason),
  );
  await assert.rejects(
    satisfiesRuntimePreconditions(fn, [], [], noCall),
    (error: unknown) => error instanceof RuntimeSpecUnsupported && /upper bound.*depends/.test(error.reason),
  );
});

test("both evaluators reject quantified ranges above the shared work limit", async () => {
  const i = variable("i", natTy);
  const fn = target(forall("i", natTy, binary("<", i, integer(10_001)), boolean(true)));

  await assert.rejects(
    satisfiesPreconditions(fn, [], [], noCall),
    (error: unknown) => error instanceof SpecUnsupported && /10000-value work limit/.test(error.reason),
  );
  await assert.rejects(
    satisfiesRuntimePreconditions(fn, [], [], noCall),
    (error: unknown) => error instanceof RuntimeSpecUnsupported && /10000-value work limit/.test(error.reason),
  );
});
