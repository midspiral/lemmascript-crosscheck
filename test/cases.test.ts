import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { issueId, loadCase, resolveReplayRuntime, saveCase, type IssueIdentity, type StoredCase } from "../src/cases.js";
import { encode } from "../src/codec.js";

const baseIdentity: IssueIdentity = {
  sourceSha256: "1".repeat(64),
  runtimeSha256: "2".repeat(64),
  target: "check",
  runtimeTarget: "check",
  category: "result-mismatch",
  args: encode([0n]),
};

test("issue IDs include source and runtime identity", () => {
  const base = issueId(baseIdentity);
  assert.notEqual(issueId({ ...baseIdentity, sourceSha256: "3".repeat(64) }), base);
  assert.notEqual(issueId({ ...baseIdentity, runtimeSha256: "4".repeat(64) }), base);
  assert.notEqual(issueId({ ...baseIdentity, runtimeTarget: "deployedCheck" }), base);
});

test("replay restores alternate runtimes and follows relocated source runtimes", () => {
  const stored: StoredCase = {
    schema: "lemmascript-crosscheck.case/v2",
    id: "0123456789",
    source: "/old/source.ts",
    sourceSha256: baseIdentity.sourceSha256,
    runtime: "/old/runtime.js",
    runtimeSha256: baseIdentity.runtimeSha256,
    target: baseIdentity.target,
    runtimeTarget: baseIdentity.runtimeTarget,
    category: baseIdentity.category,
    args: baseIdentity.args,
  };
  assert.equal(resolveReplayRuntime(stored, "/new/source.ts", undefined), "/old/runtime.js");
  assert.equal(resolveReplayRuntime(stored, "/new/source.ts", "/new/runtime.js"), "/new/runtime.js");
  assert.equal(
    resolveReplayRuntime({ ...stored, runtime: stored.source }, "/new/source.ts", undefined),
    "/new/source.ts",
  );
});

test("v2 replay cases persist runtime identity and reject v1 cases", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "lemmascript-crosscheck-cases-"));
  const previous = process.env.LEMMASCRIPT_CROSSCHECK_CACHE;
  process.env.LEMMASCRIPT_CROSSCHECK_CACHE = root;
  t.after(async () => {
    if (previous === undefined) delete process.env.LEMMASCRIPT_CROSSCHECK_CACHE;
    else process.env.LEMMASCRIPT_CROSSCHECK_CACHE = previous;
    await rm(root, { recursive: true, force: true });
  });

  const id = issueId(baseIdentity);
  const stored: StoredCase = {
    schema: "lemmascript-crosscheck.case/v2",
    id,
    source: "/tmp/source.ts",
    sourceSha256: baseIdentity.sourceSha256,
    runtime: "/tmp/runtime.js",
    runtimeSha256: baseIdentity.runtimeSha256,
    target: baseIdentity.target,
    runtimeTarget: baseIdentity.runtimeTarget,
    category: baseIdentity.category,
    args: baseIdentity.args,
  };
  await saveCase(stored);
  assert.deepEqual(await loadCase(id), stored);

  const projectedFormal = [[9_007_199_254_740_992n], 9_007_199_254_740_993n];
  const projectedRuntime = [[9_007_199_254_740_992], 9_007_199_254_740_992];
  const projectedArgs = encode(projectedFormal);
  const projectedRuntimeArgs = encode(projectedRuntime);
  const projectedId = issueId({
    ...baseIdentity,
    category: "input-representation-mismatch",
    args: encode([projectedFormal, projectedRuntime]),
  });
  const projected: StoredCase = {
    ...stored,
    id: projectedId,
    category: "input-representation-mismatch",
    args: projectedArgs,
    runtimeArgs: projectedRuntimeArgs,
  };
  await saveCase(projected);
  assert.deepEqual(await loadCase(projectedId), projected);

  const oldId = "0123456789";
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, `${oldId}.json`), JSON.stringify({ ...stored, schema: "lemmascript-crosscheck.case/v1", id: oldId }));
  await assert.rejects(loadCase(oldId), /invalid or unsupported replay case/);
});
