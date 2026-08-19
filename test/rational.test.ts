import assert from "node:assert/strict";
import test from "node:test";
import { Rational } from "../src/rational.js";

test("binary64 decomposition is exact", () => {
  assert.equal(Rational.fromDouble(0.1).toString(), "3602879701896397/36028797018963968");
  assert.equal(Rational.fromDouble(1.5).toString(), "3/2");
});

test("decimal rationals preserve mathematical literals", () => {
  assert.equal(Rational.parseDecimal("0.1").toString(), "1/10");
  assert.equal(Rational.parseDecimal("1.25e-2").toString(), "1/80");
});

test("rational arithmetic stays normalized", () => {
  assert.equal(new Rational(1n, 10n).add(new Rational(2n, 10n)).toString(), "3/10");
  assert.equal(new Rational(3n, 2n).multiply(new Rational(2n, 3n)).toString(), "1");
});
