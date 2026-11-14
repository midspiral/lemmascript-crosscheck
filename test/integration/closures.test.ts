import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { decode } from "../../src/codec.js";
import { runtimePackageRoot } from "../../src/dafny-build.js";
import { renderReport } from "../../src/report.js";
import type { AuditReport } from "../../src/report-types.js";

// Run through npm run test:integration with Dafny and LemmaScript installed.
// Copy sources so lsc's generated artifacts never modify the checked-in fixtures.
test("mutable closure counterexamples are detected, reported, and replayed", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "crosscheck-closures-"));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  const source = path.join(root, "closures.ts");
  await copyFile(new URL("../fixtures/closures.ts", import.meta.url), source);
  const env = {
    ...process.env,
    LEMMASCRIPT_CROSSCHECK_CACHE: path.join(root, "cases"),
    LEMMASCRIPT_CROSSCHECK_BUILD_CACHE: path.join(root, "build"),
  };
  const cli = path.join(runtimePackageRoot(), "dist/src/cli.js");
  const run = (args: string[], expectedExit: number): AuditReport => {
    const result = spawnSync(process.execPath, [cli, ...args, "--json"], {
      cwd: runtimePackageRoot(), env, encoding: "utf8", timeout: 90_000,
    });
    assert.ifError(result.error);
    assert.equal(result.status, expectedExit, result.stdout + result.stderr);
    return JSON.parse(result.stdout) as AuditReport;
  };

  const report = run([source, "--cases", "1"], 1);
  assert.equal(report.targets.length, 4);
  for (const [name, model, runtime] of [
    ["late", "2", 6],
    ["stale", "1", 2],
    ["viaAlias", "0", 1],
  ] as const) {
    const target = report.targets.find(candidate => candidate.target === name);
    assert.ok(target, name);
    assert.equal(target.conclusion, "issue");
    assert.equal(target.cases, 1);
    assert.equal(target.issue?.category, "result-mismatch");
    assert.equal(target.issue?.modelResult, model);
    assert.equal(decode(target.issue!.runtimeResult!), runtime);

    const replay = run(["--replay", target.issue!.id], 1);
    assert.equal(replay.targets.length, 1);
    assert.equal(replay.targets[0]?.conclusion, "issue");
    assert.deepEqual(replay.targets[0]?.issue, target.issue);
  }
  assert.equal(report.targets.find(target => target.target === "constantCapture")?.conclusion, "no-issue");
  const rendered = renderReport(report, { details: true });
  assert.match(rendered, /JavaScript returned a different result from the verified model/);
  assert.doesNotMatch(rendered, /precision|floating.point|bigint|round/i);

  const contract = run([source, "--only", "late", "--checks", "contract,differential"], 1);
  assert.equal(contract.targets[0]?.issue?.category, "runtime-postcondition-violation");
  assert.equal(contract.targets[0]?.issue?.postconditionClause, 1);
  assert.equal(decode(contract.targets[0]!.issue!.runtimeResult!), 6);

  // This void helper call currently produces invalid Dafny. It must remain
  // visibly NOT CHECKED rather than turning missing coverage into success.
  const viaCall = path.join(root, "closure-via-call.ts");
  await copyFile(new URL("../fixtures/closure-via-call.ts", import.meta.url), viaCall);
  const unsupported = run([viaCall, "--only", "viaCall"], 2);
  assert.equal(unsupported.targets[0]?.conclusion, "not-checked");
  assert.equal(unsupported.targets[0]?.cases, 0);
  assert.match(unsupported.targets[0]?.reason ?? "", /method returns 0 value/);
});
