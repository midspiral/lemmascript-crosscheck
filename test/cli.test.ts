import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { AuditReport } from "../src/report-types.js";

test("help exposes selectable runtime contract checks", () => {
  const cliPath = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
  const result = spawnSync(process.execPath, ["--import", "tsx", cliPath, "--help"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /--checks <list>\s+contract, differential, or both/);
});

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

test("legacy replay cases fail as structured JSON instead of an unhandled rejection", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "lemmascript-crosscheck-cli-cases-"));
  const id = "0123456789";
  await writeFile(path.join(root, `${id}.json`), JSON.stringify({
    schema: "lemmascript-crosscheck.case/v1",
    id,
  }));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });

  const cliPath = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
  const result = spawnSync(process.execPath, [
    "--import", "tsx", cliPath, "--replay", id, "--json",
  ], {
    encoding: "utf8",
    env: { ...process.env, LEMMASCRIPT_CROSSCHECK_CACHE: root },
  });

  assert.equal(result.status, 2, result.stderr);
  const report = JSON.parse(result.stdout) as AuditReport;
  assert.equal(report.schema, "lemmascript-crosscheck.report/v1");
  assert.equal(report.targets[0]?.conclusion, "not-checked");
  assert.match(report.targets[0]?.reason ?? "", /invalid or unsupported replay case/);
});
