# Developer tutorial: tracing and extending Crosscheck

This is the practical guide to the LemmaScript Crosscheck codebase. [DESIGN.md](DESIGN.md) remains the authoritative behavioral contract, while [ALGORITHM.md](ALGORITHM.md) gives the exact current search and comparison procedure. This tutorial explains how to read, run, test, and safely extend the implementation.

To contribute a counterexample, start with [Add a known soundness issue](#add-a-known-soundness-issue). Most known issues fit an existing category such as `result-mismatch`; their specific cause belongs in the fixture explanation.

The [soundness issue catalog](SOUNDNESS_ISSUES.md) inventories the collected causes, every report category, and the evidence behind each detector. The [example walkthroughs](examples/README.md) explain the verified and runtime behavior of each program.

## How hard is a new issue category?

It depends on whether Crosscheck already observes the fact you want to classify:

| Change | Typical scope | Rough effort |
| --- | --- | --- |
| Classify data already in a worker response | `report-types.ts`, `audit.ts`, `cases.ts`, tests, documentation | A few focused hours |
| Capture a new runtime observation | Runtime worker protocol, audit engine, report shape/rendering, replay, tests | Roughly half a day to a day |
| Add a new formal value or precondition construct | Typed metadata, generator, bridge, Dafny marshalling, evaluator, shrinker, tests | Multiple days, sometimes with a LemmaScript change |
| Model async, concurrency, filesystem, network, or other ambient effects | Execution and semantic model redesign | Architectural work |

The string added to `IssueCategory` is the easy part. The real work is deciding:

- exactly what counts as a mismatch;
- where it sits in issue precedence;
- what evidence makes it replayable;
- whether shrinking is sound for it;
- how it affects the stable JSON and saved-case schemas; and
- what a user should do about it.

The worked example later in this tutorial adds a hypothetical `negative-zero-result` category. Crosscheck already preserves JavaScript `-0`, so no worker or codec change is needed; this is the easiest extension tier.

## Set up a development checkout

Install dependencies and run the normal gates:

```sh
npm install
npm run typecheck
npm test
npm run build
npm pack --dry-run
```

Tests use Node's built-in test runner through `tsx`. Run one subsystem while iterating:

```sh
node --import tsx --test test/audit.test.ts
node --import tsx --test test/runtime-worker.test.ts
```

You can run the TypeScript CLI directly without rebuilding. With sibling Crosscheck and LemmaScript checkouts:

```sh
LEMMASCRIPT=../LemmaScript \
LEMMASCRIPT_CROSSCHECK_CACHE=/tmp/lemmascript-crosscheck-dev-cases \
LEMMASCRIPT_CROSSCHECK_BUILD_CACHE=/tmp/lemmascript-crosscheck-dev-build \
  node --import tsx src/cli.ts ../LemmaScript/examples/arraySum.ts \
  --only arraySum --cases 40 --details
```

The two cache overrides keep experiments separate from normal saved cases and compiled models. There is no `--debug` option. When temporarily instrumenting a worker, write diagnostics to standard error: worker standard output is the JSON-lines protocol.

## Add a known soundness issue

Add a minimal, self-contained TypeScript source in `test/fixtures/` with an exported function that preserves the behavior you want to examine. Include a short explanation of the disagreement and a link to the originating issue or real-code example when available. The existing [integer-precision fixture](test/fixtures/integer-precision.ts) shows the shape:

```ts
//@ ensures \result === x + 1
export function increment(x: number): number {
  return x + 1;
}
```

Add a test in [soundness.test.ts](test/integration/soundness.test.ts) that asserts the observed category and concrete witness. The corresponding integer-precision test is:

```ts
test("integer arithmetic exposes a result mismatch on an exact input", async t => {
  const report = await auditFixture(t, "integer-precision.ts", 1, ["--cases", "40"]);
  assert.equal(report.targets.length, 1);
  const issue = report.targets[0]?.issue;
  assert.equal(issue?.category, "result-mismatch");
  assert.deepEqual(decode(issue!.args), [9_007_199_254_740_992n]);
  assert.equal(issue?.modelResult, "9007199254740993");
  assert.equal(decode(issue!.runtimeResult!), 9_007_199_254_740_992);
});
```

The shared [auditFixture helper](test/integration/harness.ts) copies the source into a temporary directory, verifies it, executes both versions, and replays every reported issue. Its third argument is the expected CLI exit code: `1` for an issue, `0` for no issue found, or `2` for `NOT CHECKED`. The helper currently copies only the TypeScript source, so fixtures should verify from their annotations without handwritten proof companions. Generated Dafny files and saved-case caches stay outside the collection.

If an issue cannot yet reach comparison, assert `NOT CHECKED` and the specific reason, as the helper-call case does. This records a coverage gap. For a positive control, assert both `no-issue` and a nonzero executed case count, as the unchanged closure capture does.

With Dafny 4.11.x installed and a LemmaScript checkout on `main` with its dependencies installed, run:

```sh
LEMMASCRIPT=/absolute/path/to/LemmaScript npm run test:integration
```

The command builds Crosscheck and runs the full issue suite. New cases automatically use the existing **Soundness issues** CI job against LemmaScript `main`. When a compiler fix changes an outcome, keep the example and update its expectations after inspecting the new behavior. A fixture with a deliberately false postcondition may correctly stop at verification once the translation is fixed.

## The four representations

Most subtle bugs come from confusing representations. The same logical value can exist in four forms:

| Representation | Example integer | Owner |
| --- | --- | --- |
| Formal value | `9007199254740993n` | `generate.ts`, `spec.ts`, `rational.ts` |
| JavaScript runtime value | rounded `9007199254740992` or exact `bigint` | `bridge.ts`, `runtime-worker.ts` |
| Wire value | `{ "$": "bigint", "value": "9007199254740993" }` | `codec.ts` |
| Dafny runtime value | Dafny-generated `BigNumber`/datatype objects | `dafny-runtime.ts`, `model-worker.ts` |

The central invariant is: generate and filter exact formal values first, then ask whether they have a faithful JavaScript representation. Do not move a coercion earlier merely because it simplifies a type signature. Doing so can erase the exact witness Crosscheck exists to find.

The tagged wire encoding also preserves values plain JSON loses: `bigint`, exact rationals, `undefined`, `-0`, non-finite numbers, sparse arrays, sets, and maps. Its deterministic object-key ordering feeds deduplication, mutation comparison, shrinking, saved cases, and issue IDs. A codec change therefore has a much larger compatibility surface than it first appears.

## Codebase map

Start with [`src/audit.ts`](src/audit.ts); it is the orchestration center. Read the surrounding files according to the question you are asking:

| Area | Files | Responsibility |
| --- | --- | --- |
| Public contracts | `ir.ts`, `report-types.ts` | LemmaScript typed-info shape and stable report types |
| Exact transport | `rational.ts`, `codec.ts` | Exact values, deterministic encoding, equality, display |
| Verification | `toolchain.ts`, `command.ts` | Tool versions, typed metadata, LemmaScript/Dafny verification, subprocess errors |
| Model build | `dafny-build.ts`, `dafny-runtime.ts` | Cached Dafny-to-JavaScript compilation and value marshalling |
| Candidate semantics | `generate.ts`, `spec.ts`, `runtime-spec.ts`, `bridge.ts` | Formal and runtime inputs, verified preconditions, JavaScript contracts, and domain bridges |
| Execution | `workers.ts`, `json-line-client.ts`, `model-worker.ts`, `runtime-worker.ts` | Process lifecycle, protocol, timeouts, model and runtime calls |
| Findings | `audit.ts`, `shrink.ts`, `cases.ts` | Classification, precedence, minimization, IDs, persistence, replay |
| Interface | `report.ts`, `cli.ts` | Human/JSON output, options, progress, exit policy |

The imports use `.js` suffixes because the project compiles as Node ESM. `tsx` resolves them back to TypeScript during development.

## Trace one CLI request

The main call path is:

```text
cli.main
  -> auditFile
       -> verifyAndInspect
       -> compileVerifiedDafny
       -> startWorkers
       -> auditTarget, once per selected function
            -> contract: runtimeCandidateCases
               -> satisfiesRuntimePreconditions
               -> runtime worker call
               -> checkRuntimePostconditions + runtimeDomainFailure
            -> differential: candidateCases
               -> satisfiesPreconditions
               -> encodeRuntime
               -> runtime worker call
               -> model worker call and exact comparison
            -> shrinkArgs
            -> saveCase
  -> renderReport or JSON.stringify
  -> exitCode
```

### 1. CLI and fatal policy

[`src/cli.ts`](src/cli.ts) parses options, loads a replay case when requested, builds `AuditOptions`, and owns process exit status. Fatal `--json` failures still become complete `lemmascript-crosscheck.report/v1` target reports; human mode uses `renderFatal`.

The CLI deliberately keeps `NOT CHECKED` distinct from `ISSUE FOUND`. Exit code `2` takes precedence over `1` in mixed runs because an incomplete audit must not look like a complete compatibility result.

### 2. Verification and artifact identity

[`src/toolchain.ts`](src/toolchain.ts) runs four external operations:

```text
lsc version
lsc info --typed <source>
dafny --version
lsc check --backend=dafny <source>
```

It accepts LemmaScript 0.6.x typed-info schema 1 and Dafny 4.11.x, rejects Lean for executable crosschecking, hashes the source before and after verification, and hashes the adjacent checked `.dfy` artifact.

[`src/dafny-build.ts`](src/dafny-build.ts) compiles that already-verified artifact with `dafny build -t js --no-verify`. Its cache key includes the artifact contents, resolved `bignumber.js`, and exact Dafny version. Hash checks before and after compilation guard against compiling an artifact different from the one just verified.

### 3. Target support and candidates

[`auditTarget`](src/audit.ts) first rejects unsupported target shapes. [`src/generate.ts`](src/generate.ts) then builds a deterministic baseline, type-specific edges, single-parameter changes, bounded pairwise combinations, and seeded random values.

[`src/spec.ts`](src/spec.ts) evaluates each typed `requires` expression using exact integers and rationals. Calls to known verified functions can be delegated to the model worker. An unsupported expression produces `NOT CHECKED`; it is never guessed true or silently discarded.

For every proof-valid candidate, [`src/bridge.ts`](src/bridge.ts) returns either:

- a faithful runtime value; or
- a structured failure containing the formal path, reason, and exact value.

The second result is a possible `input-domain` witness. Crosscheck remembers it while continuing to look for an executed runtime mismatch, which has higher reporting priority.

There is one deliberate exception to “do not coerce early”: a numeric projection probe starts with an exact, already validated formal input, converts only finite number-backed numeric sites with JavaScript's real `Number(...)` semantics, and records every changed path. The verified model still receives the exact tuple. Crosscheck reports `input-representation-mismatch` only when the projected JavaScript call returns a different result. Type-directed single-site and paired `2^53`/`2^53 + 1` variants make this a general representation check; it does not scan for `==`, `===`, or a particular algorithm.

### 4. Two workers, one protocol

[`src/workers.ts`](src/workers.ts) starts separate model and runtime child processes. [`src/json-line-client.ts`](src/json-line-client.ts) assigns request IDs, enforces deadlines, and recreates a worker after process-level failure or timeout.

The model worker invokes the compiled Dafny function. When it receives a runtime result, it marshals that value back into the corresponding Dafny type and performs equality in model space.

The runtime worker imports TypeScript through `tsx`, invokes a synchronous export, and returns:

- the encoded result;
- encoded arguments before and after the call;
- captured console and direct standard output; or
- a structured throw/unsupported response.

The protocol objects are currently `Record<string, unknown>`, not a shared discriminated TypeScript message union. This keeps the boundary small, but the compiler cannot catch a worker field renamed on only one side. Protocol tests are mandatory when changing a request or response shape.

Worker stdout must contain only JSON response lines. The runtime worker keeps module-import output away from that channel and captures output only during the call. Neither worker is a security sandbox.

### 5. The classification state machine

The nested `evaluate` function in [`src/audit.ts`](src/audit.ts) turns one formal argument tuple into one of five outcomes:

```text
invalid          precondition is false; skip candidate
unrepresentable  precondition is true, but the runtime bridge is lossy
clean            model and observed runtime behavior agree
issue            a concrete model/runtime disagreement exists
not-checked      comparison could not be completed faithfully
```

For an executed call, current issue precedence is approximately:

1. runtime timeout, if the model returns;
2. runtime throw, if the model returns;
3. unequal model and runtime results;
4. optional-property presence dependence;
5. caller-visible input mutation;
6. captured output; and
7. clean agreement.

Runtime/model failures that prevent comparison become `NOT CHECKED`. A remembered formal-only `input-domain` witness is reported only when no executed issue or incomplete comparison took precedence.

An observed numeric-projection result mismatch is remembered rather than returned immediately. This lets a later issue on faithfully represented inputs take precedence. If the main search finishes, the projection mismatch outranks the weaker domain-only witness.

This ordering is product behavior. Adding a check above result comparison can hide an ordinary wrong result; adding it below output can make it practically unreachable. Choose and test the position deliberately.

### 6. Shrinking, IDs, and replay

[`src/shrink.ts`](src/shrink.ts) proposes deterministic reductions and asks the audit relation whether each candidate still produces the same category. It does not know issue semantics itself.

Most executable findings use the generic shrink loop. `optional-presence` and `input-representation-mismatch` retain paired model/runtime representations, and `runtime-timeout` is intentionally not shrunk because the timed-out worker was killed and timing is stateful. A new category must explicitly decide whether the generic relation is safe.

`input-domain` findings retain the original precondition-valid arguments and bridge failure without shrinking. The generic shrinker can invalidate a union member or tuple shape; accepting any subsequent bridge failure would report that malformed value as a counterexample. These findings are saved and replayed with their original arguments.

[`src/cases.ts`](src/cases.ts) derives the ten-character ID from the source and runtime entry hashes, target and runtime export, category, and encoded witness. Saved cases include both paths and hashes plus the arguments and representation variant when needed. Replay restores the recorded runtime automatically, prints alternate runtimes explicitly, and rejects changed source or runtime contents. A byte-identical module may be replayed from a new path.

Changing category assignment changes issue IDs. Adding a category is also visible in the stable report v1 and case v2 formats; treat schema compatibility as part of the change, not as an internal detail.

## Worked extension: report a negative-zero result

This is an extension exercise, not a category currently implemented by Crosscheck.

Suppose the project decides JavaScript `-0` is observably different from formal zero because operations such as `Object.is` and reciprocal division can distinguish it. Consider:

```ts
//@ backend dafny

export function negateBounded(x: number): number {
  //@ verify
  //@ requires x >= -100 && x <= 100
  //@ ensures \result === -x
  return -x
}
```

At `x = 0`, Dafny returns mathematical zero while JavaScript returns `-0`. The current model comparison converts `-0` to formal zero, so this is treated as agreement. The codec has already preserved the original runtime value as `{ $: "float", value: "-0" }`, which makes this a low-cost new category if the semantic policy changes.

### Step 1: define the rule and precedence

A precise rule could be:

> For a number-backed numeric return type, if formal equality succeeds but the encoded runtime result decodes to JavaScript `-0`, report `negative-zero-result`.

Place it after the ordinary unequal-result check and before mutation/output checks. A value that is already mathematically unequal should remain `result-mismatch`; an equal-but-observably-negative zero gets the more specific category.

Decide scope up front. Does this apply only to direct `number` results, or also to `-0` nested in arrays, records, sets, and maps? The direct-result version is small. Recursive negative-zero detection needs a type-directed walk and more tests.

### Step 2: extend the public category type

Add the category in [`src/report-types.ts`](src/report-types.ts):

```ts
export type IssueCategory =
  | "result-mismatch"
  | "negative-zero-result"
  // ...existing categories
```

This is public JSON, saved-case, and TypeScript API surface. Decide whether consumers of report v1 are expected to accept new category strings or whether the schema identifier needs to change.

Also add the string to the `isIssueCategory` validator in [`src/cases.ts`](src/cases.ts). Otherwise the new finding can be saved but its v2 replay case will be rejected when loaded.

### Step 3: classify the existing observation

After `model.equal !== true` has produced the ordinary result mismatch, inspect the already encoded runtime result in `auditTarget.evaluate`:

```ts
const numberBackedNumeric = fn.returnTy.kind === "real"
  || ((fn.returnTy.kind === "int" || fn.returnTy.kind === "nat") && !fn.returnTy.big)
const runtimeValue = decode(common.runtimeResult)

if (numberBackedNumeric && Object.is(runtimeValue, -0)) {
  return {
    kind: "issue",
    issue: { category: "negative-zero-result", ...common },
  }
}
```

No runtime-worker change is needed: `runtimeResponse.result` already contains `-0`. No codec change is needed: `encode`, `decode`, and `formatValue` already preserve and display it.

### Step 4: add user-facing language

Add an explicit `negative-zero-result` branch to `issueLanguage` in [`src/audit.ts`](src/audit.ts), with a concrete summary, diagnosis, and resolution.

There is a trap here: the current function's final fallback supplies runtime-timeout language. Adding a category without adding a branch can still typecheck and then report the wrong explanation. A useful cleanup during this change would make `runtime-timeout` explicit and end with a `never` exhaustiveness check.

The generic result branch in [`src/report.ts`](src/report.ts) will already render:

```text
Result
  verified    0
  JavaScript  -0 (exactly 0)
```

Here, `exactly 0` is the value obtained after marshalling the runtime result into model space. That wording may be confusing for this category, so a dedicated renderer branch would likely be clearer. More generally, if a new category needs a different payload or section, add optional fields to both `ExecutedIssue` and the public `Issue`, copy them in `issueReport`, and add a dedicated renderer branch.

### Step 5: decide shrinking and replay behavior

The generic shrinker is suitable here because every candidate is reevaluated and must reproduce the same `negative-zero-result` category. It should quickly settle on `x = 0`.

If the new category depended on timing, process state, two alternate runtime encodings, or nondeterministic output, the default shrink loop might be invalid. Exempt it or store the additional witness state, as the timeout and optional-presence categories do.

The existing case writer can persist this example without a new field. Its ID will automatically include the new category and minimized arguments.

### Step 6: test every changed contract

For this small category, add at least:

- a codec assertion in `test/codec.test.ts` that `-0` round-trips and formats distinctly;
- a mocked-worker audit test in `test/audit.test.ts` where model equality is true and the runtime result is encoded `-0`;
- a report test in `test/report.test.ts` for the exact human explanation; and
- a manual whole-toolchain run of the bounded `negate` fixture.

Also test precedence: a mathematically unequal `-0` result should remain `result-mismatch`, and mutation/output accompanying negative zero should produce whichever category the policy declares primary.

Update the issue tables in [README.md](README.md) and [DESIGN.md](DESIGN.md), then run all four release checks.

For this direct-result version, the production change is only a few branches. The careful tests and compatibility decision are most of the work; “a few focused hours” is a realistic scale.

## When the runtime worker must change

Suppose instead you want a `runtime-stderr` category. Direct `process.stderr.write` is not currently part of a call response, so the observation does not exist yet. The change would need to:

1. intercept and restore `process.stderr.write` only during the runtime call;
2. keep worker diagnostics and import-time output separate from audited call output;
3. add a response field to the JSON-lines protocol;
4. carry it through `audit.ts` into `Issue`;
5. define precedence relative to throws, mutation, and stdout;
6. decide how it participates in shrinking and issue identity;
7. render it in human and JSON reports; and
8. extend worker, audit, report, replay, and end-to-end tests.

That is a medium-sized change because protocol and capture lifetimes are involved. A missed `finally` restoration or an accidental write to protocol stdout can break every later request.

Filesystem writes, network calls, subprocesses, global mutation, and import-time side effects are harder still. Observing them reliably requires explicit instrumentation or a stronger sandbox, and declaring them wrong requires a corresponding formal effect policy. Child-process isolation alone does neither.

## When the formal side must change

Adding a value type usually touches all of these seams:

1. [`src/ir.ts`](src/ir.ts) must represent the typed-info shape; an upstream LemmaScript schema change may be required.
2. [`src/generate.ts`](src/generate.ts) needs baseline, edge, and random values.
3. [`src/spec.ts`](src/spec.ts) needs exact operations used by preconditions.
4. [`src/bridge.ts`](src/bridge.ts) must prove or reject faithful JavaScript encoding.
5. [`src/dafny-runtime.ts`](src/dafny-runtime.ts) must marshal in both directions or compare in model space.
6. [`src/codec.ts`](src/codec.ts) needs transport support if ordinary JSON cannot preserve the value.
7. [`src/shrink.ts`](src/shrink.ts) should minimize witnesses.
8. Support checks, display, reports, and focused tests must cover nested uses of the type.

This is why “support `Date`” or “support recursive classes” is not a one-file feature. Crosscheck needs a precise formal meaning, a faithful runtime boundary, model marshalling, useful generation, and stable replay—not merely a JavaScript serializer.

Extending the precondition subset is smaller when typed metadata already contains the expression. Add exact semantics to `evaluateSpec` and tests for truth, falsehood, and unsupported operands. Quantifiers or expressions whose domains cannot be enumerated may require model delegation or a different generation strategy.

Async support is architectural. The runtime worker would need to await with a deadline while preserving output capture and before/after argument state; the verified model needs a declared correspondence; cancellation and late effects need policy; and promises can outlive a request. Returning a promise is therefore currently `NOT CHECKED`.

## Current limitations and their seams

Use this table to locate likely changes:

| Limitation | Current consequence | Primary seams |
| --- | --- | --- |
| Dafny-only, fixed compatible tool lines | Other backends/versions stop before audit | `toolchain.ts`, `dafny-build.ts`, model worker |
| One source file per command | No project/directory scheduler | `cli.ts`, `auditFile` |
| Exported synchronous non-generic functions | Classes, promises, and generic targets are not checked | typed metadata, `audit.ts`, runtime/model workers |
| Finite generator | Parameterized success is sampled and valid cases may be fewer than `--cases` | `generate.ts`, `spec.ts` |
| Finite precondition evaluator | Unsupported expressions make the target `NOT CHECKED` | `spec.ts`, model delegation |
| Restricted value shapes | Recursive, opaque, function, unknown, and void shapes are rejected | `ir.ts`, `bridge.ts`, generator, Dafny marshalling |
| First issue per target | Later simultaneous disagreements are hidden by precedence | `audit.ts`, report contract |
| Selected call-local effects only | Ambient/global/fs/network/import effects are not classified | runtime worker, semantic policy |
| No repeated clean executions | Nondeterminism can escape a sampled run | audit loop, report evidence |
| Runtime identity hashes only the entry file | Changes confined to transitive runtime dependencies are not detected by replay identity | provenance/dependency-manifest design |
| Process isolation only | Audited code retains host filesystem, network, and subprocess access | worker launch/sandbox design |

These are limits on the conclusion Crosscheck may draw, not invitations to silently skip cases. When semantics cannot be represented faithfully, prefer `NOT CHECKED` with a specific next step.

## Testing strategy

Use the narrowest seam that proves the behavior, then add integration coverage where a boundary changed:

| Test layer | Existing examples | Best for |
| --- | --- | --- |
| Pure unit | `bridge`, `codec`, `generate`, `rational`, `shrink`, `spec` tests | Exact semantic rules and deterministic values |
| Worker protocol | `runtime-worker.test.ts`, `json-line-client.test.ts` | Capture, malformed output, process death, restart |
| Audit loop with mocked workers | `audit.test.ts` | Classification, precedence, shrinking policy, `NOT CHECKED` behavior |
| Report/CLI | `report.test.ts`, `cli.test.ts` | Wording, stable fields, exit codes, fatal JSON |
| Whole toolchain | `test/integration/soundness.test.ts` | Metadata, proof, compile, marshal, runtime, report, and saved-case replay together |
| Packed consumer | `.github/workflows/ci.yml` | Published file set and executable CLI |

`startWorkers` is the audit engine's main process seam, while `auditTarget` accepts `AuditWorkers` directly. Most new classification behavior can therefore be tested cheaply with deterministic fake clients instead of invoking Dafny.

Keep a whole-toolchain fixture for any change involving typed metadata, Dafny emission, marshalling, or real runtime loading. Unit tests cannot detect drift between those external representations.

## Extension checklist

Before calling an extension complete, verify:

- The mismatch relation is stated precisely.
- Issue precedence is intentional and tested.
- Formal values remain exact until the representation bridge.
- Unsupported cases become `NOT CHECKED`, not skipped success.
- Worker stdout remains protocol-only and hooks are restored in `finally`.
- Timeout/process failure cannot poison later requests.
- Shrinking reproduces the same category or is explicitly disabled.
- Saved evidence contains everything replay needs.
- Issue IDs and report/case schema compatibility were considered.
- Human wording separates verified-model behavior from JavaScript behavior.
- Clean sampled output still says `not a proof`.
- Unit, boundary, whole-toolchain, and packed-package checks match the risk of the change.
- README and DESIGN are updated when public behavior changes.

That discipline is what keeps a locally small category addition from weakening the meaning of the audit as a whole.
