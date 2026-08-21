import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { AuditReport } from "../src/report-types.js";

test("fatal JSON output remains a complete v1 target report", () => {
  const cliPath = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
  const missingSource = path.join(tmpdir(), `lemmascript-crosscheck-missing-${process.pid}.ts`);
  const result = spawnSync(process.execPath, [
    "--import", "tsx", cliPath, missingSource,
    "--only", "check", "--entry", "check=runtimeCheck", "--seed", "0", "--json",
  ], { encoding: "utf8" });

  assert.equal(result.status, 2, result.stderr);
  const report = JSON.parse(result.stdout) as AuditReport;
  assert.equal(report.schema, "lemmascript-crosscheck.report/v1");
  assert.deepEqual(report.targets.map(target => ({
    target: target.target,
    runtimeTarget: target.runtimeTarget,
    conclusion: target.conclusion,
    evidence: target.evidence,
    cases: target.cases,
    seed: target.seed,
  })), [{
    target: "check",
    runtimeTarget: "runtimeCheck",
    conclusion: "not-checked",
    evidence: "tool-failure",
    cases: 0,
    seed: 0,
  }]);
});
