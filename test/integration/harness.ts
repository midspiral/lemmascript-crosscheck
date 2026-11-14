import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TestContext } from "node:test";
import { runtimePackageRoot } from "../../src/dafny-build.js";
import type { AuditReport } from "../../src/report-types.js";

// Real toolchain runs use temporary copies so generated artifacts and saved
// counterexamples stay isolated from both the fixtures and the user's caches.
export async function auditFixture(
  t: TestContext,
  fixture: string,
  expectedExit: 0 | 1 | 2,
  args: string[] = [],
): Promise<AuditReport> {
  const root = await mkdtemp(path.join(tmpdir(), "crosscheck-soundness-"));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  const source = path.join(root, fixture);
  await copyFile(new URL(`../fixtures/${fixture}`, import.meta.url), source);
  const env = {
    ...process.env,
    LEMMASCRIPT_CROSSCHECK_CACHE: path.join(root, "cases"),
    LEMMASCRIPT_CROSSCHECK_BUILD_CACHE: path.join(root, "build"),
  };
  const cli = path.join(runtimePackageRoot(), "dist/src/cli.js");
  const run = (options: string[], exit: number): AuditReport => {
    const result = spawnSync(process.execPath, [cli, ...options, "--json"], {
      cwd: runtimePackageRoot(), env, encoding: "utf8", timeout: 90_000,
    });
    assert.ifError(result.error);
    assert.equal(result.status, exit, result.stdout + result.stderr);
    return JSON.parse(result.stdout) as AuditReport;
  };

  const report = run([source, ...args], expectedExit);
  for (const target of report.targets) {
    if (target.conclusion !== "issue") continue;
    assert.ok(target.issue, target.target);
    const replay = run(["--replay", target.issue.id], 1);
    assert.equal(replay.targets.length, 1);
    assert.equal(replay.targets[0]?.target, target.target);
    assert.equal(replay.targets[0]?.conclusion, "issue");
    assert.deepEqual(replay.targets[0]?.issue, target.issue);
  }
  return report;
}
