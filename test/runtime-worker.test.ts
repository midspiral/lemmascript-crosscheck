import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { encode } from "../src/codec.js";
import { JsonLineClient } from "../src/json-line-client.js";
import { runtimePackageRoot } from "../src/dafny-build.js";

test("runtime import output cannot corrupt the JSON-lines protocol", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "lemmascript-crosscheck-runtime-"));
  const modulePath = path.join(root, "runtime.mjs");
  await writeFile(modulePath, `
    console.log("module import log");
    process.stdout.write("module import write\\n");
    export function echo(value) {
      console.info("call log", value);
      process.stdout.write("call write\\n");
      return value;
    }
  `);

  const workerPath = fileURLToPath(new URL("../src/runtime-worker.ts", import.meta.url));
  const client = new JsonLineClient(process.execPath, ["--import", "tsx", workerPath], runtimePackageRoot());
  t.after(async () => {
    client.close();
    await rm(root, { recursive: true, force: true });
  });

  const setup = await client.request({ type: "setup", modulePath }, 5_000);
  assert.equal(setup.status, "ok");
  const response = await client.request({ type: "call", target: "echo", args: encode([7]) }, 5_000);

  assert.equal(response.status, "ok");
  assert.deepEqual(response.result, encode(7));
  assert.deepEqual(response.console, ["call log 7", "call write"]);

  const missing = await client.request({ type: "call", target: "missing", args: encode([]) }, 5_000);
  assert.equal(missing.status, "error");
  assert.equal(missing.kind, "missing-export");
});
