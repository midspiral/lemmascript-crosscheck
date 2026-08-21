# Tutorial: from a verified function to runtime evidence

LemmaScript Crosscheck checks whether executable TypeScript or JavaScript behaves like the mathematical model that LemmaScript verified. This tutorial builds a tiny verified function, finds a real JavaScript precision counterexample, replays it, repairs it, and then follows the audit through the implementation.

The important distinction is:

```text
LemmaScript proof                         Crosscheck audit
-----------------                        ----------------
The Dafny model satisfies its contract.  The JavaScript export is compared with that model.
```

Crosscheck does not turn sampled testing into another proof. A counterexample conclusively demonstrates a transfer problem; a clean sampled run is useful evidence, with its case count and seed stated explicitly.

## Prerequisites

You need:

- Node.js 22 or newer;
- LemmaScript 0.6.x, with `lsc` on `PATH`; and
- Dafny 4.11.x, with `dafny` on `PATH`.

For a small local project, install the npm tools like this:

```sh
mkdir crosscheck-tutorial
cd crosscheck-tutorial
npm init -y
npm install --save-dev lemmascript@^0.6.0 lemmascript-crosscheck
```

Confirm the three toolchains before continuing:

```sh
node --version
npx lsc version
dafny --version
npx lemmascript-crosscheck --version
```

The rest of the tutorial uses `npx` so it runs the versions installed in this project. If you installed both npm CLIs globally, omit `npx`.

## 1. Write a verified function

Create `increment.ts`:

```ts
//@ backend dafny

export function increment(x: number): number {
  //@ verify
  //@ ensures \result === x + 1
  return x + 1
}
```

There are two readings of this file:

- LemmaScript sees `//@ backend dafny`, translates the verified function into a Dafny model, and proves that its exact result is `x + 1`.
- Node executes the exported TypeScript function using JavaScript `number` arithmetic.

Those readings look equivalent for small integers. They are not equivalent at every JavaScript integer boundary.

## 2. Run the first audit

Ask Crosscheck for at most 40 proof-valid executions of `increment`:

```sh
npx lemmascript-crosscheck increment.ts --only increment --cases 40
```

The first run may create `increment.dfy.gen` and `increment.dfy` beside the source. These are the normal LemmaScript Dafny artifacts; the source directory therefore needs to be writable.

The audit finds this counterexample:

```text
increment — ISSUE FOUND
Result differs because JavaScript integer arithmetic lost precision.

Input
  x           9007199254740992

Result
  verified    9007199254740993
  JavaScript  9007199254740992

Cause
  The verified model uses exact integers, while this TypeScript result is represented by an IEEE-754 number.

Resolve
  Use bigint, or prove that every input, intermediate, and result remains exact as a JavaScript number.

Replay
  lemmascript-crosscheck /absolute/path/increment.ts --replay 58fb6d7e39

Evidence: replayed counterexample · Dafny 4.11.0 model
```

The path in your replay command will differ. This command exits with status `1` because it found an issue; that is expected, not a CLI crash.

## 3. Read the counterexample

`9007199254740992` is `2^53`. That input itself is exactly representable as a JavaScript `number`, so Crosscheck can faithfully pass the same value to both implementations. The difference appears in the addition:

| | Verified model | JavaScript runtime |
| --- | --- | --- |
| Input | exact integer `9007199254740992` | exactly represented `number` |
| Operation | mathematical integer addition | IEEE-754 binary64 addition |
| Result | `9007199254740993` | rounded to `9007199254740992` |

The proof has not failed: the Dafny model really does return the exact sum and satisfies its postcondition. What failed is the transfer from that model to JavaScript's runtime representation. This is the gap Crosscheck is designed to expose.

Crosscheck starts with exact formal values. It only converts a value to a runtime representation after evaluating the verified preconditions. That ordering matters: it prevents JavaScript rounding from erasing the witness before the comparison begins.

## 4. Replay the saved witness

Use the ID printed by your run:

```sh
npx lemmascript-crosscheck increment.ts --replay 58fb6d7e39
```

Crosscheck saves the minimized input, source and runtime entry paths and hashes, target, and runtime export mapping in its case cache. Replay verifies the source again, checks that both content hashes are unchanged, and executes that one recorded input instead of generating a new sample.

The default case directory is `$XDG_CACHE_HOME/lemmascript-crosscheck/cases`, or `~/.cache/lemmascript-crosscheck/cases` when `XDG_CACHE_HOME` is unset. Set `LEMMASCRIPT_CROSSCHECK_CACHE` when you want an isolated or shared cache location.

## 5. Repair the representation

One repair is to use exact JavaScript `bigint` values. Keep the two experiments side by side by creating `increment-bigint.ts`:

```ts
//@ backend dafny

export function incrementBig(x: bigint): bigint {
  //@ verify
  //@ ensures \result === x + 1n
  return x + 1n
}
```

Run it with an explicit seed:

```sh
npx lemmascript-crosscheck increment-bigint.ts \
  --only incrementBig --cases 40 --seed 7
```

The result is:

```text
incrementBig — NO ISSUE FOUND
Evidence: 40 sampled proof-valid inputs · seed 7 · not a proof
```

`bigint` removes this particular representation gap, but the report deliberately says `not a proof`. It means only that no disagreement appeared in the 40 displayed executions. Reusing seed `7` reproduces the generated candidate order; replaying a saved issue is stronger because it runs its exact witness.

Another valid design is to retain `number` while placing a verified bound on every input, intermediate value, and result. A runtime guard by itself is not enough—the safe domain must be part of what is proved and audited.

If you edit a source after LemmaScript sidecars already exist, update them with the normal LemmaScript regeneration workflow before auditing again:

```sh
npx lsc regen --backend=dafny increment.ts
npx lemmascript-crosscheck increment.ts --only increment
```

Crosscheck runs LemmaScript's checking workflow. It does not silently merge a changed translation into a `.dfy` file that may contain hand-written proof additions.

## 6. Audit the code you deploy

Without `--runtime`, the source file has two roles: it supplies the verified formal target and it is imported as the runtime module. This source-runtime audit is convenient while developing.

For a production check, keep the proof source on the left and point Crosscheck at the built JavaScript on the right:

```sh
npx lemmascript-crosscheck src/counter.ts \
  --runtime dist/counter.js \
  --only increment
```

If the deployed export has a different name, map the formal name to it:

```sh
npx lemmascript-crosscheck src/counter.ts \
  --runtime dist/api.js \
  --only increment \
  --entry increment=incrementRuntime
```

The formal model and its preconditions still come from `src/counter.ts`; only the runtime worker imports `dist/api.js`. `--entry` is repeatable when several exports were renamed.

Cases found against an alternate runtime restore it automatically, and the generated replay command includes it explicitly:

```sh
npx lemmascript-crosscheck src/counter.ts \
  --runtime dist/api.js \
  --replay <id>
```

If the same built module moved, replace the `--runtime` path; Crosscheck accepts the relocation only when the entry file's hash still matches the recorded runtime.

Runtime modules execute as code. The workers isolate them from the CLI process for failures and deadlines, but they are not security sandboxes; audit only code you trust.

## What Crosscheck does under the hood

Every audit follows the same path:

```text
verified TypeScript
       |
       +--> typed metadata and verified preconditions
       |
       +--> checked Dafny artifact --> compiled executable model
                                           |
exact input generation --> precondition filter --> representation bridge
                                           |
                         +-----------------+-----------------+
                         |                                   |
                    model worker                        runtime worker
                         |                                   |
                         +---------- compare ----------------+
                                           |
                                  shrink, save, replay
```

In more detail:

1. Crosscheck checks the LemmaScript and Dafny versions, asks LemmaScript for typed metadata, and runs the normal Dafny-backed verification.
2. It hashes the source and verified `.dfy` artifact, then compiles that already-verified artifact into an executable JavaScript form of the Dafny model. Compiled models are cached by their relevant inputs.
3. It selects exported verified targets, recursively checks that their parameter and result types are supported, and resolves any `--entry` mappings.
4. It generates deterministic edge cases plus pseudorandom values in the exact formal domain. Verified `requires` expressions are evaluated before runtime conversion; candidates that do not satisfy them are skipped.
5. The representation bridge converts proof-valid inputs without silently losing information. A valid formal input with no faithful JavaScript representation becomes an `input-domain` issue rather than a lossy call.
6. Separate child processes execute the compiled model and the runtime export with a per-call deadline. A timed-out runtime worker is killed and replaced before later calls.
7. Crosscheck compares exact results and selected observable effects. When it finds a mismatch, it shrinks the arguments when that category can be safely minimized, reruns the witness, and saves it for deterministic replay.

`--cases` counts successful, proof-valid, representable executions per target. It is not a count of raw generated candidates: precondition-invalid candidates and unrepresentable values do not consume that execution budget. A run can therefore display fewer executions than requested if the generator cannot discover enough valid inputs.

## What is compared

For each executed input, Crosscheck observes more than the return value:

- the exact model result versus the runtime result;
- caller-visible arguments before and after the call;
- absent optional properties versus properties present with `undefined`;
- console and direct standard output produced during the call;
- runtime exceptions; and
- runtime termination within the configured timeout.

The first stable mismatch is reported. Unsupported types, unsupported precondition semantics, async targets, tool failures, or an unusable runtime export produce `NOT CHECKED` instead of a misleading compatibility claim.

## Conclusions, JSON, and CI

The three conclusions have intentionally different strength:

| Conclusion | Meaning | Exit code |
| --- | --- | ---: |
| `ISSUE FOUND` | A replayed counterexample demonstrates disagreement. | `1` |
| `NO ISSUE FOUND` | No disagreement appeared within the stated scope. | `0` |
| `NOT CHECKED` | Crosscheck could not make the comparison. | `2` |

Exit code `2` takes precedence in a multi-target run. Zero-argument targets have one exhaustive input tuple; other clean runs are described as sampled and explicitly say `not a proof`.

Use `--json` for automation:

```sh
npx lemmascript-crosscheck src/counter.ts \
  --runtime dist/counter.js \
  --cases 100 --seed 17 --json > crosscheck-report.json
```

The output uses the stable `lemmascript-crosscheck.report/v1` schema, and the same exit-code policy still applies. In CI, run Crosscheck after building the runtime module so a finding or an incomplete audit fails the job.

## Working from source checkouts

A source checkout is a local Git clone rather than an npm installation. If this repository and LemmaScript are sibling directories, build Crosscheck and select the sibling LemmaScript checkout with `LEMMASCRIPT`:

```text
parent/
├── LemmaScript/
└── lemmascript-crosscheck/
```

```sh
npm install
npm run build

LEMMASCRIPT=../LemmaScript \
  node dist/src/cli.js ../LemmaScript/examples/arraySum.ts \
  --only arraySum --cases 40
```

`LEMMASCRIPT` must name the clone root containing `package.json` and `tools/`. Install the LemmaScript checkout's dependencies first. Leave the variable unset when a compatible npm-installed `lsc` is already on `PATH`. The [README source-checkout section](README.md#using-a-lemmascript-source-checkout) explains the distinction in more detail.

Once the first example makes sense, the sibling LemmaScript fixtures provide focused experiments:

- `examples/arraySum.ts` finds integer-result precision loss;
- `examples/division.ts` contrasts exact rationals with binary floating point;
- `examples/nestedPush.ts` exposes caller-visible mutation;
- `examples/spreadMerge.ts` distinguishes omission from present `undefined`; and
- `examples/bigintBits.ts` demonstrates sampled agreement with exact `bigint` operations.

For the complete option reference and supported type list, see [README.md](README.md). Developers can continue with the practical codebase guide in [TUTORIAL_DEV.md](TUTORIAL_DEV.md); the authoritative implementation contract and component boundaries are in [DESIGN.md](DESIGN.md).
