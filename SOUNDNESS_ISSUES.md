# Known soundness issues and how Crosscheck detects them

This is the inventory of issues collected in this repository, their detection
mechanisms, and the gaps in current coverage. The
[example walkthroughs](examples/README.md) explain each program's input, verified
prediction, JavaScript behavior, and cause; the adjacent `.out` files preserve
the observed reports and tool versions.

A LemmaScript proof establishes a property of its generated Dafny program.
Crosscheck tests whether that program describes the TypeScript execution.
Some findings demonstrate a false runtime postcondition; others establish a
different result, an unrepresented effect, or an input outside the proof's
domain. Those are different kinds of evidence.

## Detection is general

Crosscheck does not search a new program for a known example or a suspicious
operator. It verifies the source, generates inputs from its typed signature,
filters by preconditions, and observes executions. The examples exercise these
same mechanisms. A new aliasing bug can be detected without an alias analysis
when it changes an observed result on a generated input.

| Check | Inputs | Observation |
| --- | --- | --- |
| Differential, the default | Exact formal values satisfying the model's `requires`. Ordinary comparisons use faithful JavaScript representations; explicit numeric probes record any rounding. | Execute the compiled Dafny model and TypeScript; compare results, argument mutation, output, exceptions, and deadlines. |
| Runtime contract | TypeScript values, including fractional and non-finite numbers, satisfying `requires` evaluated with JavaScript semantics. | Execute TypeScript and evaluate `ensures` on its result and post-call arguments. Also test whether the input belongs to the verified parameter domain. |

Both modes first require successful LemmaScript verification. With
`--checks contract,differential`, a contract issue or incomplete contract check
is returned immediately; differential checking follows only a clean contract
check. Run the modes separately when investigating both kinds of evidence.

Input generation combines type-specific edges, parameter combinations, and
seeded random values. It is not constraint solving or source-level branch
coverage. The exact procedure lives in [ALGORITHM.md](ALGORITHM.md).

## Collected semantic causes

The links below lead to concrete explanations and recorded outputs. Several
causes share `result-mismatch`: that category establishes unequal outputs,
while the cause is determined by inspecting the source and generated model.

| Cause | Collected cases | Detection |
| --- | --- | --- |
| Arithmetic loses integer precision after an exact input arrives. | [Next ticket](examples/README.md#next-ticket); [integer-precision fixture](test/fixtures/integer-precision.ts). | Differential `result-mismatch`. |
| Exact real arithmetic differs from binary64. | [Split bill](examples/README.md#split-bill). | Convert the runtime number to its exact rational value, then compare it with the model result. |
| Distinct formal inputs collapse to the same JavaScript value. | [Request identity](examples/README.md#request-identity); search collision in [audit tests](test/audit.test.ts). | Numeric projection records both argument tuples; report `input-representation-mismatch` only when the result changes. |
| Number bitwise operations use 32-bit coercion and wrapping. | [Queue offset](examples/README.md#queue-offset). | Differential `result-mismatch` on an exactly representable input. |
| A runtime number is outside the mathematical input domain. | [NaN clamp](examples/README.md#nan-and-mutation-two-minimal-examples), [payment validation](examples/README.md#payment-validation); fractional search in [audit tests](test/audit.test.ts). | Runtime contract violation when an `ensures` fails; otherwise a witnessed domain gap can be reported. |
| Closures retain stale values in the generated model. | [Mutable scalar](examples/README.md#nan-and-mutation-two-minimal-examples), [discount preview](examples/README.md#discount-preview), [approval count](examples/README.md#approval-count), [closure fixtures](test/fixtures/closures.ts). | Differential result comparison; the `late` fixture also exercises contract checking. |
| Shared array or Map identity is lost. | [Undo history](examples/README.md#undo-history), [cart discount](examples/README.md#cart-discount), [feature rollout](examples/README.md#feature-rollout), `viaAlias` in the [closure fixtures](test/fixtures/closures.ts). | Differential result comparison after a mutation through an alias. |
| Shallow copies retain nested aliases; nested updates can be lost. | [Seat upgrade](examples/README.md#seat-upgrade), [calendar preview](examples/README.md#calendar-preview). | Differential result comparison. The calendar model also discards the mutation through an indexed receiver. |
| Structural record equality differs from object identity. | [Notification Set](examples/README.md#deduplicate-notifications), [object-key cache](examples/README.md#object-key-cache). | Differential comparison of the resulting boolean or price. |
| Missing properties and present `undefined` collapse into one optional value. | [Configuration defaults](examples/README.md#configuration-defaults). | Probe alternative property-presence representations and report `optional-presence`. |
| Unicode scalar counts differ from UTF-16 code-unit lengths. | [Launch badge](examples/README.md#launch-badge). | Differential result comparison under the recorded string semantics. |
| JavaScript changes caller-owned data absent from the value model. | [Audit log](examples/README.md#audit-log); [input-mutation fixture](test/fixtures/input-mutation.ts). | Compare argument encodings before and after the call, even when results agree. |

These observations do not imply that every use of numbers, closures, or mutable
collections fails. The [controls](examples/README.md#controls) cover exact bigint
IDs, separate arrays, an immutable capture, primitive Map keys, and a copied
nested member list. The closure fixture also checks `constantCapture`, which
returns `4` in both executions.

## Complete report-category inventory

These are all categories currently declared in
[report-types.ts](src/report-types.ts). Coverage is stated separately so an
implemented detector is not mistaken for a collected real-toolchain example.

| Category | What triggers it | Evidence in this repository |
| --- | --- | --- |
| `result-mismatch` | Both executions return, but the runtime value converted into the model's return type is unequal to the model result. | Most [example outputs](examples/README.md); [soundness integration tests](test/integration/soundness.test.ts). |
| `input-domain` | A precondition-valid formal input has no faithful JavaScript representation. That witness is not executed as an ordinary runtime input. | [Bridge tests](test/bridge.test.ts) cover inexact integers and rationals; [audit tests](test/audit.test.ts) save and replay valid union witnesses. No dedicated gallery output. |
| `input-representation-mismatch` | An explicit finite numeric projection rounds the formal input, and the projected JavaScript execution returns a different result. | [Request identity output](examples/request-identity.out); projected search and replay in [audit tests](test/audit.test.ts). |
| `proof-domain-gap` | An executed TypeScript input satisfies runtime `requires` but lies outside the verified parameter domain. Its runtime postconditions may still hold. | Fractional search witness `arr = [0.5], target = 0` in [audit tests](test/audit.test.ts), using test worker implementations; [bridge tests](test/bridge.test.ts). No dedicated gallery output. |
| `runtime-postcondition-violation` | Runtime `requires` holds, then a JavaScript `ensures` clause is false, or the call throws or exceeds its deadline. | [NaN output](examples/nan-and-mutation.out), [payment output](examples/payment-validation.out), and the `late` contract [integration test](test/integration/soundness.test.ts). |
| `input-mutation` | Results agree, but the deterministic argument encodings before and after the call differ. | [Audit-log output](examples/audit-log.out); `appendOne` in the [integration tests](test/integration/soundness.test.ts). |
| `optional-presence` | A present-`undefined` input variant changes the modeled result, or exposes present `undefined` in the result where the model has only absence. | [Configuration output](examples/config-defaults.out); [bridge tests](test/bridge.test.ts). |
| `console-output` | A call returns the expected result without input mutation, but emits captured console or standard output. | Capture is covered by a real [runtime-worker test](test/runtime-worker.test.ts). No dedicated verified example or category-level integration test. |
| `runtime-threw` | JavaScript throws on a faithful input while the model returns normally. | Implemented in [audit.ts](src/audit.ts) and [runtime-worker.ts](src/runtime-worker.ts); no dedicated verified example. |
| `runtime-timeout` | JavaScript exceeds the configured deadline while the model returns. This is deadline evidence, not a proof of nontermination. | Classification and witness retention use a simulated timeout in [audit tests](test/audit.test.ts); process recovery is tested in [json-line-client.test.ts](test/json-line-client.test.ts). No dedicated gallery output. |

For ordinary differential execution, the order is timeout, throw, result
mismatch, optional presence, input mutation, then captured output. Only one
finding is reported per target. Thus the seat example's wrong quote takes
precedence over its input mutation. Within the wider search, a rounding probe
or formal-domain witness can be retained while Crosscheck seeks a stronger
executed disagreement. These rules are implemented in [audit.ts](src/audit.ts).

The contract checker also recognizes domain failures such as infinities, `-0`,
lone surrogates, and sparse array holes in [bridge.ts](src/bridge.ts). Recognizing
a value is different from generating it or having a recorded counterexample
that reaches it. There is no separate `negative-zero-result` category: the
developer tutorial uses that name for a hypothetical extension.

## Supporting fixtures and blocked comparisons

The focused [soundness suite](test/integration/soundness.test.ts) checks these
additional named targets through the real toolchain and replays its findings:

| Fixture | Observed behavior asserted by the suite |
| --- | --- |
| [closures.ts](test/fixtures/closures.ts) | `late`: model `2`, runtime `6`; `stale`: `1` versus `2`; `viaAlias`: `0` versus `1`; `constantCapture`: both `4`. A separate contract run catches `late`'s false first postcondition. |
| [integer-precision.ts](test/fixtures/integer-precision.ts) | `increment(9007199254740992)` returns `9007199254740993` in the model and `9007199254740992` in JavaScript. |
| [input-mutation.ts](test/fixtures/input-mutation.ts) | `appendOne([])` changes the caller's array to `[1]` despite matching return values. |
| [closure-via-call.ts](test/fixtures/closure-via-call.ts) | `viaCall` currently emits invalid Dafny at its void helper call. The expected outcome is `NOT CHECKED`, with zero comparisons. This does not establish detection of mutation across helper calls. |

`NOT CHECKED` is a conclusion, not a soundness-issue category. Verification
failure, an unexecutable formal model, unsupported values or contracts, missing
runtime exports, and a search with no accepted input can all prevent a
comparison. The CLI uses exit `2` for this conclusion; an issue uses `1`, and
completed checks with no issue use `0`.

## Earlier collected problems in Crosscheck itself

[TODO.md](TODO.md) records exploratory case-study observations from an earlier
toolchain. They are useful evidence about the checker, but are not current
gallery snapshots. The inventory includes:

| Problem observed | Detection and current status |
| --- | --- |
| Shrinking fabricated invalid tagged-union and finite-string-union witnesses. | Inspection showed valid members had become `""`, replacing the original numeric failure. Formal `input-domain` witnesses now retain their original inputs; [audit tests](test/audit.test.ts) verify valid members, failure paths, and replay. General type-directed shrinking remains unfinished. |
| Sampled success missed wildcard and redirect behavior. | Inspection of generated cases found no `*` or `/`, so defining branches were not exercised. The generator still lacks source-literal guidance and a branch-coverage measure. Large parameter combinations can also consume the budget before useful later candidates. |
| Verified artifacts containing bodyless helpers could not be executed. | Dafny verification succeeded, then JavaScript model compilation failed. This is a `NOT CHECKED` coverage gap; the checker needs a trustworthy executable model to compare. |
| A board-sum case study exposed integer accumulation rounding. | The recorded observation is a result mismatch in the same arithmetic family as next-ticket. [Generation tests](test/generate.test.ts) retain the representable array witness `[9007199254740991, 2]`; the original case study is an optional external reproduction. |
| Some diagnostics obscured the evidence. | Human report inspection found unclear nested paths, missing search counts, and overly generic advice. The historical numeric-cause guess for arbitrary numeric results is now prevented by [audit tests](test/audit.test.ts); other reporting work is tracked in TODO. |

## Current coverage limits

- **Input and result identity:** the [codec](src/codec.ts) transports values
  without reference IDs. It cannot faithfully generate and replay arbitrary
  sharing between supplied arguments, or retain alias relationships between
  inputs and results. Identity-sensitive runtime contracts share this limit.
  The gallery's aliases and object keys are created inside the executed
  function, and their effects become observable scalar or record results.
- **State across calls:** workers reuse imported modules, but the formal model
  and replay case do not describe a stateful call sequence. Global-state,
  nondeterministic, or history-dependent behavior has no general replay guarantee.
- **Effects:** observation covers argument values, synchronous console/stdout,
  throws, and deadlines. It does not model files, networks, global mutation,
  direct stderr writes, or work after the synchronous return.
- **Search:** a missed candidate or branch can hide a real problem. A
  parameterless example exercises one input tuple; it does not explore ambient
  states or prove that the compiler handles that language feature generally.
- **Executable semantics:** async targets, unsupported value shapes or
  preconditions, and unexecutable models stop comparison. Runtime values such
  as `NaN` cannot be marshalled as an ordinary Dafny integer or real result;
  contract checking is needed for the NaN demonstrations in the gallery.
- **Trusted components:** Crosscheck relies on typed metadata, Dafny
  verification/compilation, the bridge, contract evaluators, and observation
  code. It tests transfer to JavaScript; it does not prove these components
  correct. See [DESIGN.md](DESIGN.md#trust-and-safety-boundary).

## Reproduce and extend the evidence

After [setup](README.md#installation), use `npm run examples:check` to verify
the gallery, compare its outputs, and replay every finding. This check is
opt-in. `npm run test:integration` runs the focused suite also used by CI
against LemmaScript `main`.

To investigate a new program, run the same CLI checks described in the
[example guide](examples/README.md#run-and-reproduce). Detection does not depend
on adding a catalog entry first. When a new witness is understood, record its
source, output, explanation, and any untested boundary; use the
[contribution guide](TUTORIAL_DEV.md#add-a-known-soundness-issue) for focused CI
coverage. A compiler fix may make an intentionally false contract fail
verification, which changes the expected demonstration.
