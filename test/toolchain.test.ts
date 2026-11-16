import assert from "node:assert/strict";
import test from "node:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { compatibleDafnyVersion, verifyAndInspect } from "../src/toolchain.js";

test("Dafny 4.11 patch releases are supported", () => {
  assert.equal(compatibleDafnyVersion("4.11.0"), true);
  assert.equal(compatibleDafnyVersion(" 4.11.3\n"), true);
  assert.equal(compatibleDafnyVersion("4.11.0+build.1"), true);
});

test("other Dafny release lines are rejected", () => {
  assert.equal(compatibleDafnyVersion("4.10.0"), false);
  assert.equal(compatibleDafnyVersion("4.12.0"), false);
  assert.equal(compatibleDafnyVersion("5.11.0"), false);
  assert.equal(compatibleDafnyVersion("Dafny 4.11.0"), false);
  assert.equal(compatibleDafnyVersion("unknown"), false);
});

test("verification forwards manifest limits and flags as literal lsc arguments", { skip: process.platform === "win32" }, async t => {
  const root = await mkdtemp(path.join(tmpdir(), "crosscheck-toolchain-"));
  const original = { PATH: process.env.PATH, LEMMASCRIPT: process.env.LEMMASCRIPT };
  t.after(async () => {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  });
  const source = path.join(root, "source.ts");
  await writeFile(source, "export function constant() { return 1; }");
  await writeFile(path.join(root, "source.dfy"), "function constant(): int { 1 }");
  await writeFile(path.join(root, "lsc"), `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === 'version') console.log('0.6.10');
else if (args[0] === 'info') console.log(JSON.stringify({schema: 1, dafny: {}}));
else if (args[0] === 'check') fs.writeFileSync(${JSON.stringify(path.join(root, "args.json"))}, JSON.stringify(args));
else process.exit(1);
`);
  await writeFile(path.join(root, "dafny"), "#!/usr/bin/env node\nconsole.log('4.11.0');\n");
  await chmod(path.join(root, "lsc"), 0o755);
  await chmod(path.join(root, "dafny"), 0o755);
  process.env.PATH = `${root}${path.delimiter}${original.PATH ?? ""}`;
  delete process.env.LEMMASCRIPT;
  await verifyAndInspect(source, 10_000, { timeLimit: 500, extraFlags: "--isolate-assertions --cores 1" });
  assert.deepEqual(JSON.parse(await readFile(path.join(root, "args.json"), "utf8")), [
    "check", "--backend=dafny", source, "--time-limit=500", "--extra-flags=--isolate-assertions --cores 1",
  ]);
});
