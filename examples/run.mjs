import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderReport } from "../dist/src/report.js";

// Run temporary source copies: verification must not touch local proof files.
const directory = path.dirname(fileURLToPath(import.meta.url));
const cli = path.resolve(directory, "../dist/src/cli.js");
const update = process.argv.includes("--update");
const selected = process.argv.slice(2).filter(arg => arg !== "--update");
const sources = (await readdir(directory)).filter(name => name.endsWith(".ts")).sort();
for (const name of selected) {
  assert.ok(sources.includes(`${name}.ts`), `Unknown example: ${name} (use its name without .ts)`);
}
const root = await mkdtemp(path.join(tmpdir(), "crosscheck-examples-"));
const env = {
  ...process.env,
  LEMMASCRIPT_CROSSCHECK_CACHE: path.join(root, "cases"),
  LEMMASCRIPT_CROSSCHECK_BUILD_CACHE: path.join(root, "build"),
};

function audit(args) {
  const result = spawnSync(process.execPath, [cli, ...args, "--json"], {
    cwd: path.dirname(directory), env, encoding: "utf8", timeout: 180_000,
  });
  assert.ifError(result.error);
  assert.ok(result.status === 0 || result.status === 1, result.stdout + result.stderr);
  const report = JSON.parse(result.stdout);
  assert.ok(report.provenance, "Missing verification evidence");
  assert.ok(report.targets.length > 0, "No targets checked");
  assert.ok(report.targets.every(target => target.conclusion !== "not-checked"), result.stdout);
  return report;
}

try {
  for (const name of sources) {
    const stem = name.slice(0, -3);
    if (selected.length && !selected.includes(stem)) continue;
    try {
      const source = path.join(directory, name);
      const temporary = path.join(root, name);
      const text = await readFile(source, "utf8");
      // This ordinary comment selects CLI options, not a LemmaScript annotation.
      const extra = /^\/\/ crosscheck: (.+)$/m.exec(text)?.[1].trim().split(/\s+/) ?? [];
      const options = ["--cases", "40", "--seed", "17", "--details", ...extra];
      await copyFile(source, temporary);
      const report = audit([temporary, ...options]);
      for (const target of report.targets) {
        if (!target.issue) continue;
        const replay = audit(["--replay", target.issue.id]);
        assert.equal(replay.targets.length, 1);
        assert.equal(replay.targets[0].conclusion, "issue");
        assert.deepEqual(replay.targets[0].issue, target.issue);
      }

      // Only the temporary pathname changes; retain witnesses, IDs and results.
      report.provenance.source = `examples/${name}`;
      report.provenance.runtime = `examples/${name}`;
      const command = `$ lemmascript-crosscheck examples/${name} ${options.join(" ")}`;
      const versions = `Verified with LemmaScript ${report.provenance.lemmascript}; Dafny ${report.provenance.dafny}.`;
      const output = `${command}\n${versions}\n\n${renderReport(report, { details: true })}\n`;
      const expected = path.join(directory, `${stem}.out`);
      if (update) await writeFile(expected, output);
      else assert.equal(output, await readFile(expected, "utf8"), `${name}: output changed; inspect before updating`);
      console.log(`${update ? "Updated" : "Checked"} ${stem}.out (${report.targets.length} targets)`);
    } catch (error) {
      console.error(`${name}: ${error.stack ?? error}`);
      process.exitCode = 1;
    }
  }
} finally {
  await rm(root, { recursive: true, force: true });
}
