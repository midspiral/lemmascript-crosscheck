import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { latexTable, readManifest, readStudies, snapshot, statistics, suiteExitCode, summary, totals, validateReport, type FileResult } from "../scripts/case-studies.js";
import type { AuditReport } from "../src/report-types.js";

test("corpus selects each primary Dafny study once, excluding branch variants and Lean jobs", () => {
  const ci = `jobs:
  unrelated:
    repo: owner/ignored-lemmascript
  case-studies-dafny:
    strategy:
      matrix:
        include:
          # - repo: owner/commented-lemmascript
          - repo: owner/green-lemmascript
            branch: main
          - repo: owner/green-lemmascript
            branch: guard
            guard: true
          - repo: owner/brown-lemmascript
            branch: lemmascript
          - repo: owner/outside-paper
            branch: main
    steps:
      - run: ignored
  case-studies-lean:
    strategy:
      matrix:
        include:
          - repo: owner/lean-lemmascript
            branch: main
`;
  assert.deepEqual(readStudies(ci), [
    { name: "green-lemmascript", repo: "owner/green-lemmascript", branch: "main" },
    { name: "brown-lemmascript", repo: "owner/brown-lemmascript", branch: "lemmascript" },
  ]);
  assert.throws(() => readStudies(ci.replace("branch: guard", "branch: main")), /Duplicate/);
  assert.throws(() => readStudies(ci.replace("branch: main", "unexpected: main")), /Unsupported/);
  assert.throws(() => readStudies(ci.replace("branch: lemmascript", "branch: unknown")), /Missing primary/);
  assert.throws(() => readStudies("jobs:\n  unrelated:\n"), /Missing/);
});

test("manifest preserves slow time limits, CRLF and flag-only entries; rejects unsafe or duplicate paths", () => {
  assert.deepEqual(readManifest("a.ts\r\n\nb.ts 500 --isolate-assertions\nc.ts --cores 1\n"), [
    { file: "a.ts", line: 1, flags: [] },
    { file: "b.ts", line: 3, timeLimit: 500, flags: ["--isolate-assertions"] },
    { file: "c.ts", line: 4, flags: ["--cores", "1"] },
  ]);
  for (const text of ["../outside.ts", "/absolute.ts", "a.ts\n./a.ts", "", "a.ts 999999999999999999999"]) {
    assert.throws(() => readManifest(text));
  }
});

const report: AuditReport = { schema: "lemmascript-crosscheck.report/v1",
  provenance: { source: "source.ts", sourceSha256: "source", artifact: "source.dfy", artifactSha256: "artifact", lemmascript: "0.6.10", dafny: "4.11.0", runtime: "source.ts", runtimeSha256: "source" }, targets: [
  { target: "known", runtimeTarget: "known", conclusion: "issue", evidence: "counterexample", cases: 1, seed: 17 },
  { target: "unsupported", runtimeTarget: "unsupported", conclusion: "not-checked", evidence: "tool-failure", cases: 0, seed: 17, reason: "unsupported type" },
  { target: "control", runtimeTarget: "control", conclusion: "no-issue", evidence: "sampled", cases: 40, seed: 17 },
] };

test("mixed results retain both findings and coverage gaps; report-only never masks runner errors", () => {
  const results: FileResult[] = [{ study: "one-lemmascript", file: "source.ts", durationMs: 1, report }];
  assert.deepEqual(totals(results), { files: 1, filesReported: 1, filesConcluded: 1, targets: 3, issues: 1, noIssue: 1, notChecked: 1, fileFailures: 0, errors: 0 });
  assert.equal(suiteExitCode(results, false), 2);
  assert.equal(suiteExitCode(results, true), 0);
  assert.match(summary(results), /1 ISSUE FOUND, 1 NO ISSUE FOUND, 1 NOT CHECKED/);
  results.push({ study: "two-lemmascript", file: null, durationMs: 0, error: "missing manifest" });
  assert.equal(suiteExitCode(results, true), 2);
  assert.match(summary(results), /missing manifest/);
  const issueOnly = [{ ...results[0]!, report: { ...report, targets: [report.targets[0]!] } }];
  assert.equal(suiteExitCode(issueOnly, false), 1);
});

test("coverage excludes synthetic file-failure targets and uses explicit denominators", () => {
  const results: FileResult[] = [
    { study: "one-lemmascript", file: "source.ts", durationMs: 1, report },
    { study: "two-lemmascript", file: "broken.ts", durationMs: 1, report: {
      schema: "lemmascript-crosscheck.report/v1", targets: [{ ...report.targets[1]!, target: "broken.ts" }],
    } },
  ];
  const stats = statistics(results);
  assert.equal(stats.targets, 3);
  assert.equal(stats.notChecked, 1);
  assert.equal(stats.fileFailures, 1);
  assert.equal(stats.filesReportedPercent, 50);
  assert.equal(stats.reportedTargetsConcludedPercent, 66.7);
  assert.equal(suiteExitCode([results[1]!], false), 2);
  const tex = latexTable(results, { "one-lemmascript": "One & two" });
  assert(tex.includes("One \\& two"));
  assert(tex.includes("Total & 2 & 3 & 1 & 1 & 1 & 1"));
  assert.match(summary(results), /Targets hidden by failed files are unknown/);
  assert.equal(statistics([]).reportedTargetsConcludedPercent, null);
});

test("reports must contain targets and agree with the child exit code", () => {
  assert.deepEqual(validateReport(JSON.stringify(report), 2), report);
  assert.throws(() => validateReport(JSON.stringify(report), 0), /disagrees/);
  assert.throws(() => validateReport('{"schema":"lemmascript-crosscheck.report/v1","targets":[]}', 0), /empty/);
  assert.throws(() => validateReport("not JSON", 2));
  assert.throws(() => validateReport(JSON.stringify(report), null), /disagrees/);
});

test("snapshots preserve dirty sources and untracked proofs without writing through to the original", async t => {
  const temporary = await mkdtemp(path.join(tmpdir(), "crosscheck-snapshot-"));
  t.after(async () => { await rm(temporary, { recursive: true, force: true }); });
  const root = path.join(temporary, "repo"), copy = path.join(temporary, "copy");
  await mkdir(root);
  execFileSync("git", ["init", "-q", root]);
  await writeFile(path.join(root, "source.ts"), "original");
  await writeFile(path.join(root, "deleted.ts"), "deleted");
  await writeFile(path.join(root, ".gitignore"), "node_modules/\n");
  execFileSync("git", ["-C", root, "add", "source.ts", "deleted.ts", ".gitignore"]);
  await writeFile(path.join(root, "source.ts"), "dirty");
  await unlink(path.join(root, "deleted.ts"));
  await writeFile(path.join(root, "source.dfy"), "authored proof");
  await mkdir(path.join(root, "node_modules"));
  await writeFile(path.join(root, "node_modules", "dependency"), "installed");
  await snapshot(root, copy);
  assert.equal(await readFile(path.join(copy, "source.ts"), "utf8"), "dirty");
  assert.equal(await readFile(path.join(copy, "source.dfy"), "utf8"), "authored proof");
  assert.equal(await readFile(path.join(copy, "node_modules", "dependency"), "utf8"), "installed");
  await writeFile(path.join(copy, "source.dfy"), "regenerated");
  assert.equal(await readFile(path.join(root, "source.dfy"), "utf8"), "authored proof");
  await assert.rejects(readFile(path.join(copy, "deleted.ts")), { code: "ENOENT" });
});
