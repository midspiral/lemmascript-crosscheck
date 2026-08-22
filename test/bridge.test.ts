import assert from "node:assert/strict";
import test from "node:test";
import {
  encodeRuntime,
  numericPrecisionVariants,
  optionalPresenceVariants,
  presentUndefinedPath,
  projectRuntime,
  runtimeDomainFailure,
} from "../src/bridge.js";
import { MAX_SAFE_INTEGER } from "../src/generate.js";
import { Rational } from "../src/rational.js";

const context = { declarations: new Map() };

test("number-backed integers cross only when the exact value survives", () => {
  const exact = encodeRuntime({ kind: "int" }, MAX_SAFE_INTEGER + 1n, context);
  assert.equal(exact.ok, true);
  const inexact = encodeRuntime({ kind: "int" }, MAX_SAFE_INTEGER + 2n, context);
  assert.equal(inexact.ok, false);
  if (!inexact.ok) assert.match(inexact.reason, /cannot represent this integer exactly/);
});

test("numeric projection records rather than hides binary64 input rounding", () => {
  const formal = MAX_SAFE_INTEGER + 2n;
  const projected = projectRuntime({ kind: "int" }, formal, context, "number", "target");
  assert.deepEqual(projected, {
    ok: true,
    value: Number(MAX_SAFE_INTEGER + 1n),
    losses: [{ path: "target", formalValue: formal, runtimeValue: Number(MAX_SAFE_INTEGER + 1n) }],
  });
  assert.equal(encodeRuntime({ kind: "int" }, formal, context).ok, false);
});

test("precision variants generally pair scalar and nested numeric sites", () => {
  const variants = numericPrecisionVariants([
    { name: "arr", ty: { kind: "array", elem: { kind: "int" } } },
    { name: "target", ty: { kind: "int" } },
  ], [[0n], 0n], context);
  assert(variants.some(variant => {
    const arr = variant.args[0];
    return Array.isArray(arr)
      && arr[0] === MAX_SAFE_INTEGER + 1n
      && variant.args[1] === MAX_SAFE_INTEGER + 2n;
  }));
});

test("bigint-backed integers stay exact", () => {
  const value = 2n ** 100n;
  const encoded = encodeRuntime({ kind: "int", big: true }, value, context);
  assert.deepEqual(encoded, { ok: true, value });
});

test("dyadic reals encode exactly while one tenth does not", () => {
  assert.deepEqual(encodeRuntime({ kind: "real" }, new Rational(3n, 2n), context), { ok: true, value: 1.5 });
  assert.equal(encodeRuntime({ kind: "real" }, new Rational(1n, 10n), context).ok, false);
});

test("fractional TypeScript numbers expose a verified integer-domain gap", () => {
  assert.equal(runtimeDomainFailure({ kind: "int" }, 2, context, "number", "target"), null);
  assert.deepEqual(runtimeDomainFailure({ kind: "int" }, 0.5, context, "number", "target"), {
    path: "target",
    reason: "fractional TypeScript number is outside the verified int domain",
    runtimeValue: 0.5,
  });
});

test("optional record absence has an omitted canonical encoding and a present-undefined variant", () => {
  const configTy = { kind: "user", name: "Config" } as const;
  const configContext = {
    declarations: new Map([["Config", {
      name: "Config",
      kind: "record" as const,
      fields: [{ name: "retries", tsType: "number | undefined", type: { kind: "optional" as const, inner: { kind: "int" as const } } }],
    }]]),
  };
  const model = { retries: undefined };
  const canonical = encodeRuntime(configTy, model, configContext);
  assert.equal(canonical.ok, true);
  if (!canonical.ok) return;
  assert.equal(Object.prototype.hasOwnProperty.call(canonical.value, "retries"), false);
  const variants = optionalPresenceVariants([configTy], [model], [canonical.value], configContext);
  assert.equal(variants.length, 1);
  assert.equal(Object.prototype.hasOwnProperty.call(variants[0]!.args[0], "retries"), true);
  assert.equal(presentUndefinedPath(configTy, variants[0]!.args[0], configContext), "result.retries");
});
