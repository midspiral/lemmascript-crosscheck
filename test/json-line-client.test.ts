import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { RestartableJsonLineClient, WorkerTimeoutError } from "../src/json-line-client.js";

test("a timed-out worker is restarted before the next request", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "lemmascript-crosscheck-worker-"));
  const workerPath = path.join(root, "worker.mjs");
  await writeFile(workerPath, `
    import { createInterface } from "node:readline";
    const input = createInterface({ input: process.stdin });
    const send = message => process.stdout.write(JSON.stringify(message) + "\\n");
    input.on("line", line => {
      const message = JSON.parse(line);
      if (message.type === "setup") send({ id: message.id, status: "ok" });
      else if (message.hang) { while (true) {} }
      else send({ id: message.id, status: "ok", pid: process.pid });
    });
  `);

  const client = new RestartableJsonLineClient({
    command: process.execPath,
    args: [workerPath],
    cwd: root,
    setup: { type: "setup" },
    setupTimeoutMs: 2_000,
    label: "test",
  });
  t.after(async () => {
    client.close();
    await rm(root, { recursive: true, force: true });
  });
  await client.start();

  const before = await client.request({ type: "call" }, 2_000);
  await assert.rejects(
    client.request({ type: "call", hang: true }, 200),
    error => error instanceof WorkerTimeoutError,
  );
  const after = await client.request({ type: "call" }, 2_000);

  assert.equal(after.status, "ok");
  assert.notEqual(after.pid, before.pid);
});
