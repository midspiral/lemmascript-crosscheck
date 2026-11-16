import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, realpath, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import type { AuditReport } from "../src/report-types.js";
import { exitCode } from "../src/report.js";
import { runtimePackageRoot } from "../src/dafny-build.js";

export interface Study { name: string; repo: string; branch: string }
export interface Entry { file: string; line: number; timeLimit?: number; flags: string[] }
export interface FileResult {
  study: string;
  file: string | null;
  entry?: Entry;
  durationMs: number;
  exitCode?: number | null;
  command?: string[];
  report?: AuditReport;
  error?: string;
}

/** Match the paper's *-lemmascript corpus, taking each project's primary branch
 * once. Alternative CI branches exercise other integrations of the same study. */
export function readStudies(text: string): Study[] {
  const studies: Study[] = [];
  const repositories = new Set<string>();
  let inJob = false, inMatrix = false;
  let pending: Partial<Study> | undefined;
  const finish = () => {
    if (!pending) return;
    if (!pending.repo || !pending.branch) throw new Error("Incomplete case-study CI entry");
    if (pending.repo.endsWith("-lemmascript")) repositories.add(pending.repo);
    if (pending.repo.endsWith("-lemmascript") && ["main", "lemmascript"].includes(pending.branch)) {
      const name = pending.repo.split("/")[1]!;
      if (studies.some(study => study.name === name)) throw new Error(`Duplicate primary study: ${name}`);
      studies.push({ name, repo: pending.repo, branch: pending.branch });
    }
    pending = undefined;
  };
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const job = /^  ([\w-]+):\s*$/.exec(line);
    if (job) { finish(); inJob = job[1] === "case-studies-dafny"; inMatrix = false; continue; }
    if (!inJob) continue;
    if (/^        include:\s*$/.test(line)) { inMatrix = true; continue; }
    if (!inMatrix) continue;
    if (line.search(/\S/) <= 8) { finish(); inMatrix = false; continue; }
    const repo = /^          - repo:\s*([\w.-]+\/[\w.-]+)\s*(?:#.*)?$/.exec(line);
    const branch = /^            branch:\s*([\w./-]+)\s*(?:#.*)?$/.exec(line);
    if (repo) { finish(); pending = { repo: repo[1]! }; }
    else if (branch && pending && !pending.branch) pending.branch = branch[1]!;
    else if (!/^            guard:\s*(true|false)\s*$/.test(line) || !pending) {
      throw new Error(`Unsupported case-study CI matrix syntax: ${line.trim()}`);
    }
  }
  finish();
  if (!studies.length) throw new Error("Missing primary case-studies-dafny entries in LemmaScript CI");
  for (const repo of repositories) {
    if (!studies.some(study => study.repo === repo)) throw new Error(`Missing primary main/lemmascript branch for ${repo}`);
  }
  return studies;
}

function relativePath(root: string, file: string): string {
  const resolved = path.resolve(root, file), relative = path.relative(root, resolved);
  if (path.isAbsolute(file) || !relative || relative === ".." || relative.startsWith(`..${path.sep}`)) {
    throw new Error(`Path outside study: ${file}`);
  }
  return resolved;
}

/** lsc's manifest grammar: file [seconds] [Dafny flags...], no shell quoting. */
export function readManifest(text: string): Entry[] {
  const entries: Entry[] = [];
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    const [file, second, ...rest] = line.trim().split(/\s+/) as [string, string?, ...string[]];
    relativePath("/study", file);
    if (!file.endsWith(".ts")) throw new Error(`Expected TypeScript source on manifest line ${index + 1}`);
    const timeLimit = second && /^[1-9]\d*$/.test(second) ? Number(second) : undefined;
    if (timeLimit !== undefined && !Number.isSafeInteger(timeLimit)) throw new Error(`Invalid time limit: ${second}`);
    if (entries.some(entry => path.normalize(entry.file) === path.normalize(file))) throw new Error(`Duplicate manifest source: ${file}`);
    entries.push({ file, line: index + 1, ...(timeLimit === undefined ? {} : { timeLimit }),
      flags: (timeLimit === undefined ? [second, ...rest] : rest).filter((flag): flag is string => !!flag) });
  }
  if (!entries.length) throw new Error("Empty LemmaScript-files.txt");
  return entries;
}

function git(root: string, ...args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 }).trimEnd();
}

function revision(root: string) {
  return { commit: git(root, "rev-parse", "HEAD"), branch: git(root, "branch", "--show-current"),
    changes: git(root, "status", "--porcelain=v1", "--untracked-files=normal").split("\n").filter(Boolean) };
}

/** Copy current files, including untracked proofs, without sharing writable
 * source/artifact files. Reuse installed dependency directories for execution. */
export async function snapshot(root: string, destination: string): Promise<void> {
  const files = git(root, "ls-files", "-z", "--cached", "--others", "--exclude-standard").split("\0").filter(Boolean);
  const directories = new Set([""]);
  for (const file of new Set(files)) {
    const source = relativePath(root, file), target = relativePath(destination, file);
    try { await stat(source); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; // Locally deleted tracked file.
      throw error;
    }
    await mkdir(path.dirname(target), { recursive: true });
    await cp(source, target, { dereference: true, recursive: true });
    let directory = path.dirname(file);
    while (directory !== ".") { directories.add(directory); directory = path.dirname(directory); }
  }
  for (const directory of directories) {
    const modules = path.join(root, directory, "node_modules");
    try {
      if (!(await stat(modules)).isDirectory()) continue;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    await mkdir(path.join(destination, directory), { recursive: true });
    await symlink(await realpath(modules), path.join(destination, directory, "node_modules"), "dir");
  }
}

export function validateReport(stdout: string, status: number | null): AuditReport {
  const report = JSON.parse(stdout) as AuditReport;
  if (report.schema !== "lemmascript-crosscheck.report/v1" || !Array.isArray(report.targets) || !report.targets.length) {
    throw new Error("Crosscheck returned an empty or invalid report");
  }
  for (const target of report.targets) {
    if (typeof target.target !== "string" || !["issue", "no-issue", "not-checked"].includes(target.conclusion)) {
      throw new Error("Crosscheck returned an invalid target");
    }
  }
  if (status !== exitCode(report)) throw new Error(`Crosscheck exit ${status} disagrees with its report`);
  return report;
}

async function runFile(command: string[], cwd: string, env: NodeJS.ProcessEnv, timeoutMs: number) {
  return await new Promise<{ stdout: string; stderr: string; status: number | null; error?: string }>(resolve => {
    const child = spawn(command[0]!, command.slice(1), { cwd, env, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "", failure: string | undefined;
    const kill = () => {
      try { if (process.platform !== "win32") process.kill(-child.pid!, "SIGKILL"); else child.kill("SIGKILL"); } catch { /* Already exited. */ }
    };
    const interrupted = () => { failure = "Audit interrupted"; kill(); };
    process.once("SIGINT", interrupted);
    process.once("SIGTERM", interrupted);
    const timer = setTimeout(() => { failure = `File deadline exceeded (${timeoutMs}ms)`; kill(); }, timeoutMs);
    child.stdout.setEncoding("utf8").on("data", chunk => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", chunk => { stderr += chunk; });
    child.on("error", error => { failure = error.message; });
    child.on("close", status => {
      clearTimeout(timer);
      process.removeListener("SIGINT", interrupted);
      process.removeListener("SIGTERM", interrupted);
      // A killed CLI may have left verifier/worker descendants behind.
      kill();
      resolve({ stdout, stderr, status, ...(failure === undefined ? {} : { error: failure }) });
    });
  });
}

export function totals(results: FileResult[]) {
  // Fatal CLI reports contain a synthetic filename target. Those are failed
  // files, not discovered functions, and must not inflate target coverage.
  const reported = results.filter(result => result.report?.provenance);
  const targets = reported.flatMap(result => result.report!.targets);
  return { files: results.filter(result => result.file !== null).length,
    filesReported: reported.length,
    filesConcluded: reported.filter(result => result.report!.targets.some(target => target.conclusion !== "not-checked")).length,
    targets: targets.length,
    issues: targets.filter(target => target.conclusion === "issue").length,
    noIssue: targets.filter(target => target.conclusion === "no-issue").length,
    notChecked: targets.filter(target => target.conclusion === "not-checked").length,
    fileFailures: results.filter(result => result.report && !result.report.provenance).length,
    errors: results.filter(result => result.error !== undefined).length };
}

export function suiteExitCode(results: FileResult[], reportOnly: boolean): number {
  const count = totals(results);
  if (count.errors) return 2;
  if (reportOnly) return 0;
  return count.notChecked || count.fileFailures ? 2 : count.issues ? 1 : 0;
}

function percentage(numerator: number, denominator: number): number | null {
  return denominator ? Math.round(1000 * numerator / denominator) / 10 : null;
}

export function statistics(results: FileResult[]) {
  const count = totals(results);
  const categories: Record<string, number> = {};
  for (const result of results) for (const target of result.report?.targets ?? []) {
    if (target.issue) categories[target.issue.category] = (categories[target.issue.category] ?? 0) + 1;
  }
  return { ...count,
    projects: new Set(results.filter(result => result.study !== "(runner)").map(result => result.study)).size,
    conclusiveTargets: count.issues + count.noIssue,
    aggregateFileSeconds: Math.round(results.reduce((sum, result) => sum + result.durationMs, 0) / 100) / 10,
    filesReportedPercent: percentage(count.filesReported, count.files),
    filesConcludedPercent: percentage(count.filesConcluded, count.files),
    reportedTargetsConcludedPercent: percentage(count.issues + count.noIssue, count.targets),
    issueCategories: Object.fromEntries(Object.entries(categories).sort((a, b) => b[1] - a[1])),
  };
}

type Labels = Record<string, string>;
const percentText = (value: number | null) => value === null ? "—" : `${value.toFixed(1)}%`;

export function summary(results: FileResult[], labels: Labels = {}): string {
  const count = totals(results);
  const stats = statistics(results);
  const lines = ["# Case-study Crosscheck audit", "",
    `${stats.projects} projects, ${count.files} manifest source files; ${count.targets} reported targets: ${count.issues} ISSUE FOUND, ${count.noIssue} NO ISSUE FOUND, ${count.notChecked} NOT CHECKED. Separately, ${count.fileFailures} files failed before target reporting; ${count.errors} runner errors.`, "",
    "Findings include formal inputs that JavaScript cannot represent; they are not all application bugs. NO ISSUE FOUND is sampled evidence, not a proof. Targets hidden by failed files are unknown and excluded from target percentages.", "",
    "| Study | Files | Targets | Findings | No issue | Not checked | Failed files |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: |"];
  for (const study of new Set(results.map(result => result.study))) {
    const c = totals(results.filter(result => result.study === study));
    lines.push(`| ${labels[study] ?? study} | ${c.files} | ${c.targets} | ${c.issues} | ${c.noIssue} | ${c.notChecked} | ${c.fileFailures} |`);
  }
  lines.push(`| **Total** | **${count.files}** | **${count.targets}** | **${count.issues}** | **${count.noIssue}** | **${count.notChecked}** | **${count.fileFailures}** |`, "",
    "## Coverage statistics", "", "| Measure | Count | Percentage |", "| --- | ---: | ---: |",
    `| Files producing target reports | ${count.filesReported}/${count.files} | ${percentText(stats.filesReportedPercent)} |`,
    `| Files with findings or clean samples | ${count.filesConcluded}/${count.files} | ${percentText(stats.filesConcludedPercent)} |`,
    `| Reported targets with conclusive outcomes | ${stats.conclusiveTargets}/${count.targets} | ${percentText(stats.reportedTargetsConcludedPercent)} |`, "",
    "The target completion percentage is conditional on files that produced target reports; it is not whole-corpus function coverage.", "",
    "## Finding categories", "", "| Category | Targets | Share of findings |", "| --- | ---: | ---: |");
  for (const [category, n] of Object.entries(stats.issueCategories)) {
    lines.push(`| ${category} | ${n} | ${percentText(percentage(n, count.issues))} |`);
  }
  const clean = (text: string) => text.replace(/[\r\n]+/g, " ").replace(/\|/g, "\\|");
  lines.push("", "## Findings and coverage gaps", "", "| Source | Target | Result | Detail |", "| --- | --- | --- | --- |");
  for (const result of results) {
    const source = `${result.study}/${result.file ?? "(setup)"}`;
    if (result.error) lines.push(`| ${source} | — | RUNNER ERROR | ${clean(result.error)} |`);
    for (const target of result.report?.targets ?? []) {
      if (target.conclusion === "no-issue") continue;
      const detail = target.issue ? `${target.issue.category}: ${target.issue.summary} (replay ${target.issue.id})` : target.reason ?? "Unknown";
      lines.push(`| ${source} | ${clean(target.target)} | ${target.conclusion === "issue" ? "ISSUE FOUND" : "NOT CHECKED"} | ${clean(detail)} |`);
    }
  }
  return lines.join("\n") + "\n";
}

export function latexTable(results: FileResult[], labels: Labels = {}): string {
  const escape = (text: string) => text.replace(/[\\{}_$%&#~^]/g, character => ({
    "\\": "\\textbackslash{}", "~": "\\textasciitilde{}", "^": "\\textasciicircum{}",
  }[character] ?? `\\${character}`));
  const rows = [...new Set(results.map(result => result.study))].map(study => ({
    label: labels[study] ?? study.replace(/-lemmascript$/, ""), count: totals(results.filter(result => result.study === study)),
  }));
  rows.push({ label: "Total", count: totals(results) });
  const header = "Project & Files & Targets & Findings & No issue & Unchecked & Failed files " + "\\\\";
  const lines = ["% Generated by lemmascript-crosscheck/scripts/case-studies.ts; do not edit.",
    "\\begingroup\\footnotesize\\setlength{\\tabcolsep}{3pt}", "\\begin{longtable}{@{}lrrrrrr@{}}",
    "\\caption{Crosscheck outcomes for case-study manifest sources (Dafny).}\\label{tab:crosscheck-case-studies}\\\\",
    "\\toprule", header,
    "\\midrule\\endfirsthead", "\\toprule", header,
    "\\midrule\\endhead", "\\bottomrule\\endfoot"];
  for (const { label, count: c } of rows) {
    if (label === "Total") lines.push("\\midrule");
    lines.push(`${escape(label)} & ${c.files} & ${c.targets} & ${c.issues} & ${c.noIssue} & ${c.notChecked} & ${c.fileFailures} \\\\`);
  }
  lines.push("\\end{longtable}",
    "\\noindent Findings include input-domain and representation gaps. No issue is sampled evidence, not a proof. Unchecked counts reported targets only; failed files have unknown target coverage. Standalone proof files and Lean are outside this audit.",
    "\\endgroup");
  return lines.join("\n") + "\n";
}

async function writeSummaries(directory: string, report: { results: FileResult[]; [key: string]: unknown }, labels: Labels) {
  await writeFile(path.join(directory, "summary.json"), JSON.stringify({ ...report, totals: totals(report.results) }, null, 2) + "\n");
  await writeFile(path.join(directory, "summary.md"), summary(report.results, labels));
  await writeFile(path.join(directory, "stats.json"), JSON.stringify(statistics(report.results), null, 2) + "\n");
  await writeFile(path.join(directory, "case-studies.tex"), latexTable(report.results, labels));
}

function integer(value: string, label: string, minimum = 1): number {
  const n = Number(value);
  if (!/^-?\d+$/.test(value) || !Number.isSafeInteger(n) || n < minimum) throw new Error(`Invalid ${label}: ${value}`);
  return n;
}

async function main() {
  const { values } = parseArgs({ options: {
    workspace: { type: "string", default: ".." }, lemmascript: { type: "string" }, paper: { type: "string" },
    output: { type: "string", default: "reports/case-studies" }, repo: { type: "string" },
    cases: { type: "string", default: "40" }, seed: { type: "string", default: "17" },
    checks: { type: "string", default: "differential" }, jobs: { type: "string", default: "1" },
    "verify-timeout": { type: "string", default: "300000" }, "file-timeout": { type: "string", default: "1200000" },
    "report-only": { type: "boolean" }, list: { type: "boolean" }, help: { type: "boolean" },
    summarize: { type: "string" },
  }, strict: true });
  if (values.help) {
    console.log(`Usage: npm run case-studies -- [options]
  --workspace DIR       Parent of case-study checkouts (default: ..)
  --lemmascript DIR     Compiler checkout (default: LEMMASCRIPT or WORKSPACE/LemmaScript)
  --paper DIR           Check the selected corpus against paper/case-studies.json
  --repo NAME           Run one repository from the corpus
  --list                Print the CI matrix as JSON without running checks
  --output DIR          Reports, replay cases, and copied sources (default: reports/case-studies)
  --cases N --seed N    Samples per target and seed (defaults: 40, 17)
  --checks LIST         differential, contract, or contract,differential
  --jobs N              Concurrent projects (default: 1)
  --verify-timeout MS   Minimum verification/build deadline (default: 300000)
  --file-timeout MS     Whole-file deadline (default: 1200000)
  --report-only         Exit zero for findings/NOT CHECKED; runner errors still fail
  --summarize RUN_DIR   Rebuild tables/stats from saved results without auditing

Reads primary Dafny projects from LemmaScript CI and each LemmaScript-files.txt.
Includes slow manifest entries; preserves time limits and Dafny flags. Runs copies
of current files, retaining snapshots and witnesses for replay. Exit codes: 0/1/2
as for Crosscheck, with runner errors also returning 2.`);
    return;
  }
  const metadata = values.paper ? JSON.parse(await readFile(path.join(values.paper, "case-studies.json"), "utf8")) as { studies: Record<string, { name: string }> } : undefined;
  const labels = Object.fromEntries(Object.entries(metadata?.studies ?? {}).map(([name, study]) => [name, study.name]));
  if (values.summarize) {
    const directory = path.resolve(values.summarize);
    const report = JSON.parse(await readFile(path.join(directory, "summary.json"), "utf8")) as { schema: string; results: FileResult[] };
    if (report.schema !== "lemmascript-crosscheck.corpus/v1" || !Array.isArray(report.results)) throw new Error("Invalid saved corpus report");
    await writeSummaries(directory, report, labels);
    console.log(`Updated tables and statistics: ${directory}`);
    return;
  }
  const workspace = path.resolve(values.workspace);
  const compiler = path.resolve(values.lemmascript ?? process.env.LEMMASCRIPT ?? path.join(workspace, "LemmaScript"));
  const ci = await readFile(path.join(compiler, ".github/workflows/ci.yml"), "utf8");
  let studies = readStudies(ci);
  if (metadata) {
    const expected = Object.keys(metadata.studies).sort(), actual = studies.map(study => study.name).sort();
    if (JSON.stringify(expected) !== JSON.stringify(actual)) throw new Error("Paper and LemmaScript CI select different case-study repositories");
  }
  if (values.repo) {
    studies = studies.filter(study => study.name === values.repo || study.repo === values.repo);
    if (!studies.length) throw new Error(`Unknown case study: ${values.repo}`);
  }
  if (values.list) { console.log(JSON.stringify({ include: studies })); return; }
  const cases = integer(values.cases, "cases"), seed = integer(values.seed, "seed", Number.MIN_SAFE_INTEGER);
  const jobs = integer(values.jobs, "jobs"), verifyTimeout = integer(values["verify-timeout"], "verify-timeout");
  const fileTimeout = integer(values["file-timeout"], "file-timeout");
  if (!values.checks.split(",").every(check => ["contract", "differential"].includes(check))) throw new Error("Invalid checks");
  const output = path.resolve(values.output);
  // A unique run directory also prevents stale reports/witnesses from polluting a rerun.
  await mkdir(output, { recursive: true });
  const run = await mkdtemp(path.join(output, "run-"));
  const cli = path.join(runtimePackageRoot(), "dist/src/cli.js");
  await stat(cli);
  const results: FileResult[] = [];
  const checkouts: Record<string, unknown> = {};
  const started = new Date().toISOString();
  const compilerRevision = revision(compiler), crosscheckRevision = revision(runtimePackageRoot());
  const env = { ...process.env, LEMMASCRIPT: compiler, LSC_RUN_LOG: "false",
    LEMMASCRIPT_CROSSCHECK_CACHE: path.join(run, "cases"), LEMMASCRIPT_CROSSCHECK_BUILD_CACHE: path.join(run, "build") };
  const persist = async () => {
    const ordered = [...results].sort((a, b) => a.study.localeCompare(b.study) || (a.entry?.line ?? 0) - (b.entry?.line ?? 0));
    await writeSummaries(run, { schema: "lemmascript-crosscheck.corpus/v1", started, durationMs: Date.now() - Date.parse(started),
      compiler: compilerRevision, crosscheck: crosscheckRevision, ciSha256: createHash("sha256").update(ci).digest("hex"), studies, checkouts,
      options: { cases, seed, checks: values.checks, verifyTimeout, fileTimeout }, results: ordered }, labels);
  };
  let next = 0, interrupted = false;
  const stop = () => { interrupted = true; };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  await Promise.all(Array.from({ length: Math.min(jobs, studies.length) }, async () => {
    while (next < studies.length && !interrupted) {
      const study = studies[next++]!;
      try {
        const root = path.join(workspace, study.name);
        checkouts[study.name] = revision(root);
        const manifest = await readFile(path.join(root, "LemmaScript-files.txt"), "utf8");
        const entries = readManifest(manifest);
        const copied = path.join(run, "sources", study.name);
        await snapshot(root, copied);
        const reports = path.join(run, "reports", study.name);
        await mkdir(reports, { recursive: true });
        await writeFile(path.join(reports, "LemmaScript-files.txt"), manifest);
        for (const entry of entries) {
          if (interrupted) break;
          const start = Date.now();
          const command = [process.execPath, cli, relativePath(copied, entry.file), "--json", "--cases", String(cases),
            "--seed", String(seed), "--checks", values.checks, "--verify-timeout", String(Math.max(verifyTimeout, (entry.timeLimit ?? 0) * 1000 + 60_000))];
          if (entry.timeLimit !== undefined) command.push(`--time-limit=${entry.timeLimit}`);
          if (entry.flags.length) command.push(`--extra-flags=${entry.flags.join(" ")}`);
          console.log(`Checking ${study.name}/${entry.file}`);
          const child = await runFile(command, copied, env, fileTimeout);
          const result: FileResult = { study: study.name, file: entry.file, entry, command, exitCode: child.status, durationMs: Date.now() - start };
          try {
            if (child.error) throw new Error(child.error);
            result.report = validateReport(child.stdout, child.status);
          } catch (error) { result.error = error instanceof Error ? error.message : String(error); }
          results.push(result);
          const prefix = path.join(reports, String(entry.line));
          await writeFile(`${prefix}.json`, JSON.stringify(result, null, 2) + "\n");
          await writeFile(`${prefix}.stdout`, child.stdout);
          await writeFile(`${prefix}.stderr`, child.stderr);
          const c = totals([result]);
          console.log(`  ${c.issues} issues, ${c.noIssue} no issue, ${c.notChecked} not checked, ${c.fileFailures} failed files, ${c.errors} runner errors (${Math.round(result.durationMs / 1000)}s)`);
        }
      } catch (error) {
        results.push({ study: study.name, file: null, durationMs: 0, error: error instanceof Error ? error.message : String(error) });
        console.error(`${study.name}: ${results.at(-1)!.error}`);
      }
    }
  }));
  process.removeListener("SIGINT", stop);
  process.removeListener("SIGTERM", stop);
  if (interrupted) results.push({ study: "(runner)", file: null, durationMs: 0, error: "Audit interrupted; corpus incomplete" });
  await persist();
  console.log(`Reports: ${run}\n${JSON.stringify(totals(results))}`);
  process.exitCode = suiteExitCode(results, values["report-only"] ?? false);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 2; });
}
