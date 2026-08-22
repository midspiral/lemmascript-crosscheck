import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { Encoded } from "./codec.js";
import type { IssueCategory } from "./report-types.js";

export interface StoredCase {
  schema: "lemmascript-crosscheck.case/v2";
  id: string;
  source: string;
  sourceSha256: string;
  runtime: string;
  runtimeSha256: string;
  target: string;
  runtimeTarget: string;
  category: IssueCategory;
  args: Encoded;
  runtimeArgs?: Encoded;
  presencePath?: string;
}

export interface IssueIdentity {
  sourceSha256: string;
  runtimeSha256: string;
  target: string;
  runtimeTarget: string;
  category: IssueCategory;
  args: Encoded;
}

function cacheRoot(): string {
  if (process.env.LEMMASCRIPT_CROSSCHECK_CACHE) return path.resolve(process.env.LEMMASCRIPT_CROSSCHECK_CACHE);
  const xdg = process.env.XDG_CACHE_HOME;
  return path.join(xdg ? path.resolve(xdg) : path.join(homedir(), ".cache"), "lemmascript-crosscheck", "cases");
}

export function issueId(identity: IssueIdentity): string {
  return createHash("sha256")
    .update("lemmascript-crosscheck.issue/v2").update("\0")
    .update(identity.sourceSha256).update("\0")
    .update(identity.runtimeSha256).update("\0")
    .update(identity.target).update("\0")
    .update(identity.runtimeTarget).update("\0")
    .update(identity.category).update("\0")
    .update(JSON.stringify(identity.args))
    .digest("hex").slice(0, 10);
}

export async function saveCase(stored: StoredCase): Promise<void> {
  const root = cacheRoot();
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, `${stored.id}.json`), `${JSON.stringify(stored, null, 2)}\n`);
}

export async function loadCase(id: string): Promise<StoredCase> {
  if (!/^[a-f0-9]{10}$/.test(id)) throw new Error(`invalid replay id: ${id}`);
  const value = JSON.parse(await readFile(path.join(cacheRoot(), `${id}.json`), "utf8")) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`invalid or unsupported replay case ${id}`);
  }
  const parsed = value as Partial<StoredCase>;
  if (
    parsed.schema !== "lemmascript-crosscheck.case/v2"
    || parsed.id !== id
    || typeof parsed.source !== "string"
    || !isSha256(parsed.sourceSha256)
    || typeof parsed.runtime !== "string"
    || !isSha256(parsed.runtimeSha256)
    || typeof parsed.target !== "string"
    || typeof parsed.runtimeTarget !== "string"
    || !isIssueCategory(parsed.category)
    || !("args" in parsed)
  ) {
    throw new Error(`invalid or unsupported replay case ${id}`);
  }
  return parsed as StoredCase;
}

export function resolveReplayRuntime(
  stored: StoredCase,
  sourceOverride: string | undefined,
  runtimeOverride: string | undefined,
): string {
  if (runtimeOverride !== undefined) return runtimeOverride;
  if (stored.runtime === stored.source && sourceOverride !== undefined) return sourceOverride;
  return stored.runtime;
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function isIssueCategory(value: unknown): value is IssueCategory {
  return typeof value === "string" && [
    "result-mismatch",
    "input-domain",
    "input-representation-mismatch",
    "proof-domain-gap",
    "runtime-postcondition-violation",
    "input-mutation",
    "optional-presence",
    "console-output",
    "runtime-threw",
    "runtime-timeout",
  ].includes(value);
}
