# LemmaScript Crosscheck

Counterexample-driven runtime transfer checking for [LemmaScript](https://github.com/midspiral/LemmaScript).

LemmaScript proves properties about a mathematical model of a TypeScript program. Crosscheck asks the next question: does the executable TypeScript still behave like that verified model under JavaScript semantics?

```text
LemmaScript source ──verify──> compiled Dafny model
        │                           │
        └──── execute in Node ──────┴── compare results and effects
```

Crosscheck generates proof-valid inputs, runs the verified model and the JavaScript export in isolated workers, and compares their observable behavior. When they disagree, it shrinks the input when appropriate and saves a deterministic replay case.

It currently finds:

- integer precision, formal-input representation gaps, and result-changing input rounding;
- exact-real versus binary floating-point differences;
- ordinary result mismatches;
- caller-visible input mutation;
- omitted properties versus properties set to `undefined`;
- unexpected console or standard output, exceptions, and timeouts.

## Status

This is an early Dafny-only implementation. It requires LemmaScript 0.6.x and audits synchronous, exported targets with supported value types. A `NO ISSUE FOUND` result over sampled inputs is evidence within the displayed case count and seed; it is not a proof that the verified model and JavaScript agree for every input.

## Installation

Crosscheck requires:

- Node.js 22 or newer;
- LemmaScript 0.6.x, either installed so `lsc` is on `PATH` or available as a local Git clone selected with `LEMMASCRIPT`; and
- Dafny 4.11.x as `dafny` on `PATH`.

Install the two npm CLIs globally:

```sh
npm install --global lemmascript@^0.6.0 lemmascript-crosscheck
lemmascript-crosscheck --version
```

Or add them to a project and run Crosscheck through `npx`:

```sh
npm install --save-dev lemmascript@^0.6.0 lemmascript-crosscheck
npx lemmascript-crosscheck path/to/file.ts
```

LemmaScript is an optional peer dependency because Crosscheck can use either the npm-installed CLI or a local clone of the LemmaScript repository. Dafny is an external tool and must be installed separately. Crosscheck checks both tool versions before running an audit.

## Quick start

Audit a verified source file directly:

```sh
lemmascript-crosscheck path/to/file.ts --only exportedFunction --cases 40
```

An audit performs a normal LemmaScript check, so it may refresh generated Dafny sidecars next to the source before Crosscheck executes the model.

For a guided end-to-end example—from writing a verified function through finding, replaying, and repairing a JavaScript counterexample—see [TUTORIAL.md](TUTORIAL.md).

## Using a LemmaScript source checkout

A source checkout is a local Git clone of the LemmaScript repository, containing its source code and development tools. It is different from installing the published `lemmascript` package from npm. Use a checkout when developing LemmaScript itself, testing unpublished LemmaScript changes, or running the examples stored in its repository.

Set `LEMMASCRIPT` to the root of that clone—the directory containing LemmaScript's `package.json` and `tools/` directory. Crosscheck will run the development `lsc` from there instead of looking for an installed `lsc` on `PATH`. Run `npm install` in the LemmaScript checkout first so its development dependencies are available.

The sample runs below use sibling Crosscheck and LemmaScript checkouts:

```text
parent/
├── LemmaScript/
└── lemmascript-crosscheck/
```

Install dependencies, build the CLI, and audit LemmaScript's `arraySum` example:

```sh
npm install
npm run build
LEMMASCRIPT=../LemmaScript \
  node dist/src/cli.js ../LemmaScript/examples/arraySum.ts \
  --only arraySum --cases 40
```

Leave `LEMMASCRIPT` unset when LemmaScript was installed from npm and a compatible `lsc` is already on `PATH`.

## Sample runs

### A JavaScript integer-precision counterexample

Running [LemmaScript's `arraySum.ts`](https://github.com/midspiral/LemmaScript/blob/main/examples/arraySum.ts) produces a small, replayable witness:

```text
arraySum — ISSUE FOUND
Result differs because JavaScript integer arithmetic lost precision.

Input
  arr         [9007199254740991, 2]

Result
  verified    9007199254740993
  JavaScript  9007199254740992

Cause
  The verified model uses exact integers, while this TypeScript result is represented by an IEEE-754 number.

Resolve
  Use bigint, or prove that every input, intermediate, and result remains exact as a JavaScript number.

Replay
  lemmascript-crosscheck ../LemmaScript/examples/arraySum.ts --replay 9d3caf14a5

Evidence: replayed counterexample · Dafny 4.11.0 model
```

Both array elements are representable JavaScript integers, but their sum is not. The verified model returns the exact mathematical integer while JavaScript rounds it.

### Input rounding before the function starts

The `binarySearch.ts` fixture exposes a different failure: the arithmetic in the function need not lose precision because an argument has already been rounded at the JavaScript boundary.

```sh
LEMMASCRIPT=../LemmaScript node dist/src/cli.js \
  ../LemmaScript/examples/binarySearch.ts --only binarySearch --cases 40 --details
```

```text
binarySearch — ISSUE FOUND
JavaScript input rounding changes the result.

Formal input
  arr         [9007199254740992]
  target      9007199254740993

JavaScript representation
  arr         [9007199254740992]
  target      9007199254740992

Precision loss
  target      9007199254740993 → 9007199254740992

Result
  verified    -1
  JavaScript  0
```

No fractional literal is involved. Every ordinary JavaScript `number` uses IEEE-754 binary64, including integer-looking values, and it has only 53 bits of integer precision. By the time `binarySearch` evaluates `arr[mid] === target`, the two distinct formal integers have become the same JavaScript number. Crosscheck finds this with a general type-directed numeric projection probe, not a binary-search or equality-operator special case.

### Exact `bigint` operations

The same audit over [LemmaScript's `bigintBits.ts`](https://github.com/midspiral/LemmaScript/blob/main/examples/bigintBits.ts) finds no mismatch in 40 generated inputs per target:

```sh
LEMMASCRIPT=../LemmaScript \
  node dist/src/cli.js ../LemmaScript/examples/bigintBits.ts \
  --cases 40 --details
```

```text
shiftWide — NO ISSUE FOUND
Evidence: 40 sampled proof-valid inputs · seed 17 · not a proof

low64 — NO ISSUE FOUND
Evidence: 40 sampled proof-valid inputs · seed 17 · not a proof
```

Other useful fixtures in `../LemmaScript/examples` include:

- `binarySearch.ts`, which exposes distinct exact integer inputs collapsing to the same JavaScript number;
- `division.ts`, which contrasts exact rational results with JavaScript binary64 values;
- `nestedPush.ts`, which exposes caller-visible array mutation absent from the model;
- `spreadMerge.ts`, which exposes omitted versus present-`undefined` properties.

For example:

```sh
LEMMASCRIPT=../LemmaScript node dist/src/cli.js \
  ../LemmaScript/examples/division.ts --cases 40 --details

LEMMASCRIPT=../LemmaScript node dist/src/cli.js \
  ../LemmaScript/examples/nestedPush.ts --only pushItem --cases 30

LEMMASCRIPT=../LemmaScript node dist/src/cli.js \
  ../LemmaScript/examples/spreadMerge.ts --only withDefaults --cases 40
```

## Usage

```text
lemmascript-crosscheck <source.ts> [options]

  --only <name>          Check one exported verified function
  --runtime <module>     Execute a deployed module instead of the source
  --entry A=B            Map formal target A to runtime export B
  --cases <count>        Proof-valid executions per target (default: 100)
  --seed <integer>       Deterministic generation seed (default: 17)
  --timeout <ms>         Per-call worker deadline (default: 2000)
  --verify-timeout <ms>  LemmaScript/Dafny deadline (default: 300000)
  --replay <id>          Replay a saved counterexample
  --details              Expand every target in a multi-target file
  --json                 Emit the stable machine report
  --help                 Show help
  --version              Show the version
```

By default, the source file is also the runtime module. To audit built or deployed code, provide its module and optionally map a formal function name to a differently named runtime export:

```sh
lemmascript-crosscheck src/search.ts --runtime dist/search.js

lemmascript-crosscheck src/search.ts \
  --runtime dist/api.js \
  --only binarySearch \
  --entry binarySearch=search
```

All exported targets are checked unless `--only` selects one. Multi-target runs use a compact summary by default; `--details` renders each complete finding.

## Reports and exit codes

Crosscheck separates its conclusion from the strength of its evidence:

| Conclusion | Meaning |
| --- | --- |
| `ISSUE FOUND` | A replayed counterexample demonstrates a model/runtime disagreement. |
| `NO ISSUE FOUND` | No disagreement appeared in the stated sampled or exhaustive scope. |
| `NOT CHECKED` | Unsupported semantics or a tool/runtime failure prevented a comparison. |

| Exit code | Meaning |
| ---: | --- |
| `0` | Every target reports `NO ISSUE FOUND`. |
| `1` | At least one target reports `ISSUE FOUND`. |
| `2` | At least one target reports `NOT CHECKED`; this takes precedence over exit code 1. |

Use `--json` for the stable `lemmascript-crosscheck.report/v1` machine-readable report.

## Replaying a counterexample

Every issue is saved under a stable ten-character ID derived from the source and runtime contents, target mapping, category, and minimized witness. Crosscheck prints a complete replay command:

```sh
lemmascript-crosscheck ../LemmaScript/examples/arraySum.ts \
  --replay 9d3caf14a5
```

Replay checks that neither the source nor runtime entry module has changed, restores the recorded runtime path, target, and export mapping, and runs the saved input again. Commands for deployed modules include `--runtime` explicitly. If an unchanged runtime module moved, replace that path in the replay command; its content hash must still match. Cases are stored in `$XDG_CACHE_HOME/lemmascript-crosscheck/cases`, or `~/.cache/lemmascript-crosscheck/cases` when `XDG_CACHE_HOME` is unset. Set `LEMMASCRIPT_CROSSCHECK_CACHE` to choose another location.

Compiled Dafny models are cached under the operating system's temporary directory. Set `LEMMASCRIPT_CROSSCHECK_BUILD_CACHE` to choose another build-cache location.

## Current scope

Crosscheck supports booleans, `number`- and `bigint`-backed integers, exact formal reals, strings, arrays, tuples, sets, maps, optionals, records, string unions, aliases, and discriminated unions where their nested fields are also supported.

Targets currently report `NOT CHECKED` when they require unsupported behavior such as:

- a Lean backend;
- async functions;
- generic targets or generic user-defined types;
- recursive or opaque user-defined types;
- function-typed or unresolved values;
- `void` results;
- `havoc`, `assume`, or other nondeterministic model behavior;
- preconditions outside the implemented typed-expression evaluator.

## How an audit works

For each selected target, Crosscheck:

1. asks LemmaScript for typed metadata and verifies the source with the Dafny backend;
2. compiles the verified Dafny artifact into an executable model;
3. generates exact formal values and retains inputs satisfying the verified preconditions;
4. checks whether those values can be represented by the TypeScript signature;
5. executes the model and runtime in separate workers;
6. compares exact results, argument mutation, console and standard output, exceptions, and termination;
7. shrinks and replays the first mismatch when appropriate, then saves a deterministic replay case.

This independently tests transfer from the verified formal semantics to the executable JavaScript semantics. It does not replace LemmaScript's proof or prove the translator correct.

## Development

```sh
npm test
npm run typecheck
npm run build
```

The implementation lives in `src/`, with focused unit tests in `test/`. Start with [TUTORIAL_DEV.md](TUTORIAL_DEV.md) for a guided codebase tour and a worked example of adding an issue category. The authoritative architecture and design decisions are documented in [DESIGN.md](DESIGN.md); the exact operational procedure, including generation and finding precedence, is in [ALGORITHM.md](ALGORITHM.md).
