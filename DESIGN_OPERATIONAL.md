# lemmascript-crosscheck — operational design

**Status:** implementation-facing proposal for review. It refines
`DESIGN_CONCISE.md`; `DESIGN.md` retains the extended rationale. No code should
be written until the three decisions at the end are accepted.

## 1. Product contract

Crosscheck runs verified LemmaScript functions under JavaScript semantics and
reports the smallest concrete explanation of any proof/runtime gap.

```sh
lemmascript-crosscheck path/to/file.ts
```

The common workflow requires no handwritten manifest, semantic config, oracle,
artifact choice, target list, or rejection class.

Default targets are synchronous functions that LemmaScript marks verified and
that the TypeScript module exports. The default executable is that source
module under a recorded TypeScript loader, and the report calls this a
**source-runtime audit**. Production code is explicit:

```sh
lemmascript-crosscheck src/search.ts --runtime dist/search.js
lemmascript-crosscheck src/search.ts --runtime dist/api.js --entry binarySearch=search
```

## 2. Detection model: semantic rules, not a bug list

Detection has three layers. Findings are violated semantic relations; familiar
edge cases only help find witnesses.

### 2.1 Per-operation transfer obligations

LemmaScript derives an obligation for every relevant operation occurrence in
the typed AST. Conceptually, for operation site `s`:

```text
reachable_s(modelState) ==>
  decode(jsOp_s(encode(modelState))) = modelOp_s(modelState)
```

The operation and result must also remain representable. Examples include:

- integer `+`, `-`, and `*` backed by `number` remaining exact;
- exact-real `/` agreeing with the precise binary64 value;
- `%` and rounding using the same sign and direction conventions;
- array length and index arithmetic remaining in range;
- string indexing using declared UTF-16/scalar semantics; and
- optional reads respecting the declared presence model.

These obligations are generated uniformly from typed operations. There is no
rule saying “warn about binary search,” “look for `Math.floor`,” or “flag every
`number`.” A safe midpoint may be proved compatible while an unsafe sum fails.

The finite registry is a versioned semantics definition for supported
JavaScript constructs, analogous to compiler lowering rules. It is not a list
of known bugs. A new construct must acquire a formal/runtime rule; otherwise
the target is `UNSUPPORTED`.

The backend returns a checked certificate, a concrete witness when available,
or `unknown` with its reason. Free text cannot discharge an obligation.

### 2.2 Whole-function differential execution

For exact model input `m` satisfying precondition `P` and having a faithful
runtime encoding:

```text
decode(F_runtime(encode(m))) = F_verified(m)
```

Both sides run in isolated workers, catching translation, marshalling, runtime,
or composition errors beyond local rules.

Execution begins with backend witnesses and deterministic semantic edges, then
adds generated model-valid cases. A successful sample is only `CHECKED`; it
does not convert an unknown universal obligation into a proof.

### 2.3 Observable-effect comparison

Each call produces a trace containing:

```text
return value or exception
arguments before and after
console output
deadline/worker outcome
exact replay outcome
```

The trace is compared with LemmaScript's effect model. Thus `nestedPush` fails
because JavaScript changes the caller's array while Dafny consumes an immutable
sequence—not because `push` is blacklisted.

## 3. LemmaScript audit-bundle prerequisite

Crosscheck does not reconstruct compiler knowledge. LemmaScript must expose a
public, versioned command or API:

```text
lsc audit-bundle path/to/file.ts
```

It runs only after the selected backend verifies the exact audit artifact. The
content-addressed bundle contains:

- schema and semantics versions;
- source, toolchain, backend, and artifact identities;
- typed target roles, formal types, and runtime representations;
- callable model, predicates, equality, and effects;
- per-operation transfer obligations and backend outcomes;
- model serialization and encode/decode metadata; and
- compiled model-runner material or an exact recipe for building it.

Every `proved` outcome identifies a structured obligation in the verified
artifact. It cannot be user-authored prose. Crosscheck validates bundle/source
identity but never scrapes `.dfy`, `.dfy.gen`, Lean files, TypeScript comments,
or filename conventions.

Unknown semantics are `UNSUPPORTED`; identity mismatches are `ERROR`.

This interface is phase zero. If it cannot be emitted for the release-gate
examples, Crosscheck implementation must not replace it with manual fixtures.

## 4. Exact model values and representations

Generation starts in model space and encodes afterward. This preserves values
that JavaScript cannot represent.

For each type `T`, the bridge defines:

```text
encode_T : model value -> runtime value | unrepresentable
decode_T : runtime value -> model value | invalid
```

and independently tests:

```text
decode_T(encode_T(x)) = x
```

The first release supports booleans, integer `number`/`bigint`, exact rationals
versus binary64, explicit strings, dense arrays, tuples, records, and optionals.

Formal integers remain arbitrary precision. Number-backed integers encode only
within the safe-integer range; BigInt-backed integers encode exactly, subject
to resource limits.

Formal reals remain rational. Crosscheck converts a runtime double to the exact
rational represented by its IEEE-754 bits before comparison. Consequently,
`3 / 2` can agree exactly while `1 / 10` cannot. `NaN` and infinities have no
ordinary exact-real image. Exact-real support is required before release.

The generator partitions candidates into:

1. precondition-valid and faithfully encodable;
2. precondition-valid but unrepresentable; and
3. precondition-invalid.

Category 2 disproves full-domain transfer. Category 3 is ignored in the
default audit and used by boundary mode.

## 5. Case discovery and shrinking

Cases are attempted in this order:

1. backend-provided transfer witnesses;
2. deterministic type edges;
3. pairwise and operation-guided edge combinations;
4. seeded generated model values.

Combinations cover safe-range crossings, cancellation, large arithmetic,
non-dyadic rationals, negative division/remainder, and composite boundaries.

These values improve search but do not determine correctness. Only failed
encoding, exact model/runtime disagreement, or trace mismatch creates a
finding.

On failure, a type-directed shrinker minimizes the witness while preserving the
relation. Fresh workers confirm it and produce an exact replay command.

Zero-argument targets check one tuple. Exhausted finite domains are labeled as
such rather than padded with duplicate calls.

## 6. Runtime result and contract handling

For each model-valid call, the engine evaluates in this order:

1. runtime termination and effects;
2. result decodability;
3. exact equality with the verified model;
4. verified postcondition, when separately callable.

A malformed or unrepresentable runtime result is incompatible. Crosscheck
still evaluates the model and displays its expected result; decode failure must
not erase the most useful comparison.

Downstream consequences are grouped under the first semantic cause. For
example, one unsafe `arraySum` result must not appear as separate unrelated
precision, representation, equality, and postcondition failures.

## 7. Boundary mode

Default mode audits the proof domain, not every helper as a public boundary.

```sh
lemmascript-crosscheck src/search.ts --runtime dist/api.js --boundary
```

Boundary mode derives invalid regions from `decode` failure and the complement
of the formal precondition. It requires either source-emitted boundary metadata
or a standard branded protocol from `@lemmascript/runtime`, initially a branded
`PreconditionError` or tagged `Result` error.

Native failures are not deliberate rejection. Invalid values derive from
representation rules and group by violated contract. A missing contract yields
one `UNSUPPORTED` explanation.

## 8. Results, reporting, and policy

Top-level conclusions are:

- **INCOMPATIBLE:** a certificate query or concrete witness disproved transfer;
- **PROVED:** all required transfer relations have backend certificates;
- **CHECKED:** no mismatch appeared in the declared finite/sampled scope;
- **UNSUPPORTED:** required semantics have no bridge; and
- **ERROR:** verification, identity, loading, or execution failed.

Exit codes are 0 for only `PROVED`/`CHECKED`, 1 for any `INCOMPATIBLE`, and 2
for any `UNSUPPORTED`/`ERROR`. In mixed incomplete and incompatible runs, exit
2 takes precedence while all rows remain visible.

Reports obey these rules:

- conclusion and root cause first;
- minimal witness before internal vocabulary;
- exact expected and actual values;
- one actionable repair;
- proof and sampling scope last;
- no hashes or obligation dumps by default;
- at most 25 lines for one target and one row per suite target; and
- deterministic human and JSON output.

`--explain <target>` prints a full narrative, `--details` prints obligations and
provenance, and `--json` emits the lossless report.

## 9. Operational pipeline

```text
source path
    -> project-local LemmaScript audit bundle
    -> capability and provenance validation
    -> exact model-value generation
    -> isolated model/runtime execution
    -> semantic comparison and effect observation
    -> shrinking and fresh replay
    -> root-cause grouping
    -> concise report / detailed JSON
```

Modules are the bundle client, representation bridge, isolated runners, audit
engine/shrinker, and reporter. No manifest-authoring layer exists.

The trusted base comprises LemmaScript's translation and bundle emitter, the
proof backend, structured certificates, codecs/marshalling, execution
sandboxes, and comparison logic. Crosscheck does not prove the translator
correct; it independently looks for disagreement at the model/runtime seam.

## 10. Release gates and sequence

The package is not publishable until source-only commands establish:

| Example | Required result |
|---|---|
| `binarySearch.ts` | incompatible unbounded-integer domain; safe executions may agree |
| `arraySum.ts` | minimal precision counterexample with exact expected/actual values |
| `division.ts::threeHalves` | checked exact agreement for `1.5` |
| `division.ts::divide` | exact-real/binary64 counterexample such as `1 / 10` |
| `division.ts::floorDivision` | singleton domain terminates and checks |
| `bigintBits.ts` | checked agreement on valid nonnegative BigInt inputs |
| `nestedPush.ts` | input mutation absent from the formal model |
| optional-record example | omission/present-`undefined` distinction is detected |

Implementation order:

1. LemmaScript audit-bundle spike for the real release-gate sources.
2. Integer, BigInt, rational, binary64, boolean, and array vertical slice.
3. Transfer queries, targeted generation, shrinking, replay, and concise output.
4. Strings, tuples, records, and optional presence.
5. Deployed runtime and opt-in boundary mode.
6. Determinism, cache isolation, fault injection, platform tests, and
   publication review.

No phase is complete if users must author protocol scaffolding.

## 11. Explicit exclusions

The design rejects handwritten manifests, oracle modules, trusted prose proof
claims, filename-based artifact discovery, regex/source-pattern diagnostics,
default malformed-input probing, per-probe risk floods, sampled claims labeled
as proof, and deferring exact-real support.

Async, ambient I/O, classes, nondeterminism, and stateful protocols remain
`UNSUPPORTED` until LemmaScript supplies corresponding semantic and effect
models.

## 12. Decisions to review

1. Default mode audits proof-domain compatibility; arbitrary-input boundary
   enforcement is opt-in.
2. Source-runtime execution is zero-config; deployed output requires
   `--runtime`.
3. Crosscheck remains a separate package consuming a public LemmaScript
   audit-bundle API rather than compiler internals.

Accept or change these before implementation; the operational design follows
from them.
