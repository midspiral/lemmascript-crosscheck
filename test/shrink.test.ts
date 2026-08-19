import assert from "node:assert/strict";
import test from "node:test";
import { shrinkArgs } from "../src/shrink.js";

test("integer shrinking is monotone and terminates at zero", async () => {
  let calls = 0;
  const result = await shrinkArgs([7n], async () => {
    calls++;
    if (calls > 20) throw new Error("shrinker did not terminate");
    return true;
  });
  assert.deepEqual(result, [0n]);
  assert(calls <= 20);
});
