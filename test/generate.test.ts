import assert from "node:assert/strict";
import test from "node:test";
import { candidateCases, MAX_SAFE_INTEGER } from "../src/generate.js";
import type { TypedFunction, TypedInfo } from "../src/ir.js";

const baseInfo: TypedInfo = {
  schema: 1,
  lemmascript: "0.6.0",
  file: "fixture.ts",
  backendDirective: "dafny",
  typeDecls: [],
  externs: [],
  constants: [],
  functions: [],
  classes: [],
  dafny: { emittedNames: {} },
};

function fn(params: TypedFunction["params"]): TypedFunction {
  return {
    name: "f", exported: true, typeParams: [], params, returnTy: { kind: "int" },
    requires: [], ensures: [], decreases: null, contract: [], isPure: true,
    forcePure: false, autohavoc: false, bodyKinds: ["return"],
  };
}

test("zero-argument functions produce exactly one case", () => {
  assert.deepEqual(candidateCases(fn([]), baseInfo, 100, 17), [[]]);
});

test("integer arrays include a representable accumulator-overflow witness", () => {
  const cases = candidateCases(fn([{ name: "arr", ty: { kind: "array", elem: { kind: "int" } }, tsType: "number[]" }]), baseInfo, 10, 17);
  assert(cases.some(args => Array.isArray(args[0])
    && args[0].length === 2 && args[0][0] === MAX_SAFE_INTEGER && args[0][1] === 2n));
});

test("pairwise generation includes one divided by ten", () => {
  const cases = candidateCases(fn([
    { name: "a", ty: { kind: "int" }, tsType: "number" },
    { name: "b", ty: { kind: "int" }, tsType: "number" },
  ]), baseInfo, 20, 17);
  assert(cases.some(args => args[0] === 1n && args[1] === 10n));
});

test("undefined is a valid optional baseline", () => {
  const cases = candidateCases(fn([{ name: "value", ty: { kind: "optional", inner: { kind: "int" } }, tsType: "number | undefined" }]), baseInfo, 4, 17);
  assert.equal(cases[0]?.[0], undefined);
});
