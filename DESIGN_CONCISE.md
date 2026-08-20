# lemmascript-crosscheck — concise design

**Status:** review proposal; no implementation until the final decisions are
accepted.

## Product

Run a LemmaScript source's verified functions under JavaScript semantics and
explain the smallest concrete proof/program gap.

```sh
lemmascript-crosscheck path/to/file.ts
```

No handwritten manifest, config, oracle, or rejection class is required.

By default, exported verified targets form a **source-runtime audit**.
Production code is explicit:

```sh
lemmascript-crosscheck src/search.ts --runtime dist/search.js
lemmascript-crosscheck src/search.ts --runtime dist/api.js --entry binarySearch=search
```

## Output

A single-target result leads with the conclusion and witness:

```text
arraySum: INCOMPATIBLE

JavaScript integer arithmetic changes the result.

  input       [9007199254740991, 2]
  model       9007199254740993
  JavaScript  9007199254740992

Why: the proof uses unbounded integers; the runtime uses IEEE-754 numbers.
Fix: use bigint, or prove bounds on every input, intermediate, and result.
```

A multi-target report is one row per target. Details require `--explain`,
`--details`, or `--json`.

There are five conclusions:

- **INCOMPATIBLE:** a query or execution disproved transfer.
- **PROVED:** backend certificates discharged every transfer obligation.
- **CHECKED:** no mismatch appeared in the stated scope; evidence, not proof.
- **UNSUPPORTED:** the bridge cannot represent required semantics.
- **ERROR:** verification, provenance, loading, or execution failed.

Exit 0 means every target is `PROVED` or `CHECKED`; exit 1 means at least one is
`INCOMPATIBLE`; exit 2 means at least one is `UNSUPPORTED` or `ERROR`.

## Audit scope

The default audit asks four questions for each target:

1. Can every formal input admitted by the precondition be represented exactly
   by the TypeScript signature?
2. Do JavaScript operations preserve the formal meaning on those inputs?
3. Does the executable agree with the verified model on generated model-valid
   executions?
4. Does JavaScript exhibit mutation, exceptions, nondeterminism, or
   nontermination absent from the model?

Formal values, representable formal values, and arbitrary JavaScript values
remain distinct.

Malformed inputs are not probed by default. `--boundary` uses a contract emitted
by LemmaScript or a branded `@lemmascript/runtime` protocol. A native
`TypeError` is not a guard. Related probes produce one root finding.

## LemmaScript contract

Crosscheck does not accept user-authored semantic claims. LemmaScript must first
provide a public, versioned command or API:

```text
lsc audit-bundle path/to/file.ts
```

After verification, it emits a content-addressed bundle containing:

- source, toolchain, backend, and artifact identities;
- verified targets, formal types, and runtime representations;
- callable model, precondition, postcondition, equality, and effect model;
- backend-checked transfer obligations; and
- model serialization and codec metadata.

Every `PROVED` fact references the verified artifact, never trusted prose.
Crosscheck validates the bundle but does not scrape generated files, comments,
or filenames. This API is a prerequisite to implementation.

## Semantic kernel

Generation starts with exact model values, then attempts runtime encoding.
It never starts with JavaScript numbers and thereby loses important cases.

The first release supports booleans, integer `number`/`bigint`, exact rationals
versus binary64, strings, dense arrays, tuples, records, and optionals. Each
representation defines partial `encode` and `decode` functions satisfying:

```text
decode(encode(x)) = x
```

Formal integers use arbitrary precision; number-backed integers encode only in
the safe range. Formal reals remain rational, and binary64 values are converted
to exact rationals for comparison. Thus `3 / 2` can agree while `1 / 10` cannot.
Exact-real support is required before release.

Safe inputs do not imply safe intermediates. Backend obligations and targeted
generation cover safe-integer edges, large sums and products, and negative
division/remainder. Random cases supplement these edges.

Calls run in isolated workers with deadlines. Results, exceptions, mutation,
console output, and deterministic replay are observed against the effect model.

## Evidence and reporting

The engine validates provenance, consumes certificates, runs targeted and
generated cases, shrinks failures, and replays them in fresh workers.

Every mismatch shows model/runtime inputs, expected/actual results or effects,
and a replay command. Decode failure cannot hide the model result. Sampling
includes its case count and seed.

Reports group by root cause. Single-target output fits within 25 lines and suite
output within one screen. Detailed text and JSON are deterministic.

## Architecture and trust

```text
source -> LemmaScript audit bundle -> exact model-value generator
       -> isolated model/runtime runners -> shrinker -> concise report
```

Crosscheck has a bundle client, representation bridge, isolated runners, audit
engine, and reporter—no manifest-authoring or generic configuration layer.

The trusted base is LemmaScript, the proof backend, certificates, codecs,
sandboxes, and comparison logic. Crosscheck does not prove the translator
correct; it searches independently for model/runtime disagreements.

## Release gates

The package is not publishable until source-only commands produce these results:

| Example | Required result |
|---|---|
| `binarySearch.ts` | incompatible unbounded-integer domain; safe executions may agree |
| `arraySum.ts` | exact precision counterexample with model and runtime values |
| `division.ts::threeHalves` | checked exact agreement for `1.5` |
| `division.ts::divide` | exact-real/binary64 counterexample such as `1 / 10` |
| `division.ts::floorDivision` | singleton domain terminates and checks |
| `bigintBits.ts` | checked agreement on valid nonnegative BigInt inputs |
| `nestedPush.ts` | detects input mutation absent from the formal model |
| optional-record example | detects omission versus present `undefined` |

Implementation order is: LemmaScript audit-bundle spike; numeric vertical
slice; targeted generation, shrinking, and concise output; composite values;
deployed-runtime and boundary mode; package hardening. No phase is complete if
users must author protocol scaffolding.

## Decisions to review

1. Default mode audits the proof domain; arbitrary-input boundary enforcement
   is opt-in.
2. Source-runtime execution is zero-config; deployed output requires
   `--runtime`.
3. Crosscheck is a separate package using a public LemmaScript audit-bundle API,
   not compiler internals.

The full rationale is retained in `DESIGN.md`.
