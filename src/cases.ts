import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { Encoded } from "./codec.js";
import type { IssueCategory } from "./report-types.js";

export interface StoredCase {
  schema: "ls-crosscheck.case/v1";
  id: string;
  source: string;
  sourceSha256: string;
  target: string;
  runtimeTarget: string;
  category: IssueCategory;
  args: Encoded;
  runtimeArgs?: Encoded;
  presencePath?: string;
}

function cacheRoot(): string {
  if (process.env.LS_CROSSCHECK_CACHE) return path.resolve(process.env.LS_CROSSCHECK_CACHE);
  const xdg = process.env.XDG_CACHE_HOME;
  return path.join(xdg ? path.resolve(xdg) : path.join(homedir(), ".cache"), "ls-crosscheck", "cases");
}

export function issueId(target: string, category: IssueCategory, args: Encoded): string {
  return createHash("sha256")
    .update(target).update("\0").update(category).update("\0").update(JSON.stringify(args))
    .digest("hex").slice(0, 10);
}

export async function saveCase(stored: StoredCase): Promise<void> {
  const root = cacheRoot();
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, `${stored.id}.json`), `${JSON.stringify(stored, null, 2)}\n`);
}

export async function loadCase(id: string): Promise<StoredCase> {
  if (!/^[a-f0-9]{10}$/.test(id)) throw new Error(`invalid replay id: ${id}`);
  const parsed = JSON.parse(await readFile(path.join(cacheRoot(), `${id}.json`), "utf8")) as StoredCase;
  if (parsed.schema !== "ls-crosscheck.case/v1" || parsed.id !== id) throw new Error(`invalid replay case ${id}`);
  return parsed;
}
