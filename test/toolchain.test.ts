import assert from "node:assert/strict";
import test from "node:test";
import { compatibleDafnyVersion } from "../src/toolchain.js";

test("Dafny 4.11 patch releases are supported", () => {
  assert.equal(compatibleDafnyVersion("4.11.0"), true);
  assert.equal(compatibleDafnyVersion(" 4.11.3\n"), true);
  assert.equal(compatibleDafnyVersion("4.11.0+build.1"), true);
});

test("other Dafny release lines are rejected", () => {
  assert.equal(compatibleDafnyVersion("4.10.0"), false);
  assert.equal(compatibleDafnyVersion("4.12.0"), false);
  assert.equal(compatibleDafnyVersion("5.11.0"), false);
  assert.equal(compatibleDafnyVersion("Dafny 4.11.0"), false);
  assert.equal(compatibleDafnyVersion("unknown"), false);
});
