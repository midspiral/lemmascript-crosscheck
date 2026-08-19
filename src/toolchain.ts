import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import type { TypedInfo } from "./ir.js";
import { runCommand } from "./command.js";

interface Invocation {
  command: string;
  prefix: string[];
  cwd?: string;
}

export interface VerifiedInput {
  source: string;
  sourceHash: string;
  artifact: string;
  artifactHash: string;
  info: TypedInfo;
  lemmascriptVersion: string;
  dafnyVersion: string;
  verifyOutput: string;
}

export class UnsupportedBackendError extends Error {
  constructor(readonly info: TypedInfo, message: string) {
    super(message);
    this.name = "UnsupportedBackendError";
  }
}

function lscInvocation(): Invocation {
  const checkout = process.env.LEMMASCRIPT;
  if (checkout) {
    return {
      command: process.execPath,
      prefix: ["--import", "tsx", path.join(checkout, "tools", "src", "lsc.ts")],
      cwd: checkout,
    };
  }
  return { command: "lsc", prefix: [] };
}

async function runLsc(args: string[], timeoutMs: number): Promise<{ stdout: string; stderr: string }> {
  const invocation = lscInvocation();
  return await runCommand({
    command: invocation.command,
    args: [...invocation.prefix, ...args],
    ...(invocation.cwd === undefined ? {} : { cwd: invocation.cwd }),
    timeoutMs,
  });
}

async function sha256(file: string): Promise<string> {
  return createHash("sha256").update(await readFile(file)).digest("hex");
}

function compatibleVersion(version: string): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  return !!match && Number(match[1]) === 0 && Number(match[2]) === 6;
}

export async function verifyAndInspect(sourcePath: string, timeoutMs = 300_000): Promise<VerifiedInput> {
  const source = path.resolve(sourcePath);
  await access(source);
  const sourceHashBefore = await sha256(source);

  const version = (await runLsc(["version"], 30_000)).stdout.trim();
  if (!compatibleVersion(version)) {
    throw new Error(`LemmaScript ${version || "unknown"} is unsupported; this build requires 0.6.x typed-info schema 1`);
  }

  const infoOutput = await runLsc(["info", "--typed", source], 60_000);
  let info: TypedInfo;
  try {
    info = JSON.parse(infoOutput.stdout) as TypedInfo;
  } catch {
    throw new Error("lsc info --typed did not return JSON");
  }
  if (info.schema !== 1) throw new Error(`typed-info schema ${info.schema} is unsupported; expected 1`);
  if (info.backendDirective === "lean") {
    throw new UnsupportedBackendError(info, "the external model runner currently supports Dafny sources only");
  }
  if (info.dafny.error) throw new Error(`Lemmascript could not emit Dafny metadata: ${info.dafny.error}`);

  const checked = await runLsc(["check", "--backend=dafny", source], timeoutMs);
  const sourceHashAfter = await sha256(source);
  if (sourceHashBefore !== sourceHashAfter) throw new Error("source changed while LemmaScript verification was running");

  const extension = path.extname(source);
  const artifact = path.join(path.dirname(source), `${path.basename(source, extension)}.dfy`);
  await access(artifact);
  const artifactHash = await sha256(artifact);
  const dafnyVersion = (await runCommand({ command: "dafny", args: ["--version"], timeoutMs: 30_000 })).stdout.trim();

  return {
    source,
    sourceHash: sourceHashAfter,
    artifact,
    artifactHash,
    info,
    lemmascriptVersion: version,
    dafnyVersion,
    verifyOutput: [checked.stdout, checked.stderr].filter(Boolean).join("\n").trim(),
  };
}

export async function hashFile(file: string): Promise<string> {
  return await sha256(file);
}
