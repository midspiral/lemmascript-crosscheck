# lemmascript-crosscheck — user interface design

**Status:** proposal for review. This document defines the human-facing CLI.
The semantic engine is specified in `DESIGN_OPERATIONAL.md`; this document
controls how its evidence is explained without exaggeration or noise.

## 1. UI objective

After a run, a user should immediately understand:

1. whether an issue was found;
2. what concrete input demonstrates it;
3. what the verified model expected;
4. what JavaScript did instead;
5. why those differ;
6. what decision or change could resolve it; and
7. how strong the evidence is.

The default output is a diagnosis, not an obligation log. Internal rule names,
hashes, backend commands, and every probe remain available, but never compete
with the conclusion.

## 2. Separate conclusion from evidence

The UI has three user-facing conclusions:

- **ISSUE FOUND** — a formal query or concrete witness disproved transfer.
- **NO ISSUE FOUND** — the completed checks found no disagreement in their
  stated scope.
- **NOT CHECKED** — required semantics were unsupported or the run failed
  before a claim could be made.

Evidence strength is displayed separately:

- **proved** — a backend-checked universal transfer obligation;
- **exhaustive** — every value in a finite input domain was executed;
- **sampled** — a stated number of generated values was executed;
- **counterexample** — one replayed witness demonstrates an issue;
- **tool failure** — verification or execution infrastructure failed.

This prevents `PROVED`, `CHECKED`, and `INCOMPATIBLE` from forcing users to
decode both outcome and epistemic strength from one label.

Exit codes retain the operational policy:

```text
0  all targets report NO ISSUE FOUND
1  at least one target reports ISSUE FOUND
2  at least one target reports NOT CHECKED
```

In a mixed run, exit 2 takes precedence, while all issues remain visible.

## 3. Default single-target report

The report is ordered as:

```text
target and conclusion
one-sentence diagnosis
source location, when justified
witness
expected versus actual
cause
resolution
replay
evidence scope
```

It should normally fit within 25 terminal lines.

### 3.1 Executable counterexample

```text
arraySum — ISSUE FOUND
Result differs from the verified model at arraySum.ts:18.

Input
  arr         [9007199254740991, 2]

Result
  verified    9007199254740993
  JavaScript  9007199254740992

Cause
  The addition exceeds JavaScript's safe-integer range.

Resolve
  Use bigint, or prove that every accumulator remains a safe integer.

Replay
  lemmascript-crosscheck examples/arraySum.ts --replay 7f31a2

Evidence: replayed counterexample · Dafny 4.11 model
```

“Verified” names the expected model result; “JavaScript” names the observed
runtime result. The UI does not use the ambiguous words “left/right,”
“reference,” or “candidate.”

### 3.2 Formal-only witness

Some failures prove that the formal domain is wider than the runtime domain.
Such a witness cannot be executed faithfully in JavaScript:

```text
binarySearch — ISSUE FOUND
The proof accepts an integer JavaScript cannot represent exactly.

Formal witness
  arr[0]      9007199254740993

JavaScript number cannot encode this integer. This is a proof/runtime domain
mismatch, not an executed test failure.

Resolve
  Use bigint, or restrict and prove the accepted integer range.

Evidence: proved domain counterexample
```

The report must explicitly distinguish a formal witness from a runtime call.
It must never print a rounded JavaScript value as though it were the witness.

### 3.3 Effect mismatch

```text
pushItem — ISSUE FOUND
The JavaScript function mutates an input absent from the verified model.

Input before  items = []
Input after   items = [0]
Return        [0]

Cause
  Dafny models items as an immutable sequence, but JavaScript push changes the
  caller's array.

Resolve
  Return a new array, or add the mutation to the formal effect model.

Replay
  lemmascript-crosscheck examples/nestedPush.ts --replay 91bc02

Evidence: replayed counterexample
```

Effects are described observationally. The UI does not call a function
“impure” unless that term helps explain a declared model.

### 3.4 No issue found

Evidence scope must immediately follow the conclusion:

```text
floorDivision — NO ISSUE FOUND
Evidence: exhaustive input domain (the function has no parameters).
```

For sampling:

```text
linearSearch — NO ISSUE FOUND
Evidence: 100 sampled proof-valid inputs · seed 17 · not a proof
```

The UI never says “all good,” “safe,” or “verified” when only sampling ran.

### 3.5 Not checked

```text
loadUser — NOT CHECKED
This target performs asynchronous ambient I/O, but Crosscheck has no async
effect model. Nothing was executed and no compatibility claim was made.

Next step
  Model the async effect protocol before auditing this target.
```

Tool failures use the same conclusion but clearly identify the failure:

```text
arraySum — NOT CHECKED
Dafny exited before producing the verified model.

Run with --debug to see the backend command and stderr.
```

Unsupported semantics and broken tooling remain distinct in detailed and JSON
output even though both prohibit a compatibility conclusion.

## 4. Root-cause grouping

One semantic problem often causes several internal obligations to fail. The UI
must not present downstream consequences as independent issues.

For example, one unsafe addition can cause:

- an unrepresentable result;
- runtime/model inequality;
- inability to evaluate a postcondition; and
- failure of a result-range obligation.

The default UI reports one issue: **integer precision changes the result**.
Secondary consequences appear only under `--explain`.

Two findings remain separate when they have independent witnesses or repairs.
For `arraySum`, these may be:

1. the proof accepts unrepresentable input elements; and
2. representable elements can combine into an unrepresentable sum.

The engine records a causal graph. The renderer selects root nodes, attaches
downstream observations, and orders roots by:

1. concrete wrong behavior;
2. formal/runtime domain mismatch;
3. effect mismatch;
4. boundary mismatch; and
5. incomplete evidence.

This ordering is presentation policy, not severity inference.

## 5. Source locations and explanations

A source location is printed only when the audit bundle ties the finding to a
specific typed operation or declaration. When available:

```text
arraySum.ts:18
  sum = sum + arr[i]
        ^^^^^^^^^^^^ may leave the safe-integer range
```

If a differential execution finds a mismatch but cannot localize its cause,
the UI says:

```text
The mismatch was observed at the return value; Crosscheck could not localize
the responsible operation.
```

It must not guess a line from stack traces or suspicious syntax.

`--explain <issue-id>` expands:

- the semantic relation that failed;
- how the witness was obtained;
- source and model locations;
- downstream consequences;
- proof versus sampled evidence; and
- representation details needed to understand the cause.

Internal rule identifiers may appear here, after their plain-language name.

## 6. Resolutions

Each issue includes one concise resolution decision. The UI must not emit a
generic checklist.

Some problems have two legitimate semantic choices. Present them as branches
of one decision:

```text
Resolve
  Make the numeric domains match:
  - arbitrary integers: use bigint end to end;
  - number API: add and prove safe-integer bounds.
```

Suggestions must come from the violated semantic rule. Crosscheck does not
claim an automatic code fix when it cannot prove that the fix preserves the
intended API.

## 7. Replay and witness display

Every executable issue receives a stable issue ID and replay command:

```text
lemmascript-crosscheck source.ts --replay 7f31a2
```

The ID is derived from target, semantic category, source site, and minimized
witness—not display order. Reordering findings must not change it.

Small witnesses are printed in full. Large arrays, records, or strings show a
bounded preview plus the replay command. Special values use unambiguous syntax:

```text
0n  NaN  +Infinity  -Infinity  -0  <hole>  <omitted>
```

Exact integers that cannot be JavaScript numbers are labeled formal values,
not rendered as executable JavaScript literals.

## 8. Multi-target and directory reports

The default suite view is one row per target, ordered by conclusion:

```text
7 targets · 3 issues · 1 not checked · 3 with no issue found

ISSUE        arraySum       result differs: integer precision
ISSUE        binarySearch   proof accepts unrepresentable integers
ISSUE        pushItem       mutates an input absent from the model
NOT CHECKED  loadUser       async effects unsupported
NO ISSUE     shiftWide      sampled 100 inputs
NO ISSUE     low64          sampled 100 inputs
NO ISSUE     floorDivision  exhaustive singleton domain

Explain an issue: lemmascript-crosscheck examples/ --explain arraySum/7f31a2
```

Rows contain conclusion, target, and one root-cause summary. If a target has
additional independent issues, append `+N more`; do not expand them inline.

Directory output should fit within one terminal screen when practical. For
large repositories, show all issue/not-checked rows, summarize clean targets,
and offer `--all` to display every row.

## 9. Boundary-mode presentation

Boundary findings appear only when `--boundary` was requested:

```text
binarySearch boundary — ISSUE FOUND
Invalid inputs are not deliberately rejected.

Example
  input       arr = {}, target = 0
  expected    PreconditionError
  observed    returned -1

Also affects
  sparse arrays, fractional elements, NaN, infinities, unsafe integers

Resolve
  Validate and reject before calling the verified implementation.
```

Related probes are summarized under one finding. The count of internal probes
is evidence under `--explain`, not a user-facing issue count. An incidental
native exception is displayed as observed behavior, not successful rejection.

## 10. Progressive disclosure

The CLI has four output depths:

```text
default                 diagnosis or suite rows
--explain <issue-id>    complete explanation of one issue
--details               all findings and evidence, still human-oriented
--debug                 raw obligations, provenance, commands, and tool output
--json                  stable lossless machine report
```

`--details` must not revert to an ungrouped obligation wall. `--debug` is the
only mode intended primarily for Crosscheck developers.

JSON preserves conclusions, evidence kinds, causal relationships, witnesses,
locations, suggested resolutions, and replay IDs. Human rendering must be a
pure projection of this report; it cannot reclassify results.

## 11. Progress and terminal behavior

On an interactive terminal, long work uses one updating stderr line:

```text
Checking 7 targets · verifying Dafny · 12s
```

It is replaced as phases change and cleared before the report. Heartbeats do
not accumulate into a log. Non-interactive runs print no progress unless
`--verbose` is requested.

Human output uses color and symbols only as redundant decoration. Text labels
carry the complete meaning. The UI respects `NO_COLOR`, redirected output,
terminal width, and Unicode capability. Tables fall back to space-separated
rows without relying on alignment for interpretation.

Standard output contains only the final report. Progress and debug logs use
standard error. `--json` emits one JSON value on stdout.

## 12. Language rules

Prefer:

- “verified model” over “oracle”;
- “valid according to the proof” over “formal-domain member”;
- “JavaScript cannot represent this exactly” over “encoding failure”;
- “no issue found in 100 sampled inputs” over “passed”; and
- “not checked” over a cascade of “unassessed obligations.”

Avoid:

- “safe,” unless universally established for the stated scope;
- “proved,” for runtime sampling;
- “tolerated,” for invalid input;
- “expected failure,” when a real issue caused exit 1; and
- internal codes in default output.

Every claim states its subject. “Dafny proof succeeded” and “JavaScript matched
in 100 cases” must never be collapsed into “the function is verified.”

## 13. UI acceptance criteria

The UI is acceptable when:

- a new reader can identify the main problem from the first five lines;
- `arraySum` produces one precision root cause with exact expected/actual data;
- binary search distinguishes a formal-only witness from runtime execution;
- mutation shows before/after state;
- sampled success explicitly says it is not proof;
- unsupported semantics appear once with a next step;
- boundary probes group by contract failure;
- suite output is one row per target and normally one screen;
- every executable issue has a stable replay command;
- default output contains no hashes or obligation codes;
- `--details` remains explanatory rather than diagnostic noise;
- `--json` is deterministic; and
- meaning does not depend on color, symbols, or terminal alignment.

## 14. Decisions to review

1. Use the three conclusions `ISSUE FOUND`, `NO ISSUE FOUND`, and
   `NOT CHECKED`, with evidence strength shown separately.
2. Organize suite output by target, while grouping downstream failures by
   semantic root cause within each target.
3. Include concise semantic resolution guidance by default, without claiming
   automatic fixes.

These choices should be accepted or changed before the renderer is
implemented.
