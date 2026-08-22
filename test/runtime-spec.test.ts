import assert from "node:assert/strict";
import test from "node:test";
import type { TExpr, TypedFunction } from "../src/ir.js";
import { checkRuntimePostconditions, satisfiesRuntimePreconditions } from "../src/runtime-spec.js";

const result = (): TExpr => ({ kind: "var", name: "\\result", ty: { kind: "int" } });
const variable = (name: string): TExpr => ({ kind: "var", name, ty: { kind: "int" } });
const integer = (value: number): TExpr => ({ kind: "num", value, ty: { kind: "int" } });
const binop = (op: string, left: TExpr, right: TExpr): TExpr => ({ kind: "binop", op, left, right, ty: { kind: "bool" } });

const binarySearch: TypedFunction = {
  name: "binarySearch",
  exported: true,
  typeParams: [],
  params: [
    { name: "arr", ty: { kind: "array", elem: { kind: "int" } }, tsType: "number[]" },
    { name: "target", ty: { kind: "int" }, tsType: "number" },
  ],
  returnTy: { kind: "int" },
  requires: [{
    kind: "call",
    fn: { kind: "var", name: "sorted", ty: { kind: "unknown" } },
    args: [{ kind: "var", name: "arr", ty: { kind: "array", elem: { kind: "int" } } }],
    ty: { kind: "bool" },
  }],
  ensures: [
    binop(">=", result(), integer(-1)),
    binop("<", result(), {
      kind: "field",
      obj: { kind: "var", name: "arr", ty: { kind: "array", elem: { kind: "int" } } },
      field: "length",
      ty: { kind: "nat" },
    }),
    binop("==>", binop(">=", result(), integer(0)), binop("===", {
      kind: "index",
      obj: { kind: "var", name: "arr", ty: { kind: "array", elem: { kind: "int" } } },
      idx: result(),
      ty: { kind: "int" },
    }, variable("target"))),
    binop("==>", binop("===", result(), integer(-1)), {
      kind: "forall",
      var: "k",
      varTy: { kind: "int" },
      body: binop("==>", binop("&&", binop("<=", integer(0), variable("k")), binop("<", variable("k"), {
        kind: "field",
        obj: { kind: "var", name: "arr", ty: { kind: "array", elem: { kind: "int" } } },
        field: "length",
        ty: { kind: "nat" },
      })), binop("!==", {
        kind: "index",
        obj: { kind: "var", name: "arr", ty: { kind: "array", elem: { kind: "int" } } },
        idx: variable("k"),
        ty: { kind: "int" },
      }, variable("target"))),
      ty: { kind: "bool" },
    }),
  ],
  decreases: null,
  contract: [],
  isPure: false,
  forcePure: false,
  autohavoc: false,
  bodyKinds: ["while"],
};

const sorted = async (name: string, args: unknown[]): Promise<unknown> => {
  assert.equal(name, "sorted");
  const arr = args[0] as number[];
  return arr.every((value, index) => index === 0 || arr[index - 1]! <= value);
};

test("runtime contracts use JavaScript values and bounded quantifiers", async () => {
  assert.equal(await satisfiesRuntimePreconditions(binarySearch, [[0.5], 0.5], [], sorted), true);
  assert.deepEqual(await checkRuntimePostconditions(binarySearch, [[0.5], 0.5], 0, [], sorted), { status: "ok" });
  assert.deepEqual(await checkRuntimePostconditions(binarySearch, [[0.5], 0.5], -1, [], sorted), {
    status: "failed",
    clause: 4,
  });
});

test("runtime contracts preserve ordinary floating-point equality semantics", async () => {
  const rounded = 0.1 + 0.2;
  assert.notEqual(rounded, 0.3);
  assert.deepEqual(await checkRuntimePostconditions(binarySearch, [[rounded], 0.3], -1, [], sorted), { status: "ok" });
});
