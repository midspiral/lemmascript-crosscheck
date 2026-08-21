#!/usr/bin/env node

import { readFileSync } from "node:fs";
import path from "node:path";
import { auditFile, type AuditOptions } from "./audit.js";
import { loadCase } from "./cases.js";
import { conciseCommandError } from "./command.js";
import { runtimePackageRoot } from "./dafny-build.js";
import { exitCode, renderFatal, renderReport } from "./report.js";
import type { AuditReport } from "./report-types.js";

interface CliOptions {
  source?: string;
  runtime?: string;
  only?: string;
  replayId?: string;
  cases: number;
  seed: number;
  timeoutMs: number;
  verifyTimeoutMs: number;
  details: boolean;
  json: boolean;
  entries: Map<string, string>;
  help: boolean;
  version: boolean;
}

const VERSION = packageVersion();

function packageVersion(): string {
  const manifest = JSON.parse(readFileSync(path.join(runtimePackageRoot(), "package.json"), "utf8")) as { version?: unknown };
  if (typeof manifest.version !== "string" || manifest.version.length === 0) {
    throw new Error("lemmascript-crosscheck package.json has no version");
  }
  return manifest.version;
}

async function main(): Promise<void> {
  let parsed: CliOptions;
  try { parsed = parseArgs(process.argv.slice(2)); }
  catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error("Run lemmascript-crosscheck --help for usage.");
    process.exitCode = 2;
    return;
  }
  if (parsed.help) { process.stdout.write(help()); return; }
  if (parsed.version) { process.stdout.write(`${VERSION}\n`); return; }

  const replay = parsed.replayId ? await loadCase(parsed.replayId) : undefined;
  const source = path.resolve(parsed.source ?? replay?.source ?? "");
  if (!source || source === path.resolve("")) {
    console.error("A LemmaScript source file is required.");
    console.error("Run lemmascript-crosscheck --help for usage.");
    process.exitCode = 2;
    return;
  }
  if (replay) {
    parsed.only = replay.target;
    parsed.entries.set(replay.target, replay.runtimeTarget);
  }

  let lastProgressLength = 0;
  const progress = process.stderr.isTTY && !parsed.json ? (phase: string) => {
    const text = `Checking ${path.basename(source)} · ${phase}`;
    process.stderr.write(`\r${text.padEnd(lastProgressLength)}`);
    lastProgressLength = Math.max(lastProgressLength, text.length);
  } : undefined;
  const clearProgress = () => {
    if (lastProgressLength) process.stderr.write(`\r${" ".repeat(lastProgressLength)}\r`);
  };

  try {
    const options: AuditOptions = {
      cases: parsed.cases,
      seed: parsed.seed,
      timeoutMs: parsed.timeoutMs,
      verifyTimeoutMs: parsed.verifyTimeoutMs,
      entries: parsed.entries,
      saveCases: true,
      ...(parsed.runtime === undefined ? {} : { runtime: parsed.runtime }),
      ...(parsed.only === undefined ? {} : { only: parsed.only }),
      ...(replay === undefined ? {} : { replay }),
      ...(progress === undefined ? {} : { progress }),
    };
    const report = await auditFile(source, options);
    clearProgress();
    process.stdout.write(parsed.json ? `${JSON.stringify(report, null, 2)}\n` : `${renderReport(report, { details: parsed.details })}\n`);
    process.exitCode = exitCode(report);
  } catch (error) {
    clearProgress();
    const message = conciseCommandError(error);
    if (parsed.json) {
      const target = parsed.only ?? path.basename(source);
      const report: AuditReport = {
        schema: "lemmascript-crosscheck.report/v1",
        targets: [{
          target,
          runtimeTarget: parsed.entries.get(target) ?? target,
          conclusion: "not-checked",
          evidence: "tool-failure",
          cases: 0,
          seed: parsed.seed,
          reason: message,
          nextStep: "Resolve the reported failure and rerun the audit.",
        }],
      };
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    } else {
      process.stdout.write(`${renderFatal(path.basename(source), message)}\n`);
    }
    process.exitCode = 2;
  }
}

function parseArgs(args: string[]): CliOptions {
  const result: CliOptions = {
    cases: 100,
    seed: 17,
    timeoutMs: 2_000,
    verifyTimeoutMs: 300_000,
    details: false,
    json: false,
    entries: new Map(),
    help: false,
    version: false,
  };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === "--help" || arg === "-h") { result.help = true; continue; }
    if (arg === "--version" || arg === "-v") { result.version = true; continue; }
    if (arg === "--details") { result.details = true; continue; }
    if (arg === "--json") { result.json = true; continue; }
    if (!arg.startsWith("-")) {
      if (result.source) throw new Error(`Unexpected second source path: ${arg}`);
      result.source = arg;
      continue;
    }
    const [name, inline] = splitFlag(arg);
    const value = inline ?? args[++index];
    if (value === undefined || value.startsWith("--")) throw new Error(`${name} requires a value`);
    if (name === "--runtime") result.runtime = value;
    else if (name === "--only") result.only = value;
    else if (name === "--replay") result.replayId = value;
    else if (name === "--cases") result.cases = positiveInteger(name, value);
    else if (name === "--seed") result.seed = integer(name, value);
    else if (name === "--timeout") result.timeoutMs = positiveInteger(name, value);
    else if (name === "--verify-timeout") result.verifyTimeoutMs = positiveInteger(name, value);
    else if (name === "--entry") {
      const separator = value.indexOf("=");
      if (separator <= 0 || separator === value.length - 1) throw new Error("--entry must be formalName=runtimeName");
      result.entries.set(value.slice(0, separator), value.slice(separator + 1));
    } else throw new Error(`Unknown option: ${name}`);
  }
  return result;
}

function splitFlag(arg: string): [string, string | undefined] {
  const separator = arg.indexOf("=");
  return separator < 0 ? [arg, undefined] : [arg.slice(0, separator), arg.slice(separator + 1)];
}

function positiveInteger(name: string, value: string): number {
  const parsed = integer(name, value);
  if (parsed <= 0) throw new Error(`${name} must be positive`);
  return parsed;
}

function integer(name: string, value: string): number {
  if (!/^-?\d+$/.test(value)) throw new Error(`${name} must be an integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${name} is outside the safe integer range`);
  return parsed;
}

function help(): string {
  return `lemmascript-crosscheck ${VERSION}\n\nUsage:\n  lemmascript-crosscheck <source.ts> [options]\n\nOptions:\n  --only <name>          Check one exported verified function\n  --runtime <module>     Execute a deployed module instead of the source\n  --entry A=B            Map formal target A to runtime export B\n  --cases <count>        Proof-valid executions per target (default: 100)\n  --seed <integer>       Deterministic generation seed (default: 17)\n  --timeout <ms>         Per-call worker deadline (default: 2000)\n  --verify-timeout <ms>  LemmaScript/Dafny deadline (default: 300000)\n  --replay <id>          Replay a saved counterexample\n  --details              Expand every target in a multi-target file\n  --json                 Emit the stable machine report\n  --help                  Show this help\n  --version               Show the version\n\nDevelopment checkout:\n  LEMMASCRIPT=../LemmaScript lemmascript-crosscheck ../LemmaScript/examples/arraySum.ts\n`;
}

void main();
