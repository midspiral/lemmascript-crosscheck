# lemmascript-crosscheck

**Status:** proposal for review. This repository must contain no implementation
until this document is accepted.

## 1. Product in one sentence

Given a LemmaScript source file, run its verified functions under JavaScript
semantics and report the smallest concrete explanation of any gap between the
proof and the program.

The ordinary interaction is:

```sh
lemmascript-crosscheck path/to/file.ts
```

There is no handwritten manifest, config file, oracle module, rejection class,
artifact selection, or target-role declaration in the normal workflow.

## 2. What the user should experience

### One target

```text
$ lemmascript-crosscheck examples/arraySum.ts

arraySum: INCOMPATIBLE

JavaScript integer arithmetic changes the result.

  input       [9007199254740991, 2]
  model       9007199254740993
  JavaScript  9007199254740992

Why: LemmaScript proved this function over unbounded integers, but the
TypeScript implementation uses IEEE-754 number arithmetic.

Fix: use bigint, or add and prove bounds that keep every input, intermediate,
and result within the safe-integer range.

Proof: Dafny 4.11 verified the exact generated model.
Check: 143 model-valid executions; seed 17.
```

The report leads with the conclusion, counterexample, explanation, and repair.
Internal obligation names, hashes, generated paths, and probe inventories are
available through `--explain` and `--json`, not printed by default.

### Several targets

```text
$ lemmascript-crosscheck examples/

7 targets

INCOMPATIBLE  arraySum       integer precision changes the result
INCOMPATIBLE  binarySearch   formal integer domain is wider than number
INCOMPATIBLE  pushItem       mutates an input absent from the formal model
INCOMPATIBLE  divide         exact 1/10 differs from its binary64 value
CHECKED       shiftWide      no mismatch in 100 generated executions
CHECKED       low64          no mismatch in 100 generated executions
CHECKED       floorDivision  complete singleton input domain checked

4 incompatible · 3 checked
```

A multi-target default report is one row per target. Full narratives require
`--explain <target>` or `--details`.

### Unsupported input

```text
loadUser: UNSUPPORTED

This verified target performs asynchronous ambient I/O, but this Crosscheck
build has no async effect model. Nothing was tested and no compatibility claim
was made.
```

Unsupported never becomes a clean result and never produces dozens of
secondary “unassessed obligation” messages.

## 3. The questions Crosscheck answers

The default audit answers four questions for each exported verified target:

1. **Can every value admitted by the proof be represented faithfully by the
   TypeScript signature?**
2. **Do JavaScript operations preserve the formal meaning on those values?**
3. **Does the executable function agree with the verified model on generated
   model-valid executions?**
4. **Does JavaScript exhibit an effect—mutation, exception, nondeterminism, or
   nontermination—that is absent from the formal model?**

These questions concern the proof domain. Arbitrary malformed JavaScript input
is a separate API-boundary question and is checked only with `--boundary`.
This prevents an internal algorithm from producing seventeen boundary warnings
when nobody claimed it was a validation wrapper.

## 4. Claims and result vocabulary

Crosscheck uses five top-level results:

- **INCOMPATIBLE** — a proof query or concrete execution disproved semantic
  transfer.
- **PROVED** — all required transfer obligations were discharged universally
  by backend-checked certificates. This will be uncommon initially.
- **CHECKED** — the audit completed and found no mismatch in its stated finite
  or sampled scope. This is evidence, not a theorem.
- **UNSUPPORTED** — the source uses a semantic feature the bridge cannot
  represent. Nothing is silently skipped.
- **ERROR** — provenance, verification, loading, or tool execution failed.

There is no top-level `RISK` counter. A problem is named directly: integer
precision, domain mismatch, input mutation, wrong exception, unsupported real,
and so on.

Exit codes are deliberately small:

```text
0  every selected target is PROVED or CHECKED
1  at least one selected target is INCOMPATIBLE
2  at least one selected target is UNSUPPORTED or ERROR
```

If a run contains both an incompatibility and an incomplete target, exit 2;
the displayed rows retain both facts.

## 5. No user-authored semantic manifest

Crosscheck must not accept free-form assertions such as:

```json
{ "kind": "proved", "proof": "the midpoint is safe" }
```

That moves the soundness question into an unchecked JSON file. It is neither
elegant nor trustworthy.

Instead, LemmaScript emits an **audit bundle** after verification. Crosscheck
invokes this through a public, versioned LemmaScript command or API:

```text
lsc audit-bundle path/to/file.ts
```

The bundle contains machine-derived data:

- source hash and resolved LemmaScript version;
- backend name, version, exact artifact hash, and verification outcome;
- exported verified targets and support functions;
- formal parameter and result types;
- runtime representation selected for each type occurrence;
- callable verified model, precondition, postcondition, and equality;
- effect model, including whether input mutation is represented;
- structured transfer obligations and backend-checked outcomes;
- canonical encoders, decoders, and model-value serialization metadata.

The bundle is content-addressed and schema-versioned. Every `proved` outcome
references a structured obligation in the exact verified artifact. It is never
an unaudited prose claim.

Crosscheck verifies the source hash and bundle identity, but it does not scrape
`.dfy`, `.dfy.gen`, Lean files, TypeScript comments, or filenames. Artifact
selection belongs to LemmaScript because LemmaScript created and verified the
artifact.

This audit-bundle interface is a prerequisite. Crosscheck implementation does
not begin by recreating its information manually.

## 6. Default target and runtime selection

The default targets are functions that the audit bundle marks as:

- verified;
- exported from the TypeScript module; and
- callable by the initial synchronous function runner.

LemmaScript determines verification and support roles from its own typed
program. Crosscheck does not equate “exported” with “proved,” and does not
report specification helpers as product targets.

The default executable is the TypeScript source module loaded through a
versioned, recorded TypeScript runtime. The report calls this a **source-runtime
audit**; it does not pretend to have checked a production bundle.

A deployed artifact can be selected without a project manifest:

```sh
lemmascript-crosscheck src/search.ts --runtime dist/search.js
```

Targets map by the bundle's exported names. A renamed or wrapped production
entry point is supplied directly:

```sh
lemmascript-crosscheck src/search.ts --runtime dist/api.js --entry binarySearch=search
```

If an export is missing or ambiguous, the target is `ERROR`. Crosscheck never
guesses another callable.

## 7. Numeric semantics are the first feature, not an extension

The first usable version supports all numeric distinctions already made by
LemmaScript:

### Formal integers

Formal integers are represented internally as arbitrary-precision integers.
For runtime `number`, canonical encoding is limited to safe integers. For
runtime `bigint`, integer encoding is exact, subject only to declared resource
limits.

Domain coverage asks:

```text
forall x admitted by the precondition, encode(x) exists
```

An unbounded `int` backed by `number` is therefore incompatible even if a
hundred small tests agree.

### Formal reals

Formal reals are transported as exact rationals, never rounded before the
comparison. A JavaScript binary64 value is converted to its exact rational
value before equality is checked.

Consequences include:

- `3 / 2` may agree because `1.5` is exactly representable;
- `1 / 10` does not equal the exact rational `1/10` as a binary64 value;
- `NaN` and infinities have no image in an ordinary exact-real model;
- a proved range alone does not establish exact representability.

Exact-real support is required before the first release. A tool motivated by
JavaScript floating-point gaps cannot defer the main floating-point case.

### Intermediate operations

Safe inputs do not imply safe intermediates or results. LemmaScript emits
structured obligations for numeric operations whose formal and JavaScript
semantics may differ. The backend either proves the necessary range/exactness
condition, returns a counterexample, or reports it unsupported.

Dynamic generation also prioritizes interacting edges such as:

```text
MAX_SAFE_INTEGER + 2
MAX_SAFE_INTEGER * 2
large positive + small positive
large positive + large negative
negative division and remainder boundaries
```

Random generation supplements these cases; it does not replace them.

## 8. Model values and representations

Case generation begins in model space. It never generates JavaScript numbers
first and thereby loses the values that matter.

The initial representation kernel supports:

- booleans;
- integers as `number` or `bigint`;
- exact rationals compared with `number`;
- strings with explicit UTF-16/scalar semantics;
- dense arrays;
- fixed tuples;
- plain records;
- optionals with explicit presence semantics.

For every representation `T`, the bundle and bridge define:

```text
encode_T(model value) -> runtime value | unrepresentable
decode_T(runtime value) -> model value | invalid
```

The required adapter law is:

```text
decode_T(encode_T(x)) = x
```

Adapter laws have exhaustive/property tests independent of user programs.
Unsupported nested types stop the target before runtime execution.

## 9. Preconditions and postconditions

LemmaScript emits callable precondition and postcondition evaluators as part of
the verified model bundle. Crosscheck never asks users to name helper functions
or restate inline expressions.

The generator partitions model values into:

- values satisfying the formal precondition and faithfully encodable;
- values satisfying the precondition but not faithfully encodable;
- values outside the precondition.

The second category disproves full-domain transfer. The third category is used
only by boundary mode.

If the runtime result is malformed or unrepresentable, Crosscheck still asks
the model for the expected result and displays both values. A failed decode
must not erase the most useful part of the counterexample.

## 10. Effects and execution isolation

Each model-valid call runs in an isolated worker with a deadline. Crosscheck
records:

- return value or exception;
- argument state before and after the call;
- console output;
- deterministic replay;
- timeout or worker death.

An observed effect is incompatible only when that effect is absent from the
formal model. For example, if Dafny models an input as an immutable sequence
but JavaScript `push` mutates the caller's array, the report says exactly that.
Crosscheck does not require a user-authored `effects: pure` switch to notice the
gap.

Async functions, ambient I/O, classes, and stateful protocols are unsupported
until the bundle supplies corresponding effect and observation models.

## 11. Boundary mode

Default mode checks behavior on the proof domain. Optional boundary mode asks
whether a public adapter enforces that domain:

```sh
lemmascript-crosscheck src/search.ts --runtime dist/api.js --boundary
```

Boundary behavior must be declared by LemmaScript source metadata or use a
standard branded protocol from `@lemmascript/runtime`. Initial support is:

- a branded `PreconditionError`; or
- a standard tagged `Result` error.

An incidental native `TypeError` is not a successful guard. Invalid probes are
grouped by one root finding rather than counted as seventeen independent
risks. If no boundary contract exists, the result is one `UNSUPPORTED` line.

Crosscheck does not invent a requirement that every verified internal function
must validate arbitrary JavaScript values.

## 12. Evidence strategy

Evidence is collected in this order:

1. verify bundle and runtime provenance;
2. consume backend-checked domain and operation obligations;
3. execute deterministic edge and backend-provided counterexamples;
4. generate additional model-valid cases;
5. shrink any failure while preserving it;
6. replay the minimal witness in a fresh worker.

Every execution finding includes:

- minimal model input;
- exact encoded runtime input;
- expected model result;
- actual runtime result or effect;
- source target and runtime export;
- deterministic replay command.

Sampling is always labeled with its case count and seed. “No mismatch found”
never becomes “proved.”

## 13. Reporting rules

The renderer follows these rules:

1. conclusion first;
2. one finding per semantic root cause;
3. concrete witness before internal terminology;
4. expected versus actual whenever available;
5. one repair suggestion, not a menu of unrelated possibilities;
6. proof and sampling scope at the end;
7. no hashes or obligation dumps in the default view;
8. one row per target for multi-target runs;
9. deterministic text and JSON for identical semantic inputs.

The default single-target report should normally fit within twenty-five lines.
The default multi-target report should normally fit within one terminal screen.

`--explain <target>` shows the complete narrative. `--details` shows structured
obligations and provenance. `--json` emits the lossless stable report and no
human prose on stdout.

## 14. Architecture

```text
source path
    |
    v
local LemmaScript audit-bundle API
    |
    +--> verified model + predicates + structured certificates
    |
    v
model-value generator and representation bridge
    |
    +--> isolated verified-model runner
    +--> isolated source/deployed-runtime runner
    |
    v
root-cause classifier and shrinker
    |
    +--> concise report
    +--> detailed JSON
```

The implementation has five conceptual modules:

1. **Bundle client** — invokes the project-local LemmaScript and validates its
   versioned audit bundle.
2. **Representation bridge** — exact model values, codecs, adapter laws, and
   targeted edge values.
3. **Runners** — isolated verified model and JavaScript runtime execution.
4. **Audit engine** — domain checks, comparisons, effect observations,
   shrinking, and replay.
5. **Reporter** — root-cause grouping and deterministic human/JSON output.

There is no public manifest-authoring layer and no generic configuration
language in the initial product.

## 15. Trust boundary

Crosscheck necessarily trusts:

- LemmaScript's typed translation and audit-bundle emitter;
- the selected verification backend and its successful check;
- bundle model callables and structured certificates;
- representation codecs and model/runtime marshalling;
- the JavaScript and model execution sandboxes;
- Crosscheck's comparison and shrinking logic.

It does not claim to prove LemmaScript's translator correct. It independently
looks for a disagreement between the verified model and JavaScript execution,
while making the exact trusted components visible in detailed output.

## 16. Required end-to-end examples

The following adjacent LemmaScript examples are release gates:

| Example | Required default result |
|---|---|
| `binarySearch.ts` | incompatible formal integer domain; representable executions may still agree |
| `arraySum.ts` | concrete safe-input/intermediate or result precision counterexample with exact expected and actual values |
| `division.ts::threeHalves` | checked agreement because `1.5` is exactly representable |
| `division.ts::divide` | exact-real/binary64 counterexample such as `1 / 10` |
| `division.ts::floorDivision` | singleton input domain completes without looping |
| `bigintBits.ts` | checked agreement on valid nonnegative BigInt inputs |
| `nestedPush.ts` | input mutation absent from the immutable formal model |
| optional-record example | distinguishes omission from present `undefined` without heuristic source parsing |

Each command must work with only the source path. Tests may use synthetic
bundles for fault injection, but release claims come from real bundles emitted
by LemmaScript.

## 17. Definition of done

The first releasable version satisfies all of these:

- `lemmascript-crosscheck file.ts` is the complete common workflow;
- no handwritten semantic manifest or oracle is needed;
- no user-authored prose can produce a `PROVED` result;
- exact integers, BigInt, and exact-real/binary64 comparison work;
- inline preconditions and postconditions arrive as bundle callables;
- unsafe intermediate arithmetic is deliberately explored;
- every concrete mismatch shows exact model and runtime results;
- zero-argument and finite-domain targets terminate correctly;
- unsupported semantics stop early and are stated once;
- suite output is one row per target;
- detailed output is opt-in;
- the tool writes only to a content-addressed cache;
- all release-gate examples above behave as specified;
- the package is not published before these gates pass.

## 18. Explicitly rejected designs

This design rejects:

- handwritten per-source manifests;
- trusted free-text proof claims;
- a required config file for ordinary use;
- manually maintained oracle modules;
- guessing proof artifacts by filename;
- treating every export as a target;
- probing malformed JavaScript inputs in the default proof-domain audit;
- requiring every function to throw a project-specific configured class;
- reporting each malformed-input variant as a separate risk;
- leading with hashes, obligation codes, seeds, or pass counts;
- calling sampled agreement a proof;
- deferring exact-real support while claiming to audit number semantics;
- adding implementation layers before the LemmaScript audit bundle exists.

## 19. Implementation order

Implementation begins only after this design is reviewed.

1. **LemmaScript bundle spike.** Make `lsc audit-bundle` emit complete,
   machine-derived bundles for `arraySum`, `division`, `binarySearch`,
   `bigintBits`, and `nestedPush`.
2. **Numeric vertical slice.** Implement exact integer, BigInt, rational,
   binary64, boolean, and array bridges; run the five release-gate files.
3. **Counterexamples and output.** Add targeted generation, shrinking, replay,
   and the specified concise reports.
4. **Composite values.** Add strings, tuples, records, and optional presence
   with adapter-law tests.
5. **Deployed runtime and boundary mode.** Add `--runtime`, `--entry`, standard
   boundary contracts, and grouped invalid-input diagnostics.
6. **Package hardening.** Determinism, cache isolation, failure injection,
   platform tests, documentation, and only then publication review.

At the end of each step, the tool must remain usable through the one-command
interface. A phase that requires users to author protocol scaffolding is not
complete.

## 20. Decisions to review

This proposal makes three opinionated choices:

1. the normal audit is proof-domain compatibility; arbitrary-input boundary
   enforcement is opt-in;
2. source-runtime execution is the zero-config default, while deployed output
   requires `--runtime`;
3. the separate Crosscheck package depends on a new public LemmaScript
   audit-bundle API rather than importing compiler internals.

Those choices should be accepted or changed before implementation. Everything
else follows from them.
