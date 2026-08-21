import assert from "node:assert/strict";
import test from "node:test";
import { encode } from "../src/codec.js";

test("object encoding does not depend on localeCompare", () => {
  const original = String.prototype.localeCompare;
  let encoded;
  try {
    String.prototype.localeCompare = () => { throw new Error("localeCompare must not be used"); };
    encoded = encode({ b: 2, a: 1 });
  } finally {
    String.prototype.localeCompare = original;
  }
  assert.deepEqual(encoded, {
    $: "object",
    entries: [["a", 1], ["b", 2]],
  });
});
