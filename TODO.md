# Engineering TODOs

This file records known correctness, coverage, and diagnostic gaps. It is an engineering backlog, not a release schedule. `DESIGN.md` remains the description of intended behavior; when implementation and design differ, the discrepancy is called out here until they are reconciled.

Priorities mean:

- **P0:** reported evidence can be unsound or misleading;
- **P1:** an important class of otherwise supported targets cannot be checked meaningfully; and
- **P2:** the audit is soundly conservative, but its evidence or explanation could be substantially better.

An item is complete only when its behavior is covered by focused tests and the relevant user/developer documentation agrees with the implementation.

## P0: make counterexample shrinking type-preserving

### Problem

`src/shrink.ts` currently shrinks representation-shaped JavaScript values without knowing their LemmaScript `Ty`. In particular, it:

- replaces any nonempty string with `""` or a shorter prefix;
- recursively shrinks every object field, including discriminants;
- removes arbitrary array elements; and
- accepts a candidate whenever the audit callback says that some failure in the requested category remains.

That is not safe for formal values with structural constraints. A string may represent a finite string union, an object field may be a discriminant, and an array may be a fixed-length tuple or be constrained by a precondition.

Input-domain shrinking made the problem observable: it accepted any candidate whose bridge result was still `unrepresentable`, even when the reason changed and the candidate was no longer a value of the formal parameter type. Input-domain findings now retain their original precondition-valid arguments and bridge failure without shrinking; the generic shrinker remains representation-directed.

### Observed failures

- ClearSplit `step` began with a generated `Action`, whose valid tags are `addExpense` and `addSettlement`. Shrinking changed the tag to `""`, then reported `Action has an unknown variant` as if the proof admitted that value.
- ColorWheel `normalizeModel` changed a valid `Mood` member to `""`, then reported that `""` was not a member of `Mood`.
- Both reports suggested `Use bigint`, even though their displayed failures were invalid union members rather than numeric representation failures.

These minimized witnesses were not formal counterexamples. Their replay files reproduce a bridge rejection created by the shrinker, not the original model/runtime boundary problem. Issue IDs were also derived from the fabricated minimized values. Existing saved cases are unchanged; rerun the audit to replace them with original validated witnesses.

### Immediate containment

- [x] Do not shrink `input-domain` witnesses with the generic shrinker.
- [x] Save and report the original precondition-valid candidate produced by the typed generator.
- [x] Add regression tests proving that tagged-union and finite-string-union examples retain valid members and replay the original numeric failure.
- [x] State explicitly in code why input-domain shrinking is disabled, as is already done for stateful runtime timeouts.

This containment is preferable to a small ad hoc tag exception: it restores trustworthy evidence while the proper type-directed implementation is built.

### Proper implementation

- [ ] Change the shrinking API to receive parameter types and the type-declaration environment.
- [ ] Add a formal-value validator distinct from `encodeRuntime`:
  - it must accept valid exact formal values that JavaScript cannot represent;
  - it must reject malformed records, invalid union members, invalid discriminants, tuple arity changes, and negative naturals; and
  - it must terminate safely for recursive declarations.
- [ ] Make `shrinkValue` dispatch on `Ty` rather than only on `typeof`:
  - `bool`: `true` may shrink to `false`;
  - `int`: move toward zero and relevant exactness boundaries;
  - `nat`: use only nonnegative candidates;
  - `real`: preserve exact `Rational` values and useful representability boundaries;
  - unrestricted `string`: shorten by Unicode code point rather than UTF-16 code unit;
  - arrays: remove or shrink elements using the element type;
  - tuples: retain arity and shrink each position using its declared type;
  - optionals: shrink a present value using its inner type or make it absent;
  - sets/maps: shrink entries with their key/value types while preserving collection semantics;
  - aliases: shrink through the resolved target type;
  - records: retain required fields and shrink each field using its declared type;
  - string unions: retain a declared member, optionally trying a simpler declared member;
  - discriminated unions: retain a valid discriminant and shrink only fields belonging to that variant; and
  - opaque, unresolved, generic, or recursive unsupported types: retain the original value rather than guessing.
- [ ] Decide whether changing to another valid union variant is useful. If allowed, construct that variant from typed baseline values; never mutate only the tag.
- [ ] Validate every proposed shrink candidate before asking the expensive audit relation to evaluate it.

### Preserve the failure, not just the category

`RuntimeEncodingFailure` currently carries a human-readable `reason`, `path`, and `formalValue`. Add a stable machine-readable failure code, for example:

- `unsafe-integer-number`;
- `inexact-real-number`;
- `non-finite-real-number`;
- `invalid-unicode-string`;
- `optional-presence-unrepresentable`; and
- `formal-value-invalid` for internal invariant violations that should not become user issues.

Then:

- [ ] Require an input-domain shrink to preserve the original failure code.
- [ ] Prefer preserving the same root parameter and structural path. Permit array indices to move when removing an earlier element, but do not jump from a numeric exactness failure to an unrelated tag failure.
- [ ] Treat a formally invalid candidate as an internal error or rejected shrink proposal, not an `input-domain` issue.
- [ ] Replay the final candidate and verify its failure code before saving or reporting it.

### Acceptance criteria

- [ ] Every candidate evaluated during typed shrinking is valid for the declared formal parameter types.
- [ ] A discriminated-union witness always contains a declared tag and exactly the fields required by that variant.
- [ ] A finite string-union witness always remains a declared member.
- [ ] Required record fields and tuple arity are preserved.
- [ ] A minimized unsafe-integer witness still contains an unsafe integer and reports that exact failure class.
- [ ] Replaying a saved witness reproduces the same issue category and failure code.
- [ ] `test/shrink.test.ts` covers every supported `Ty` family, not only integers.
- [ ] `test/audit.test.ts` covers end-to-end input-domain minimization for nested records, string unions, and discriminated unions.
- [ ] Keep `DESIGN.md`, `ALGORITHM.md`, and `TUTORIAL_DEV.md` aligned as the typed shrinker replaces the currently documented representation-directed implementation.

## P1: generate inputs that reach domain-defining behavior

### Problem

The default unrestricted-string edges are currently `""`, `"a"`, `"0"`, `"é"`, and `"😀"`; random strings use only `a`, `b`, `0`, `é`, and `😀`. This is useful for basic Unicode and empty-string coverage but misses syntax that determines behavior in many production utilities.

The ordering of candidate families can also consume the entire `--cases` budget before later families are reached. Large pairwise products of small record edges can crowd out random cases and nested numeric boundaries.

### Observed weak results

- node-casbin `keyGet` reported no issue after 100 cases, but zero generated patterns contained `*`. The wildcard branch was never executed.
- Rallly `validateRedirectUrl` reported no issue after 100 cases, but zero generated strings contained `/`. No accepted relative URL or protocol-relative rejection was exercised.
- Composite records can spend 100 cases on small per-field combinations without reaching JavaScript safe-integer boundaries nested inside the record.

These runs are truthful sampled agreements, but they are not strong evidence about the behavior users care about.

### Proposed work

- [ ] Collect string and numeric literals from typed `requires`, `ensures`, constants, and any body metadata LemmaScript exposes.
- [ ] If body literals are not available in typed-info, decide whether to extend the public LemmaScript metadata or add a small TypeScript-source literal collector. Do not infer semantics with regexes over arbitrary source text.
- [ ] Derive deterministic neighbors around string literals:
  - the literal itself;
  - duplicated and repeated-prefix forms such as `//`;
  - a literal at the start, middle, and end of a short string;
  - strings immediately before/after a delimiter; and
  - whitespace-wrapped forms when whitespace operations appear in typed metadata.
- [ ] Include useful general punctuation and whitespace edges without allowing the alphabet to grow combinatorially.
- [ ] Interleave baseline, scalar edges, pairwise cases, nested boundaries, and random cases instead of exhausting one family before considering the next.
- [ ] Reserve part of every nontrivial case budget for seeded random cases.
- [ ] Propagate safe-integer and exact-real boundaries into nested records, arrays, tuples, maps, sets, and union payloads within the default budget.
- [ ] Deduplicate after scheduling without changing deterministic seed behavior.
- [ ] Consider reporting lightweight generation evidence such as raw candidates, precondition rejections, representable executions, and literal-derived cases. Do not call this branch coverage without instrumentation.

### Acceptance criteria

- [ ] Within 100 cases, a `keyGet`-shaped target receives patterns including `*`, `a*`, and a non-BMP prefix followed by `*`.
- [ ] Within 100 cases, a redirect-validator-shaped target receives `/`, `//`, `/path`, whitespace-wrapped relative paths, and ordinary non-path strings.
- [ ] A nested record with a `number`-backed formal integer reaches the safe-integer boundary within 100 cases.
- [ ] Small budgets still contain at least one case from each applicable high-value family.
- [ ] Generation remains deterministic for the same seed and changes for meaningfully different seeds.
- [ ] Tests assert behavior-relevant input diversity rather than only snapshotting total candidate arrays.

## P1: handle verified artifacts with bodyless helpers

### Problem

Crosscheck compiles the verified Dafny artifact into an executable model. Verification may legitimately use an axiomatic or opaque helper with no executable body, but `dafny build -t js` cannot compile a call to that helper.

### Observed blocked target

Eventab `allocate` depends on an axiomatic `floorShareG` declaration in its verified artifact. LemmaScript verification succeeds, but executable-model compilation fails with `Function ... floorShareG has no body so it cannot be compiled`.

### Required semantic decision

Do not silently substitute the TypeScript runtime implementation for a bodyless formal helper. That would make the model and runtime share the implementation whose compatibility is being tested and could hide exactly the mismatch Crosscheck is meant to find.

Evaluate these options:

- [ ] Compose the executable model from separately verified helper artifacts when a trustworthy body is available.
- [ ] Extend LemmaScript metadata with helper provenance and executable-body availability.
- [ ] Determine whether target-level dependency analysis can mark only affected functions `NOT CHECKED`, allowing independent targets in the same artifact to run.
- [ ] If no sound executable body exists, fail early with a structured reason naming the target and bodyless dependency.

### Acceptance criteria

- [ ] Eventab `allocate` reports `NOT CHECKED` with `floorShareG` named as a non-executable formal dependency, rather than exposing a raw Dafny compiler failure.
- [ ] No runtime implementation is used as a formal model without an explicit, documented soundness argument.
- [ ] Unaffected targets remain auditable when technically possible.
- [ ] Human and JSON reports preserve the distinction between verification success and model-execution availability.

## P2: make evidence strength visible in reports

### Problems observed

- Human issue reports omit the number of representable cases executed before the counterexample or remembered domain witness; JSON contains the count.
- Input-domain formatting prints a parameter and then the failing path/value again, sometimes producing duplicate-looking lines or missing visual separation.
- The generic input-domain resolution `Use bigint` is inappropriate for nonnumeric bridge failures.
- `NO ISSUE FOUND` reports state the case count but cannot reveal that every generated value missed a target's defining delimiter or branch.

### Proposed work

- [ ] Include the execution count and seed in human counterexample reports.
- [ ] Distinguish `cases executed before finding this issue` from `cases executed before reporting a remembered domain witness`.
- [ ] Render the failing formal path as a clearly labeled line rather than as another parameter.
- [ ] Select resolution text from the stable failure code introduced for typed shrinking.
- [ ] Include precondition rejection and unrepresentable-candidate counts in detailed/JSON reports if they can be added compatibly.
- [ ] Explore a compact generation-summary section for `--details`, without implying source-level branch coverage.
- [ ] Add report snapshot tests for nested paths, long parameter names, negative values, unions, and each failure-code family.

## P2: retain the case studies as regression evidence

The sibling `../*-lemmascript` repositories are useful exploratory inputs but are not reliable CI dependencies. They may be absent, change independently, require package installation, or refresh generated sidecars.

- [ ] Add small, self-contained fixtures that reproduce:
  - the valid-union input-domain shrink;
  - the finite string-union shrink;
  - wildcard and redirect literal generation;
  - a bodyless formal helper; and
  - the executed safe-integer overflow found by `boardSum`.
- [ ] Keep fixtures minimal and authored for this repository rather than copying large external case-study files.
- [ ] Add an opt-in sibling-case-study smoke script for local development; do not make ordinary CI depend on sibling checkouts.
- [ ] Use isolated case/build caches and document that LemmaScript may refresh generated sidecars.
- [ ] Assert conclusion class, category, failure code, and key evidence—not issue IDs tied to external source hashes.
- [ ] Record the compatible LemmaScript and Dafny release lines in smoke output.

## Reproduction commands

The observations above were made with LemmaScript 0.6.0, Dafny 4.11.0, seed 17, and ordinary `LemmaScript-files.txt` entries that require no extra verification flags. These commands use isolated caches:

```sh
LEMMASCRIPT=../LemmaScript \
LEMMASCRIPT_CROSSCHECK_CACHE=/tmp/lemmascript-crosscheck-todo-cases \
LEMMASCRIPT_CROSSCHECK_BUILD_CACHE=/tmp/lemmascript-crosscheck-todo-build \
  node --import tsx src/cli.ts \
  ../clear-split-lemmascript/src/logic/logic.ts \
  --only step --cases 100 --seed 17 --details

LEMMASCRIPT=../LemmaScript \
LEMMASCRIPT_CROSSCHECK_CACHE=/tmp/lemmascript-crosscheck-todo-cases \
LEMMASCRIPT_CROSSCHECK_BUILD_CACHE=/tmp/lemmascript-crosscheck-todo-build \
  node --import tsx src/cli.ts \
  ../colorwheel-lemmascript/src/colorwheel.ts \
  --only normalizeModel --cases 100 --seed 17 --details

LEMMASCRIPT=../LemmaScript \
LEMMASCRIPT_CROSSCHECK_CACHE=/tmp/lemmascript-crosscheck-todo-cases \
LEMMASCRIPT_CROSSCHECK_BUILD_CACHE=/tmp/lemmascript-crosscheck-todo-build \
  node --import tsx src/cli.ts \
  ../node-casbin-lemmascript/src/util/keyGet.ts \
  --only keyGet --cases 100 --seed 17 --details

LEMMASCRIPT=../LemmaScript \
LEMMASCRIPT_CROSSCHECK_CACHE=/tmp/lemmascript-crosscheck-todo-cases \
LEMMASCRIPT_CROSSCHECK_BUILD_CACHE=/tmp/lemmascript-crosscheck-todo-build \
  node --import tsx src/cli.ts \
  ../rallly-lemmascript/apps/web/src/features/poll/scoring.ts \
  --only scorePoll --cases 100 --seed 17 --details

LEMMASCRIPT=../LemmaScript \
LEMMASCRIPT_CROSSCHECK_CACHE=/tmp/lemmascript-crosscheck-todo-cases \
LEMMASCRIPT_CROSSCHECK_BUILD_CACHE=/tmp/lemmascript-crosscheck-todo-build \
  node --import tsx src/cli.ts \
  ../eventab-lemmascript/src/allocate.ts \
  --only allocate --cases 100 --seed 17 --details

LEMMASCRIPT=../LemmaScript \
LEMMASCRIPT_CROSSCHECK_CACHE=/tmp/lemmascript-crosscheck-todo-cases \
LEMMASCRIPT_CROSSCHECK_BUILD_CACHE=/tmp/lemmascript-crosscheck-todo-build \
  node --import tsx src/cli.ts \
  ../trace-solo-lemmascript/src/games/g2048/engine.ts \
  --only boardSum --cases 100 --seed 17 --details
```

Before closing any item, rerun its minimal fixture first and the relevant external case study second. A change that merely transforms an incorrect `ISSUE FOUND` into an unexplained `NOT CHECKED` has not completed the work.
