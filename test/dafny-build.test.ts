import assert from "node:assert/strict";
import test from "node:test";
import { dafnyBuildCacheKey } from "../src/dafny-build.js";

test("the Dafny patch version participates in the build-cache key", () => {
  const first = dafnyBuildCacheKey("method M() {}", "/deps/bignumber.js", "4.11.0");
  const repeated = dafnyBuildCacheKey("method M() {}", "/deps/bignumber.js", "4.11.0");
  const upgraded = dafnyBuildCacheKey("method M() {}", "/deps/bignumber.js", "4.11.1");
  assert.equal(first, repeated);
  assert.notEqual(first, upgraded);
});
