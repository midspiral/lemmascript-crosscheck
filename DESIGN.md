# LemmaScript Crosscheck design

**Status:** authoritative description of the v0.1.0 implementation.

[README.md](README.md) is the user guide, [TUTORIAL_DEV.md](TUTORIAL_DEV.md) is the practical code-reading and extension guide, and [ALGORITHM.md](ALGORITHM.md) records the exact current search and comparison procedure. This document records the authoritative implementation architecture, behavioral contract, and settled design decisions.

## Product boundary

LemmaScript proves properties of a formal model generated from TypeScript. Crosscheck looks for disagreements between that verified model and an executable TypeScript or JavaScript module.

The common operation is a source-runtime audit:

```sh
lemmascript-crosscheck path/to/file.ts
```

Crosscheck verifies the source and supports two selected checks. `differential`
generates formal inputs, executes the verified Dafny model and TypeScript, and
compares their behavior. `contract` generates from the executable TypeScript
domain, evaluates `requires` and `ensures` with JavaScript semantics, and looks
for both runtime postcondition violations and precondition-valid inputs that
the verified parameter types exclude. Differential checking is the default;
`--checks` selects either check or both.

Crosscheck does not:

- replace LemmaScript verification;
- prove the LemmaScript translation correct;
- infer compatibility from JavaScript execution alone;
- treat sampled agreement as a proof;
- test arbitrary malformed JavaScript inputs; or
- safely sandbox untrusted source code.

The distinction between proof and sampled runtime evidence is fundamental.
LemmaScript proves the formal program. Crosscheck gathers evidence about
whether JavaScript preserves that program's meaning and whether the executable
signature admits values outside the proof.

## Design principles

### Exact values come first

Differential generation begins in the formal value domain. Values are encoded
for JavaScript only after they satisfy the verified preconditions. This
preserves witnesses, such as integers outside JavaScript's exact range, that
would be lost if generation began with JavaScript values.

### Runtime domains are checked in their own semantics

Contract generation begins with executable TypeScript shapes. A `number`
therefore includes fractions, `NaN`, infinities, and `-0` even when LemmaScript
resolved the verified parameter as `int` or `nat`. Runtime `requires` and
`ensures` use JavaScript arithmetic, comparison, equality, and truthiness. A
postcondition-valid call can still be an issue when its input has no value in
the verified domain: the runtime behavior exists, but the proof does not cover
it.

### Unsupported semantics are explicit

A target is reported as `NOT CHECKED` when its types, preconditions, execution model, or toolchain cannot be compared faithfully. Unsupported behavior is never silently omitted from an otherwise successful claim.

### Findings are observational

Crosscheck reports a mismatch because the verified model and runtime produced different observable behavior—not because a source construct appears on a blacklist. A call to `push`, for example, matters only when it changes a caller-visible argument absent from the model.

### The default runtime is explicit

Without `--runtime`, the TypeScript source is also the runtime module. This is called a source-runtime audit. Built or deployed code must be named with `--runtime`; renamed exports must be mapped with `--entry`.

### Reports state evidence strength

The user-facing conclusion and its evidence are separate. A counterexample establishes an issue. A zero-argument target has one exhaustive input tuple. Other successful runs are sampled and always say that they are not a proof.

## System overview

```text
TypeScript source
      |
      +--> LemmaScript typed metadata
      +--> LemmaScript/Dafny verification --> checked .dfy artifact
                                            |
                                            v
                                  compiled executable model
                                            |
exact model-value generator --> precondition filter --> representation bridge
                                            |
                         +------------------+------------------+
                         |                                     |
                  model worker                         runtime worker
                         |                                     |
                         +------------- comparison ------------+
                                            |
                                  shrink + save replay
                                            |
                                    human / JSON report

TypeScript-value generator --> runtime requires --> runtime worker
          |                                         |
          +--> verified-domain membership      runtime ensures
                            \________________________/
                                      |
                               replayable finding
```

The main implementation components are:

| Component | Files | Responsibility |
| --- | --- | --- |
| CLI | `src/cli.ts` | Argument parsing, progress, output mode, and process exit status. |
| Verification adapter | `src/toolchain.ts` | LemmaScript invocation, typed metadata, source/artifact identity, and backend selection. |
| Model compiler | `src/dafny-build.ts` | Cached compilation of the already verified Dafny artifact to JavaScript. |
| Semantic values | `src/rational.ts`, `src/codec.ts` | Exact rationals and a lossless JSON-line representation. |
| Representation bridge | `src/bridge.ts`, `src/dafny-runtime.ts` | Formal-to-runtime encoding, runtime-to-proof domain checks, and Dafny value marshalling. |
| Input discovery | `src/generate.ts`, `src/spec.ts`, `src/runtime-spec.ts` | Formal and TypeScript-domain generation plus exact and JavaScript contract evaluation. |
| Execution | `src/workers.ts`, `src/model-worker.ts`, `src/runtime-worker.ts` | Separate model and runtime child processes with deadlines. |
| Audit engine | `src/audit.ts`, `src/shrink.ts`, `src/cases.ts` | Classification, comparison, shrinking, and replay persistence. |
| Reporting | `src/report.ts`, `src/report-types.ts` | Human output, stable JSON structure, and exit-code policy. |

## Audit lifecycle

### 1. Verify and identify the source

Crosscheck resolves the source path and hashes it before invoking LemmaScript. It accepts LemmaScript 0.6.x typed-info schema 1 and Dafny 4.11.x. Other tool release lines fail before verification so that model compilation is reproducible against the supported toolchain.

When `LEMMASCRIPT` names a checkout, Crosscheck runs that checkout's `tools/src/lsc.ts` through `tsx`. Otherwise it invokes `lsc` from `PATH`.

The verification adapter performs:

```text
lsc version
lsc info --typed <source>
dafny --version
lsc check --backend=dafny <source>
```

Lean-backed sources are rejected because the executable model runner currently supports Dafny only. After verification, Crosscheck hashes the source again and stops if it changed during the check.

The verified artifact is the adjacent `<source-base>.dfy` file produced and checked by LemmaScript. Its hash becomes part of report provenance. Running the audit may refresh LemmaScript's generated sidecars in the source directory, just as a normal `lsc check` would.

### 2. Compile the verified model

The Dafny artifact is compiled to JavaScript with `dafny build -t js --no-verify`. Skipping verification at this stage is safe only within the preceding protocol: LemmaScript has already verified the artifact, Crosscheck checks the expected hash before compilation, and it checks the hash again afterward.

Compiled models are cached by the artifact contents, the exact Dafny version, and the resolved `bignumber.js` dependency. Crosscheck patches the generated dependency path and exposes the Dafny runtime/module objects needed by the model worker. An unexpected Dafny output shape is a hard failure rather than a best-effort load.

### 3. Select targets and runtime exports

Crosscheck selects exported functions from LemmaScript's typed metadata. `--only` restricts the audit to one formal target.

The runtime module is:

- the source itself by default; or
- the module supplied by `--runtime`.

The runtime export normally has the formal target's name. Repeated `--entry formalName=runtimeName` options override that mapping. Missing or non-function exports prevent the target from being checked.

Before generation, the semantic bridge recursively checks every parameter and result type. Generic targets, opaque or recursive user types, function values, unknown types, and `void` results are among the unsupported cases. Targets containing `havoc`, `assume`, or autohavoc are also excluded because their model is nondeterministic or assumption-dependent.

### 4. Generate and filter formal inputs

Candidate discovery combines:

1. a deterministic baseline;
2. type-specific edge values;
3. one-parameter variations;
4. bounded pairwise combinations; and
5. pseudorandom values derived from `--seed`.

Numeric edges include signed small values, 32-bit boundaries, JavaScript's safe-integer boundary, exact and non-dyadic rationals, and array combinations that can overflow an otherwise representable accumulator. Composite generators recursively cover arrays, tuples, optionals, sets, maps, records, string unions, aliases, and discriminated unions.

After a clean canonical execution, Crosscheck also derives numeric projection probes from the concrete typed input shape. It substitutes `2^53` and `2^53 + 1` at number-backed numeric sites, both individually and in pairs, so it can expose values that are distinct in the exact model but become equal JavaScript numbers. This is type-directed and independent of function names or equality operators. The probe is bounded to the first eight numeric sites in a concrete shape.

Zero-argument functions produce one candidate: the empty argument tuple.

Each candidate is evaluated against the typed `requires` expressions before runtime encoding. The precondition interpreter uses exact integers and rationals. It can delegate calls to functions present in the compiled model, which supports predicates such as a verified sortedness helper. Bounded integer and natural quantifiers are enumerated completely with exact integer witnesses. If an expression lies outside the implemented evaluator, the target is `NOT CHECKED`; Crosscheck does not guess whether the candidate is valid.

Candidates then fall into three classes:

- precondition-invalid values, which are ignored;
- precondition-valid but unrepresentable values, which can witness an input-domain issue; and
- precondition-valid, faithfully representable values, which are executed.

For a finite numeric bridge failure, Crosscheck can additionally execute an explicitly recorded lossy JavaScript projection while retaining the original exact arguments for the verified model. It promotes that probe only when the projected call returns a result unequal to the exact model result; otherwise the ordinary input-domain witness remains available.

`--cases` limits successful representable main executions per target, not the number of raw candidates or auxiliary optional-presence and numeric-projection probes considered.

### 4b. Generate and check TypeScript contract inputs

When `contract` is selected, generation follows the same deterministic
baseline, per-parameter, pairwise, and seeded schedule but constructs runtime
values. Number-backed integers and naturals receive fractional, signed,
non-finite, negative-zero, safe-integer, and ordinary values. Reals receive the
full number edges; composite values receive them recursively.

Each candidate is first evaluated against `requires` with JavaScript semantics.
Calls in a contract delegate to the corresponding runtime export. For every
accepted candidate, Crosscheck executes the target and evaluates each `ensures`
clause against its returned value and post-call arguments. The exact and
runtime evaluators share the structural range planner, but runtime witnesses
and bound expressions retain JavaScript semantics. Bounded integer and natural
quantifiers are enumerated completely, with a 10,000-value work limit;
unbounded or truncated quantification is never treated as true.

Independently, the argument tuple is checked against the resolved verified
parameter types. A fraction admitted by TypeScript `number` but resolved as
formal `int`, for example, is a `proof-domain-gap`. Crosscheck retains the first
such witness while continuing to search for the stronger
`runtime-postcondition-violation`. Contract witnesses are executed but are not
passed to the Dafny model.

### 5. Execute model and runtime

The model and runtime run in separate Node child processes using a request/response JSON-lines protocol. They are isolated from the CLI process, but they are not security sandboxes.

The runtime worker loads TypeScript through `tsx`, calls the selected export synchronously, and records:

- the returned value;
- encoded arguments before and after the call;
- `console.log`, `info`, `debug`, `warn`, and `error` output;
- direct `process.stdout.write` output during the call;
- a thrown exception; or
- a returned promise, which is reported as unsupported async behavior.

The model worker marshals the same exact arguments into the compiled Dafny model. When a runtime result exists, it also converts that result into the corresponding formal value and performs exact equality in model space.

Each worker request has the `--timeout` deadline. A timed-out worker is killed and recreated with its original setup before the next request, so one timeout cannot poison later targets or model calls. If the verified model returns for the same input, runtime timeout is a concrete issue; if a comparison cannot be completed, the target is `NOT CHECKED`.

The worker redirects module-import output away from its JSON-lines protocol. During a runtime call, console methods and direct standard-output writes are captured as observable output.

### 6. Compare observable behavior

For a proof-valid representable input (m), the central relation is:

```text
decode(runtime(encode(m))) = verifiedModel(m)
```

Crosscheck also compares encoded arguments before and after the call and checks captured output. The implemented issue categories are:

| Category | Meaning |
| --- | --- |
| `input-domain` | The proof accepts an input that the TypeScript representation cannot encode faithfully. |
| `input-representation-mismatch` | Rounding an exact input to its JavaScript `number` representation changes the returned result. |
| `proof-domain-gap` | A TypeScript input satisfies runtime `requires` but lies outside the verified parameter domain. |
| `runtime-postcondition-violation` | TypeScript throws, times out, or makes an `ensures` clause false after runtime `requires` succeeds. |
| `result-mismatch` | Runtime and verified model return unequal exact values. |
| `input-mutation` | JavaScript changes a caller-visible argument absent from the value model. |
| `optional-presence` | JavaScript distinguishes omission from a property explicitly set to `undefined`. |
| `console-output` | JavaScript emits output absent from the functional model. |
| `runtime-threw` | JavaScript throws where the verified model returns. |
| `runtime-timeout` | JavaScript misses the deadline where the verified model returns. |

Optional record inputs receive one additional kind of probe. After the canonical omitted-property representation succeeds, Crosscheck tries present-`undefined` variants and detects results that depend on JavaScript property presence.

Numeric projection probes retain both argument tuples: the exact formal values passed to the model and the rounded values passed to JavaScript. The report shows every changed numeric path. A projected result mismatch is remembered while the ordinary search continues, allowing a mismatch on faithfully represented inputs to take precedence; it is still stronger evidence than a domain-only witness.

Within a differential check, the current engine reports the first faithfully
represented concrete issue found for each target. If none appears, an observed
numeric-projection result mismatch precedes a valid unrepresentable domain
witness. Within a contract check, a postcondition violation precedes the first
proof-domain gap. When both checks are selected, a contract issue is returned
before differential execution; a clean contract check proceeds to the
differential check. Without an already established contract finding, an
incomplete selected check yields `NOT CHECKED` rather than silently omitting
that evidence.

### 7. Shrink and persist failures

Executable and input-domain witnesses currently pass through a deterministic, representation-directed shrinker. Integers move toward zero and semantic boundaries, while rationals, strings, arrays, and plain objects receive structural reductions. The shrinker does not yet consult LemmaScript types: executable reductions must reproduce the same category, but input-domain reductions need only remain unrepresentable. It can therefore construct an invalid finite-string, discriminant, or tuple witness; this known correctness gap is tracked as P0 in [TODO.md](TODO.md). Optional-presence and input-representation findings retain their paired formal/runtime representations without shrinking, and runtime-timeout findings retain the input that actually crossed the deadline instead of probing a worker that was just killed.

Any changed minimized witness is replayed before reporting; unshrunk findings retain the directly observed execution. The issue ID is the first ten hexadecimal characters of a SHA-256 digest over the source and runtime entry hashes, formal and runtime targets, category, and encoded witness. Optional-presence and input-representation issues include both model and runtime representations in the identity. Content identity namespaces different audited code while remaining stable when byte-identical files move.

Contract witnesses are retained without shrinking so their TypeScript shape and
domain failure remain exact. Saved `lemmascript-crosscheck.case/v2` cases record
the source and runtime entry paths and hashes, target, runtime export, issue
category, arguments, and any representation variant. Replay selects contract
checking automatically for its two categories, restores the recorded runtime
when none is supplied, includes alternate runtimes in generated commands, and
refuses to run if either content hash has changed. An explicitly supplied module
at a new path is accepted when its hash matches. Runtime identity currently
covers the imported entry file, not its transitive dependencies.

## Semantic representations

Crosscheck keeps formal values separate from JavaScript values and from the tagged JSON transport used between processes.

### Numbers

Formal integers are held as `bigint` regardless of their TypeScript representation:

- a `bigint`-backed formal integer crosses exactly;
- a `number`-backed formal integer crosses only when conversion to `number` and back preserves the exact integer.

This admits `9007199254740992`, which is exactly representable, while rejecting `9007199254740993`.

The word “floating-point” here describes JavaScript's storage format, not the spelling of the input. Every ordinary JavaScript `number` is IEEE-754 binary64, including integer-looking values. Binary64 has 53 bits of integer precision, so converting the exact integer `9007199254740993` produces the already-existing number `9007199254740992`. A numeric projection probe makes that lossy conversion explicit and records it rather than treating the call as faithful.

Formal reals use normalized `Rational` values. Runtime binary64 numbers are decomposed into the exact rational represented by their IEEE-754 bits before comparison. Consequently, `3 / 2` can agree exactly while the runtime value for `1 / 10` differs from the mathematical rational.

`NaN` and infinities have no ordinary exact-real representation. Invalid numeric encodings are explicit failures.

### Composite values

Arrays and tuples are encoded element by element. Sets and maps retain their collection identity in the tagged transport; map inputs can target either JavaScript `Map` or object-shaped TypeScript representations. Records omit absent optional fields in their canonical runtime form.

Supported user declarations are non-generic string unions, aliases, records, and discriminated unions whose nested fields are themselves supported. Recursive and opaque declarations are rejected before execution.

Strings are transported losslessly. Dafny marshalling rejects lone UTF-16 surrogates rather than silently changing their meaning.

### Wire encoding

Plain JSON cannot preserve `bigint`, rational values, `undefined`, sets, maps, or special numeric values. `src/codec.ts` uses tagged objects for these values, supplies stable keys for deterministic deduplication, and provides unambiguous human formatting. This same encoding underpins worker communication, equality of observed argument state, shrinking, saved cases, and issue IDs.

## Reports and policy

The human interface has three conclusions:

| Conclusion | Evidence | Interpretation |
| --- | --- | --- |
| `ISSUE FOUND` | Counterexample | One minimized, replayed witness demonstrates a disagreement. |
| `NO ISSUE FOUND` | Sampled or exhaustive | No disagreement appeared in the stated scope. |
| `NOT CHECKED` | Failure reason | Unsupported semantics or a tool/runtime failure prevented a claim. |

Exit status is operational policy:

```text
0  every target reports NO ISSUE FOUND
1  at least one target reports ISSUE FOUND
2  at least one target reports NOT CHECKED
```

Exit 2 takes precedence in mixed reports, while issue rows remain visible.

A single-target report leads with the conclusion, witness, expected and actual behavior, cause, resolution, replay command, and evidence. Multi-target output uses one summary row per target. `--details` expands every target; it does not add a separate diagnostic protocol. `--json` emits the stable `lemmascript-crosscheck.report/v1` structure.

Reporting language follows these rules:

- say “verified model,” not “oracle”;
- say “proof-valid input” for differential values and “precondition-valid
  TypeScript input” for runtime contract values, not merely “test input”;
- distinguish a formal-only domain witness from an executed JavaScript call;
- show exact mathematical and runtime values when they differ;
- never call sampled agreement “safe,” “passed,” or “proved”;
- state unsupported behavior once with a concrete next step; and
- keep hashes and internal transport details out of default human output.

## Determinism, provenance, and caches

The report records source, artifact, and runtime entry paths and hashes plus the LemmaScript and Dafny versions. These hashes guard the transitions between verification, compilation, execution, and replay.

Generation order, edge values, seeded random generation, shrinking order, wire encoding, and issue IDs are deterministic for the same versions and inputs. Runtime behavior and external tool behavior may still introduce nondeterminism; the current implementation does not repeatedly execute clean cases to detect it.

Saved counterexamples use:

```text
$LEMMASCRIPT_CROSSCHECK_CACHE
$XDG_CACHE_HOME/lemmascript-crosscheck/cases
~/.cache/lemmascript-crosscheck/cases
```

in that precedence order.

Compiled models use `$LEMMASCRIPT_CROSSCHECK_BUILD_CACHE` or `<os-temp>/lemmascript-crosscheck-build`. Build products are content-addressed; case files are issue-addressed.

## Trust and safety boundary

Crosscheck trusts:

- LemmaScript's typed metadata and successful Dafny verification;
- the convention connecting a source path to its adjacent verified `.dfy` artifact;
- Dafny's JavaScript compiler and generated runtime;
- exact-value codecs and Dafny/runtime marshalling;
- precondition evaluation and candidate classification;
- the runtime loader, observation hooks, and comparison logic; and
- the host Node.js process and filesystem.

The artifact hash protocol prevents Crosscheck from knowingly compiling a different Dafny file than the one just verified. It does not independently prove that LemmaScript's generated model faithfully represents the TypeScript source.

Crosscheck imports and executes the runtime module. Child-process separation and deadlines protect the CLI from ordinary crashes and nontermination, but they do not restrict filesystem, network, subprocess, or other ambient access. Users must audit only code they trust to execute.

## Current limitations

The v0.1.0 implementation intentionally has a narrower contract than the long-term design:

- only Dafny-backed LemmaScript 0.6.x sources running with Dafny 4.11.x are supported;
- the CLI accepts one source file, not a directory or project;
- targets must be synchronous, exported, non-generic functions;
- generic, recursive, opaque, function-typed, unknown, and `void` value shapes are unsupported;
- `havoc`, `assume`, and autohavoc targets are not compared;
- the typed precondition evaluator supports a finite expression subset;
- successful parameterized audits are sampled, never universally proved;
- observed effects are limited to argument mutation, console and standard output, throws, promises, and deadlines;
- ambient state, global mutation, filesystem/network effects, and nondeterminism are not modeled;
- arbitrary invalid JavaScript inputs and boundary enforcement are not tested;
- there are no per-operation transfer certificates or `PROVED` conclusion; and
- workers provide process isolation, not a security sandbox.

## Tests and release checks

Unit tests cover exact numeric representation and projection, candidate generation, optional presence, rational arithmetic, typed preconditions, shrinking, worker recovery and protocol isolation, audit-loop failure classification, stable encoding, and report wording. The standard validation sequence is:

```sh
npm run typecheck
npm test
npm run build
npm pack --dry-run
```

Continuous integration runs this sequence on Node.js 22 and 24. It also installs the generated tarball into an empty project, confirms that the packaged CLI reports the manifest version and renders help, and rejects tarballs containing compiled tests.

End-to-end regression fixtures live in the adjacent LemmaScript repository. The important behaviors are:

| Fixture | Expected behavior |
| --- | --- |
| `arraySum.ts` | Finds a safe-input accumulator precision mismatch. |
| `binarySearch.ts` | Finds distinct exact inputs that collapse to one JavaScript number and change the search result. |
| `division.ts` | Distinguishes exact dyadic agreement from non-dyadic binary64 mismatch. |
| `bigintBits.ts` | Samples exact BigInt behavior without finding a mismatch. |
| `nestedPush.ts` | Finds caller-visible input mutation. |
| `spreadMerge.ts` | Finds omitted versus present-`undefined` behavior. |

These examples validate the whole toolchain path: LemmaScript metadata and verification, Dafny compilation, formal generation, TypeScript execution, exact comparison, shrinking, and reporting.

## Settled decisions

The current implementation embodies these decisions:

1. The default audit concerns the proof-valid domain, not arbitrary malformed JavaScript input.
2. The source module is the zero-configuration runtime; deployed output requires `--runtime`.
3. Formal values are generated exactly and only then encoded for JavaScript.
4. No user-authored semantic manifest or oracle is required.
5. A successful sample is evidence, never a proof claim.
6. Human output leads with the smallest actionable explanation rather than internal obligations.
7. Unsupported behavior prevents a compatibility conclusion instead of being skipped.

Changes to these decisions should update this document, the user-facing README, and the corresponding tests in the same change.
