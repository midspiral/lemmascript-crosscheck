import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runCommand } from "./command.js";
import { hashFile } from "./toolchain.js";

export interface CompiledModel {
  modulePath: string;
  artifactHash: string;
}

const packageRoot = findPackageRoot(path.dirname(fileURLToPath(import.meta.url)));

function findPackageRoot(from: string): string {
  let directory = from;
  while (true) {
    const manifestPath = path.join(directory, "package.json");
    if (existsSync(manifestPath)) {
      try {
        const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { name?: unknown };
        if (manifest.name === "lemmascript-crosscheck") return directory;
      } catch {
        // Keep searching when an ancestor has an unreadable or invalid manifest.
      }
    }
    const parent = path.dirname(directory);
    if (parent === directory) throw new Error("could not locate the lemmascript-crosscheck package root");
    directory = parent;
  }
}

export async function compileVerifiedDafny(
  artifact: string,
  expectedHash: string,
  dafnyVersion: string,
  timeoutMs = 180_000,
): Promise<CompiledModel> {
  const text = await readFile(artifact, "utf8");
  const artifactHash = await hashFile(artifact);
  if (artifactHash !== expectedHash) throw new Error("verified Dafny artifact changed before compilation");

  const bignumber = createRequire(import.meta.url).resolve("bignumber.js");
  const key = dafnyBuildCacheKey(text, bignumber, dafnyVersion);
  const cache = process.env.LEMMASCRIPT_CROSSCHECK_BUILD_CACHE
    ? path.resolve(process.env.LEMMASCRIPT_CROSSCHECK_BUILD_CACHE)
    : path.join(tmpdir(), "lemmascript-crosscheck-build");
  await mkdir(cache, { recursive: true });
  const modulePath = path.join(cache, `model-${key}.cjs`);
  if (existsSync(modulePath)) return { modulePath, artifactHash };

  const outputBase = path.join(cache, `dafny-${key}`);
  const args = [
    "build", "-t", "js", "--no-verify", "--allow-warnings",
    "--optimize-erasable-datatype-wrapper", "false",
  ];
  if (text.includes("Std.")) args.push("--standard-libraries");
  args.push("-o", outputBase, artifact);
  await runCommand({ command: "dafny", args, cwd: packageRoot, timeoutMs });

  const generatedPath = `${outputBase}.js`;
  let generated = await readFile(generatedPath, "utf8");
  const dependencyPattern = /require\((["'])bignumber\.js\1\)/;
  if (!dependencyPattern.test(generated)) throw new Error("Dafny JavaScript output has an unknown bignumber.js import shape");
  generated = generated.replace(dependencyPattern, `require(${JSON.stringify(bignumber)})`);
  if (!generated.includes("let _dafny") || !generated.includes("let _module")) {
    throw new Error("Dafny JavaScript output does not expose the expected runtime module shape");
  }
  generated += "\nmodule.exports = { _dafny, _module, BigNumber };\n";
  await writeFile(modulePath, generated);
  if (await hashFile(artifact) !== expectedHash) throw new Error("verified Dafny artifact changed during compilation");
  return { modulePath, artifactHash };
}

export function dafnyBuildCacheKey(artifact: string, bignumber: string, dafnyVersion: string): string {
  return createHash("sha256")
    .update(artifact).update("\0")
    .update(bignumber).update("\0")
    .update(dafnyVersion)
    .digest("hex").slice(0, 20);
}

export function runtimePackageRoot(): string {
  return packageRoot;
}
