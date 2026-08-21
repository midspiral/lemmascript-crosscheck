import assert from "node:assert/strict";
import test from "node:test";
import type { TypedFunction } from "../src/ir.js";
import { satisfiesPreconditions } from "../src/spec.js";

const fn: TypedFunction = {
  name: "divide", exported: true, typeParams: [],
  params: [{ name: "b", ty: { kind: "int" }, tsType: "number" }],
  returnTy: { kind: "real" },
  requires: [{
    kind: "binop", op: "!==",
    left: { kind: "var", name: "b", ty: { kind: "int" } },
    right: { kind: "num", value: 0, ty: { kind: "int" } },
    ty: { kind: "bool" },
  }],
  ensures: [], decreases: null, contract: [], isPure: true, forcePure: false,
  autohavoc: false, bodyKinds: ["return"],
};

test("preconditions use exact integer values", async () => {
  assert.equal(await satisfiesPreconditions(fn, [1n], [], async () => { throw new Error("unexpected call"); }), true);
  assert.equal(await satisfiesPreconditions(fn, [0n], [], async () => { throw new Error("unexpected call"); }), false);
});

test("preconditions can call a compiled model predicate", async () => {
  const called: TypedFunction = {
    ...fn,
    name: "search",
    params: [{ name: "arr", ty: { kind: "array", elem: { kind: "int" } }, tsType: "number[]" }],
    requires: [{
      kind: "call",
      fn: { kind: "var", name: "sorted", ty: { kind: "fn", params: [{ kind: "array", elem: { kind: "int" } }], result: { kind: "bool" } } },
      args: [{ kind: "var", name: "arr", ty: { kind: "array", elem: { kind: "int" } } }],
      ty: { kind: "bool" },
    }],
  };
  const accepted = await satisfiesPreconditions(called, [[3n]], [], async (name, args) => name === "sorted" && (args[0] as bigint[]).length === 1);
  assert.equal(accepted, true);
});

test("tag matches read the declared discriminant field only", async () => {
  const tagged: TypedFunction = {
    ...fn,
    name: "area",
    params: [{ name: "shape", ty: { kind: "user", name: "Shape" }, tsType: "Shape" }],
    requires: [{
      kind: "tagMatch",
      typeName: "Shape",
      scrutinee: { kind: "var", name: "shape", ty: { kind: "user", name: "Shape" } },
      cases: [
        { variant: "square", body: { kind: "bool", value: false } },
        { variant: "circle", body: { kind: "bool", value: true } },
      ],
      fallthrough: { kind: "bool", value: false },
      ty: { kind: "bool" },
    }],
  };
  const declarations = [{
    name: "Shape",
    kind: "discriminated-union" as const,
    discriminant: "kind",
    variants: [
      { name: "circle", fields: [{ name: "label", tsType: "string", type: { kind: "string" as const } }] },
      { name: "square", fields: [{ name: "label", tsType: "string", type: { kind: "string" as const } }] },
    ],
  }];

  const accepted = await satisfiesPreconditions(
    tagged,
    [{ kind: "circle", label: "square" }],
    [],
    async () => { throw new Error("unexpected call"); },
    declarations,
  );
  assert.equal(accepted, true);
});
