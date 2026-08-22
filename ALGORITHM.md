# LemmaScript Crosscheck algorithm

**Status:** exact operational description of the v0.1.0 implementation.

[DESIGN.md](DESIGN.md) states the product contract and design rationale. This
document states the concrete procedure implemented in `src/`, including search
order, comparison precedence, counters, and known implementation quirks. It is
intentionally descriptive: a behavior recorded here is not necessarily a
recommendation for a future version.

## 1. Semantic question

For a selected function, let:

- `m` be a tuple of exact formal argument values;
- `P(m)` mean that every typed LemmaScript `requires` clause evaluates to
  exactly `true`;
- `B(m)` be the partial bridge from formal values to JavaScript values;
- `Q(m)` be the explicitly recorded finite numeric projection used only by
  input-rounding probes;
- `M(m)` be the result of the compiled, verified Dafny model; and
- `J(B(m))` be the observed JavaScript execution.

For every generated `m` for which `P(m)` is true and `B(m)` succeeds, the principal
comparison is

```text
Dafny.areEqual(M(m), marshalAsDafny(returnType, J(B(m)).result))
```

The comparison is performed in Dafny value space. In addition, Crosscheck
requires the runtime call to return synchronously, leave its arguments
unchanged, and emit no captured console or standard output.

If `P(m)` is true but `B(m)` cannot preserve the formal value exactly, `m` is
an `input-domain` witness. It is never passed to JavaScript as though the
bridge were faithful. When the only loss is a finite `number` conversion,
Crosscheck may additionally call `J(Q(m))`, retaining `m` for the model and
recording every changed numeric path. An unequal normal return is an
`input-representation-mismatch`; otherwise the ordinary domain witness remains.

Crosscheck searches a finite, deterministic candidate sequence. Agreement is
therefore sampled evidence, except for a zero-parameter function, whose input
domain contains the single tuple `[]`.

## 2. Whole-file procedure

`auditFile` in [`src/audit.ts`](src/audit.ts) implements the following order:

```text
AUDIT_FILE(source, options):
  verified := VERIFY_AND_INSPECT(source, options.verifyTimeoutMs)

  if replay is active and verified.sourceHash != replay.sourceSha256:
    fail the entire audit

  compiled := COMPILE_VERIFIED_DAFNY(
    verified.artifact,
    verified.artifactHash,
    verified.dafnyVersion,
    options.verifyTimeoutMs)

  selected := exported functions in typed-info order
              filtered by options.only, if present
  fail if options.only names no selected function
  fail if selected is empty

  runtimePath := absolute path of, in precedence order:
    1. an explicit --runtime path;
    2. the runtime recorded by a replay case; or
    3. the verified source itself

  runtimeHash := SHA-256(runtimePath contents)
  if replay is active and runtimeHash != replay.runtimeSha256:
    fail the entire audit

  start one restartable model worker, then one restartable runtime worker
  for fn in selected, sequentially:
    append AUDIT_TARGET(fn) to the report
  close both workers in a finally block
  return report schema lemmascript-crosscheck.report/v1
```

### Verification and model compilation

`VERIFY_AND_INSPECT` performs these operations in this order:

1. Resolve and read the source, recording its SHA-256 hash.
2. Run `lsc version` with a 30-second deadline and require release line
   `0.6.x`.
3. Run `lsc info --typed <source>` with a 60-second deadline; parse JSON and
   require typed-info schema `1`.
4. Reject a Lean backend and any `info.dafny.error`.
5. Run `dafny --version` with a 30-second deadline and require release line
   `4.11.x`.
6. Run `lsc check --backend=dafny <source>` with `--verify-timeout`.
7. Hash the source again and fail if it changed.
8. Locate the adjacent `<source-base>.dfy` artifact and hash it.

When `LEMMASCRIPT` is set, `lsc` means Node plus `tsx` running
`$LEMMASCRIPT/tools/src/lsc.ts` with that checkout as its working directory.
Otherwise it means `lsc` from `PATH`.

The model compiler first verifies the artifact hash, then computes a 20-hex
cache key from the artifact text, the resolved `bignumber.js` path, and the
exact Dafny version. On a cache miss it runs:

```text
dafny build -t js --no-verify --allow-warnings \
  --optimize-erasable-datatype-wrapper false \
  [--standard-libraries when the artifact contains "Std."] \
  -o <content-addressed-output> <artifact>
```

It rewrites the generated `bignumber.js` import to the resolved dependency,
requires the generated file to expose the expected `_dafny` and `_module`
bindings, appends CommonJS exports for those bindings, and checks the artifact
hash again after a cache-miss compilation. A setup or compilation failure is a
file-level failure, not a per-target result.

## 3. Target eligibility

The runtime export is `options.entries.get(fn.name) ?? fn.name`.

Before generating inputs, `supportReason` rejects the target on the first of
these conditions:

1. the function has type parameters;
2. `autohavoc` is set or `bodyKinds` contains `havoc` or `assume`;
3. a parameter type is unsupported, in parameter order; or
4. the result type is unsupported.

Type support is checked recursively as follows:

| Type | Support rule |
| --- | --- |
| Boolean, natural, integer, real, string | Supported. |
| Array, set, optional | Its element/inner type must be supported. |
| Tuple | Every element, from left to right, must be supported. |
| Map | The key, then the value, must be supported. |
| User type | Its declaration must exist and be non-generic, non-opaque, and non-recursive along the current traversal; every declared field must have a resolved supported type; an alias target must also be supported. |
| `void` | Unsupported. |
| Function or unknown type | Unsupported. |

An ineligible target immediately reports `NOT CHECKED` with zero cases.
Whether a runtime export exists and whether it returns a promise are discovered
later by execution, not by this eligibility pass.

## 4. Candidate sequence

Let `N = --cases` and let parameters be `p[0] ... p[k-1]`. `candidateCases` in
[`src/generate.ts`](src/generate.ts) returns `[[]]` when `k = 0`. Otherwise it
constructs candidates in this exact order:

```text
edges[i]    := EDGE_VALUES(type(p[i]))
baseline[i] := edges[i][0] when present;
               otherwise recompute EDGE_VALUES and fail with "no generator"

candidates := [baseline]

for i = 0 .. k-1:
  for value in edges[i], in order:             // includes edges[i][0]
    append baseline with position i replaced by value

for every pair 0 <= i < j < k, lexicographically:
  for left in first 12 values of edges[i]:
    for right in first 12 values of edges[j]:
      append baseline with positions i and j replaced

rng := RNG(seed)                                // reset for each target
repeat max(4*N, 40) times:
  append one recursively generated random tuple

return stable first-occurrence deduplication of candidates
```

Thus, when every parameter has at least one edge, before deduplication a
parameterized target has

```text
1 + sum_i |edges[i]|
  + sum_{i<j} min(12, |edges[i]|) * min(12, |edges[j]|)
  + max(4*N, 40)
```

candidates. The baseline is deliberately produced more than once and removed
by final deduplication.

### Scalar edge values

Let `S = 9_007_199_254_740_991`, JavaScript's maximum safe integer.

| Type | Values, in order |
| --- | --- |
| Boolean | `false`, `true` |
| Natural | `0, 1, 2, 3, 7, 10, 2147483647, 2147483648, S-1, S, S+1, S+2` |
| Integer | `0, 1, -1, 2, -2, 3, -3, 7, -7, 10, -10, 2147483647, 2147483648, -2147483648, S-1, S, S+1, S+2, -S, -(S+2)` |
| Real | exact rationals `0, 1, -1, 1/2, 3/2, 1/10, -1/10, 1/3` |
| Unrestricted string | `""`, `"a"`, `"0"`, `"é"`, `"😀"` |
| Finite string type | Its declared values, in declaration order |

Integers in this table are formal `bigint` values, including integers whose
TypeScript surface type is `number`.

### Composite edge values

- Array edges are, in order: `[]`; singleton arrays for the first 16 element
  edges; adjacent pairs among the first 12 element edges; and, for integer or
  natural elements, `[S,1]`, `[S,2]`, `[2,S]`, `[S+2]`, `[0,0]`, and
  `[0,1,2]`. Integer arrays additionally receive `[-S,-2]` and `[-1,0,1]`.
  The result is stably deduplicated.
- A tuple starts with the tuple of element baselines. For each position in
  order, it then substitutes the second through fifth edge of that element,
  one position at a time.
- An optional starts with `undefined`, followed by the first six inner edges.
- A set starts with the empty `Set`, followed by singleton sets for the first
  five element edges.
- A map starts with the empty `Map`, followed by up to four singleton maps.
  Key `i` is paired with value edge `i mod max(valueEdgeCount, 1)`; malformed
  metadata that supplies no value edge consequently supplies `undefined`.
- A string union uses its declared values.
- An alias uses the aliased type's edges.
- A record starts with every field at its baseline. It then changes one field
  at a time to that field's second through fifth edges, in field order.
- An ordinary discriminated union gets one baseline object per variant, in
  variant order. The discriminant is the variant name and every other variant
  field is at its baseline.
- A synthetic `__isArray__` union concatenates the first four edges of the
  first payload field of each variant.

The eligibility pass is expected to reject missing, recursive, generic,
opaque, or unresolved declarations before these routines run.

### Pseudorandom values

The generator is Mulberry32 with unsigned 32-bit state initialized by
`seed >>> 0`:

```text
next():
  state := (state + 0x6d2b79f5) mod 2^32
  x := imul(state xor (state >>> 15), state or 1)
  x := x xor (x + imul(x xor (x >>> 7), x or 61))
  return unsigned(x xor (x >>> 14)) / 2^32
```

`int(a,b)` is uniform by `a + floor(next() * (b-a+1))`; both endpoints are
included. `pick` uses that operation.

Random values are generated as follows:

| Type | Rule |
| --- | --- |
| Boolean | `next() < 0.5`. |
| Natural/integer | With probability `0.3`, pick an edge. Otherwise choose magnitude uniformly from `0..1_000_000`; naturals stay nonnegative and integers use another fair sign choice. |
| Real | Numerator uniform in `-1_000_000..1_000_000`; denominator picked from `1,2,4,8,10,16,3`; normalize as a `Rational`. |
| String | Finite strings pick a declared member. Otherwise choose length `0..8` and independently concatenate entries from `a,b,0,é,😀`. |
| Array | Choose length `0..7` and recursively generate elements. For a direct numeric element type, sort with probability `0.35`. |
| Tuple/record | Recursively generate every component/field in order. |
| Optional | Absent with probability `0.25`; otherwise recursively generate the inner value. |
| Set/map | Repeatedly generate elements/entries, with at most five loop iterations. The current implementation samples a fresh bound in `0..5` at every loop-condition check rather than sampling a size once. |
| String union | Pick a declared member. |
| Alias | Generate through the alias target. |
| Discriminated union | Pick a variant uniformly and recursively generate its payload fields; synthetic array unions return only the chosen payload. |

At recursive depth greater than four, generation returns the type's first edge
instead. Random calls are consumed in traversal order, so changing a preceding
parameter's shape changes later random values.

Deduplication uses the tagged wire encoding described in section 9 and keeps
the first occurrence.

## 5. Preconditions

For each candidate, `satisfiesPreconditions` binds formal parameter names to
the exact candidate values and evaluates `requires` clauses from left to right.
It returns false as soon as a clause produces anything other than the boolean
`true`. Clauses are not evaluated in JavaScript number semantics.

The interpreter in [`src/spec.ts`](src/spec.ts) supports:

- variables, lazily evaluated typed constants, and `undefined`/`null` as the
  same absent value;
- booleans, strings, big integers, and typed numeric literals;
- unary `!`, unary `-`, and unary `+`;
- short-circuit `&&`, `||`, implication, equivalence, equality, inequality,
  membership, comparisons, string concatenation, and numeric `+ - * / %`;
- conditionals and nullish coalescing;
- field access, indexing, arrays, record literals and one record spread;
- optional matches, discriminated-union matches, and field/index optional
  chains; and
- `includes`, `indexOf`, `Set.has`, `Map.has`, and `toNat` method forms.

Typed numeric literals first pass through JavaScript `Number`. An integral
literal whose result type is integer/natural is then converted to `bigint`; any
other numeric literal is parsed from `String(number)` as a decimal `Rational`.
After that decoding, integer arithmetic uses `bigint`. Any division or
arithmetic involving a real uses normalized `Rational` values; division is
exact. Unary `!` means “the operand is not exactly `true`.” Boolean connectives
also test exact `true` and short-circuit. Numeric equality accepts
integer/rational cross-comparison. Arrays and records use recursive structural
equality, while sets and maps use order-independent extensional equality.
String ordering uses JavaScript's ordinary string `<`/`>` ordering.

A call whose callee is a variable is delegated to the model worker. The callee
must appear in typed-info. Its exact arguments are marshalled to the compiled
Dafny function, and its result must be decodable to a formal value. Model-result
decoding currently exists for booleans, integers, naturals, reals, strings,
arrays, tuples, sets, maps, and `void` as `undefined`; optional and user-defined
results are not decodable for this purpose.

Quantifiers, `havoc`, unbound names, unrecognized operations, and unsupported
value accesses throw `SpecUnsupported`. The target becomes `NOT CHECKED` on the
first candidate that reaches such an expression. A false branch that
short-circuits around an unsupported expression remains a normal false
precondition.

Precondition outcomes are classified as:

| Event | Candidate outcome |
| --- | --- |
| Every clause is exactly `true` | Continue to the representation bridge. |
| A clause is not exactly `true` | `invalid`; silently skip it. |
| Unsupported expression | `not-checked`; stop the target. |
| Model predicate timeout | `not-checked`; stop the target. |
| Any other evaluator/model failure | `not-checked`; stop the target. |

## 6. Formal-to-JavaScript bridge

`encodeRuntime` in [`src/bridge.ts`](src/bridge.ts) recursively constructs a
fresh canonical runtime value. The first failure returns its formal path,
reason, and exact offending value.

| Formal type | Canonical JavaScript encoding |
| --- | --- |
| Boolean/string | The same primitive after a type check. |
| `bigint`-backed integer/natural | The exact `bigint`; naturals must be nonnegative. |
| `number`-backed integer/natural | `n := Number(m)` only when `n` is finite and integral and `BigInt(n) === m`. This admits `S+1` but rejects `S+2`. |
| Real | `n := Number(numerator) / Number(denominator)` only when finite and `Rational.fromDouble(n)` equals the exact formal rational. |
| Array/tuple | A fresh array, recursively encoded; tuple arity must match. |
| Optional | `undefined` for either formal `undefined` or `null`; otherwise encode the inner value. |
| Set | Accept a formal `Set` or array and return a fresh JavaScript `Set` of recursively encoded values. |
| Map | Accept a formal `Map` or non-array object and recursively encode its entries. If the available TypeScript spelling starts with `Map<`, return a JavaScript `Map`; otherwise return an object whose keys are `String(encodedKey)`. |
| String union | The same string after membership validation. |
| Alias | Encode through its resolved target. |
| Record | Copy declared fields only. Omit an optional field whose formal value is `undefined` or `null`; recursively encode every other declared field. |
| Discriminated union | Select the declared variant by tag and copy its tag and payload fields. A synthetic `__isArray__` union selects its branch with `Array.isArray`. |

Object-shaped map construction uses `Object.fromEntries`; string-key
collisions therefore follow JavaScript's last-write-wins behavior. The current
bridge does not separately reject such a collision.

If the bridge fails after a precondition-valid candidate, that candidate is
`unrepresentable`. The first such candidate is remembered, but the search
continues for an executable issue.

`projectRuntime` uses the same recursive type and shape checks but permits a
finite inexact conversion at a number-backed integer, natural, or real. It
returns the projected JavaScript value together with `(path, formalValue,
runtimeValue)` for every such conversion. It still rejects malformed formal
values and non-finite projections. This operation is never used for a
canonical comparison.

`numericPrecisionVariants` derives additional formal inputs from a concrete
typed argument shape. It considers at most the first eight number-backed
numeric sites, traversing parameters and nested values deterministically. For
each site it substitutes `2^53 + 1`; for each pair it tries both orientations
of `2^53` and `2^53 + 1`. Both are exact formal values, but JavaScript converts
the latter to the former. The walk covers arrays, tuples, present optionals,
sets, maps, aliases, records, and the active discriminated-union branch. It
does not inspect the function name, body, or equality operator.

## 7. One comparison

The nested `evaluate` operation in `auditTarget` has five possible outcomes:
`invalid`, `unrepresentable`, `clean`, `issue`, and `not-checked`. Its exact
control flow is:

```text
EVALUATE(formalArgs, variant = none):
  valid := evaluate all verified preconditions over formalArgs
  on unsupported/failed precondition: return not-checked
  if not valid: return invalid

  canonicalArgs := bridge(formalArgs)
  if bridge failed and variant is not numeric-projection:
    return unrepresentable(failure)

  actualRuntimeArgs := variant.args when a variant exists, otherwise canonicalArgs
  call the runtime worker first

  if the runtime request exceeds --timeout:
    if variant is numeric-projection: return clean
    call the model without a runtime result
    if the model returns: return issue(runtime-timeout)
    otherwise: return not-checked

  if the runtime reports a promise: return not-checked(async target)
  if the runtime reports a missing/non-function export: return not-checked
  if the runtime worker otherwise fails: return not-checked

  if the runtime threw:
    if variant is numeric-projection: return clean
    call the model without a runtime result
    if the model returns: return issue(runtime-threw)
    otherwise: return not-checked

  call the model with formalArgs and the encoded runtime result
  if model invocation or result marshalling fails:
    if variant is numeric-projection: return clean
    return not-checked

  if model.equal is not exactly true:
    return issue(input-representation-mismatch for numeric-projection,
                 optional-presence for optional-presence,
                 otherwise result-mismatch)

  if variant is numeric-projection: return clean

  if variant is optional-presence and the runtime result contains a supported
     optional record field that is present with value undefined:
    return issue(optional-presence)

  if encoded runtime arguments before and after differ:
    return issue(input-mutation)

  if at least one captured output string exists:
    return issue(console-output)

  return clean
```

Numeric projection is currently a result-only probe. A projected timeout,
throw, mutation, or output does not become an
`input-representation-mismatch`; the underlying exact input remains an
`input-domain` witness. Worker setup and protocol failures retain their
ordinary `not-checked` behavior when they reach the main or replay path.

### Worker observations

The runtime worker imports the selected module through `tsx`. Output during
module import is redirected to worker standard error and is not a finding.
For each synchronous call it records:

- a tagged encoding of the arguments before the call;
- the return value;
- the arguments after the call;
- `console.log`, `info`, `debug`, `warn`, and `error` calls, formatted with
  Node's `util.format`; and
- text written directly through `process.stdout.write` during the call. Each
  chunk has at most one trailing newline removed and is split into lines; a
  chunk is ignored only if every resulting line is empty, otherwise every
  resulting line (including internal empty lines) is appended.

A returned thenable is `unsupported`, not awaited. A thrown value is recorded
with its argument snapshots and prior output. Direct `stderr` writes, ambient
state, filesystem/network effects, and work scheduled after the synchronous
return are not observations in this relation.

The model worker converts formal arguments to Dafny values and calls the
compiled function. When given a runtime result, it marshals that result as the
declared return type and calls Dafny's generated `areEqual`.

- Runtime integer results may be `bigint` or any finite integral `number`; a
  number is converted from its actual JavaScript decimal value.
- A finite runtime real is converted with `Rational.fromDouble`, which recovers
  the exact IEEE-754 binary64 rational, before Dafny comparison.
- `undefined` and `null` both marshal to formal `None`.
- Strings containing a lone UTF-16 surrogate cannot be marshalled.
- Composite values are recursively converted to Dafny sequences, tuples,
  sets, maps, options, records, and datatypes.

A runtime result of the wrong shape, a non-integral integer result, `NaN`, or
an infinity cannot be marshalled. That prevents the comparison and yields
`NOT CHECKED`; it is not classified as an unequal result.

Argument mutation uses byte-for-byte equality of the deterministic tagged
encodings. Object keys are sorted by Unicode code point; `Set` and `Map`
iteration order is retained. Consequently, a set/map iteration-order change is
observable to this check even if its mathematical membership is unchanged.

### Worker deadlines and recovery

Every setup and call request has a deadline. On a process-level error or
timeout, the current child is discarded. The next request starts a new child
and repeats its original setup. The workers are separate, so after a runtime
timeout the model can still be called to decide whether the timeout is a
concrete mismatch. Child processes are isolation boundaries for crashes and
ordinary nontermination, not security sandboxes.

## 8. Optional-property presence probes

Presence probes run only after a canonical call is `clean`, and never during
replay. They enumerate one alternate JavaScript representation at a time for a
formal absent optional record field:

```text
{ field omitted }  ->  { field: undefined }
```

Traversal is deterministic: parameters in order, array elements in order,
aliases through their target, then record fields in declaration order. It
recurses through arrays, present optionals, aliases, and records. It does not
currently search through tuples, sets, maps, or discriminated unions, and it
does not generate combinations in which two absent fields are simultaneously
present.

Each variant receives the full `EVALUATE` procedure with the same formal
arguments and the altered runtime arguments. The first `issue` or
`not-checked` result stops variant enumeration. Variant calls do not increment
the reported case counter.

If the variant's result differs from the model, the category is
`optional-presence`. If values compare equal, Crosscheck additionally searches
the returned value for a present-`undefined` optional record field. That result
search traverses arrays, tuples, present optionals, aliases, and records. If no
presence-specific mismatch exists, ordinary mutation and output checks still
apply to the variant; timeout and throw classification can also occur before
result comparison. The current observation object retains alternate runtime
arguments and `presencePath` for `optional-presence` result findings, but not
for an ordinary timeout, throw, mutation, or output category discovered while
running a presence variant. Such an ordinary-category case is therefore
identified and persisted using only its formal arguments.

## 9. Tagged wire values

All worker messages, stable keys, argument snapshots, saved witnesses, and
issue identities use `encode` from [`src/codec.ts`](src/codec.ts). Ordinary
JSON values remain ordinary JSON; the following require tagged objects:

- `undefined`;
- `bigint`;
- normalized rationals;
- `NaN`, positive/negative infinity, and negative zero;
- sparse arrays, including their length and present indices;
- sets and maps; and
- ordinary objects, represented as key/value entry arrays.

Object entries are sorted by Unicode code point. Array order and set/map
iteration order are retained. `stableKey(v)` is exactly
`JSON.stringify(encode(v))`; encoded equality is exact JSON-string equality.

## 10. Search loop, counting, and precedence

The target loop is equivalent to:

```text
cases := replay ? [decode(replay.args)] : CANDIDATES(fn, N, seed)
checked := 0
firstDomainWitness := none
firstProjectedIssue := none
precisionTried := empty set
incomplete := none

for formalArgs in cases:
  if not replay and checked >= N: break

  replayVariant := the saved optional-presence or numeric-projection variant,
                   when replaying one
  outcome := EVALUATE(formalArgs, replayVariant)

  if outcome is invalid:
    continue

  if outcome is not-checked:
    incomplete := outcome
    break

  if outcome is unrepresentable:
    remember it only if firstDomainWitness is empty
    projected := PROJECT_NUMERIC(formalArgs)
    if projected records at least one loss:
      projectedOutcome := EVALUATE(formalArgs, numeric-projection(projected))
      if projectedOutcome is input-representation-mismatch and
         firstProjectedIssue is empty:
        firstProjectedIssue := projectedOutcome
    continue

  checked := checked + 1                 // clean or executable issue
  selectedOutcome := outcome

  if outcome is clean and not replay:
    for variant in OPTIONAL_PRESENCE_VARIANTS(formalArgs):
      variantOutcome := EVALUATE(formalArgs, optional-presence(variant))
      if variantOutcome is issue or not-checked:
        selectedOutcome := variantOutcome
        break

    if selectedOutcome is clean and firstProjectedIssue is empty:
      for precisionVariant in NUMERIC_PRECISION_VARIANTS(formalArgs):
        skip a site/path key already in precisionTried
        add its key to precisionTried
        exactOutcome := EVALUATE(precisionVariant.formalArgs)
        if exactOutcome is unrepresentable:
          remember it only if firstDomainWitness is empty
          projected := PROJECT_NUMERIC(precisionVariant.formalArgs)
          projectedOutcome := EVALUATE(
            precisionVariant.formalArgs,
            numeric-projection(projected))
          if projectedOutcome is input-representation-mismatch:
            firstProjectedIssue := projectedOutcome
            break
        else if exactOutcome is issue:
          selectedOutcome := exactOutcome
          break

  if selectedOutcome is not-checked:
    incomplete := selectedOutcome
    break

  if selectedOutcome is issue:
    minimize when permitted, save when enabled, and return ISSUE FOUND

if incomplete exists:
  return NOT CHECKED
if firstProjectedIssue exists:
  save when enabled and return ISSUE FOUND
if firstDomainWitness exists:
  minimize when permitted, save when enabled, and return ISSUE FOUND
if checked == 0:
  return NOT CHECKED(no generated input satisfied the precondition)
return NO ISSUE FOUND
```

`--cases` therefore limits completed, representable main comparisons, not raw
candidates, precondition attempts, unrepresentable values, optional variants,
or numeric projection probes. A runtime call followed by an incomplete model
comparison is not counted. The executable issue's own main candidate is
counted. Calls made by auxiliary probes, shrinking, and the final
minimized-witness evaluation do not change the counter.

Numeric precision keys contain the numeric path or path pair, so a particular
site pattern is tried only once across the concrete base candidates. The first
shape that exposes it supplies the untouched surrounding values. This bounds
the auxiliary search and also makes it sampled rather than exhaustive.

Because baseline, one-parameter, and pairwise candidates precede every random
candidate, those deterministic families can consume the entire `N` budget;
the algorithm does not reserve an executed random case.

There are two precedence levels:

1. Within one execution: timeout, throw, result mismatch, optional-result
   presence, mutation, output, then clean agreement. A comparison-blocking
   failure produces `NOT CHECKED` at its point in that sequence.
2. Across candidates: the first faithfully represented executable issue
   returns immediately. The first `NOT CHECKED` stops the target and outranks
   remembered projection and domain findings. If the main loop completes, the
   first observed input-representation mismatch outranks the first
   input-domain witness.

If no issue is found, evidence is labeled `exhaustive` exactly when the
function has zero parameters; every parameterized result is `sampled`.

## 11. Minimization

`shrinkArgs` in [`src/shrink.ts`](src/shrink.ts) is a deterministic
first-improvement loop:

```text
current := initial
repeat:
  for argument index from left to right:
    for candidateValue in SHRINK_VALUE(current[index]), in order:
      candidate := current with that one argument replaced
      skip candidate when stableKey(candidate) == stableKey(current)
      if stillFails(candidate):
        current := candidate
        restart the outer repeat from argument zero
  if no candidate was accepted: return current
```

`SHRINK_VALUE` proposes:

| Runtime shape | Candidates, in order |
| --- | --- |
| Nonzero `bigint` `v` | `0`; then its sign and truncating `v/2` unless `v` already equals its sign; then `9007199254740993` when `v > S`, or `-9007199254740993` when `v < -S`; stable duplicates removed. |
| Nonzero `Rational(n,d)` | `0`; then its sign and normalized `Rational(n/2,d)` unless already equal to its sign. |
| Nonempty string | `""`, then the prefix ending at `floor(UTF16Length/2)`. |
| `true` | `false`. |
| Nonempty array | `[]`; each one-element deletion from left to right; then every recursive element shrink from left to right. |
| Ordinary object | Every recursive field-value shrink in `Object.entries` order, one field at a time. |
| Number, `false`, empty string/array, `undefined`, `null`, `Set`, `Map`, or other value | No candidates. |

Executable findings are shrunk only when their category is none of
`optional-presence`, `input-representation-mismatch`, and `runtime-timeout`;
replay never shrinks. Optional-presence and input-representation findings must
retain a paired runtime argument tuple, while timeout probes cannot safely
reuse the worker that was killed. For other categories, a proposed candidate
is retained when a fresh canonical `EVALUATE(candidate)` returns an issue with
the same category. If minimization changes the arguments, the final candidate
is evaluated once more and that observation is used when available. These
shrink evaluations do not carry a runtime variant; in the corner case where a
presence variant produced an ordinary mutation/output category, minimization
therefore tests that category against canonical runtime arguments.

An input-domain witness is currently shrunk whenever this is not a replay. Its
predicate requires only that a fresh evaluation be `unrepresentable`; it does
not require the same bridge failure, path, or formal type validity.

This is an important current limitation: the shrinker is representation-driven,
not type-directed. It can shorten a finite
string-union member, alter a discriminant, or remove tuple elements, thereby
constructing a value the typed generator would never emit. This correctness
gap and its containment plan are recorded as P0 in [TODO.md](TODO.md). This
section describes the implementation as it exists; it does not assert that
such a minimized input-domain witness is sound.

## 12. Issue identity, persistence, and replay

The identity witness is `encode(formalArgs)` unless the issue observation
actually retained alternate `runtimeArgs`, in which case it is
`encode([formalArgs, runtimeArgs])`. Internally produced `optional-presence`
result findings and `input-representation-mismatch` findings retain them; as
noted in section 8, ordinary categories found during a presence probe currently
do not. The issue ID is the first ten hexadecimal characters of:

```text
SHA-256(
  "lemmascript-crosscheck.issue/v2" + NUL +
  sourceSha256                         + NUL +
  runtimeEntrySha256                   + NUL +
  formalTarget                         + NUL +
  runtimeExport                        + NUL +
  issueCategory                        + NUL +
  JSON.stringify(identityWitness))
```

The runtime hash covers the imported entry file only, not its transitive
dependencies. `presencePath` is saved but is not an independent ID component;
the alternate runtime arguments normally distinguish the representation.

When case saving is enabled, Crosscheck writes
`lemmascript-crosscheck.case/v2` with source/runtime paths and hashes, target
mapping, category, formal arguments, and optional runtime arguments and
presence path. The cache root is chosen in this order:

1. `$LEMMASCRIPT_CROSSCHECK_CACHE`;
2. `$XDG_CACHE_HOME/lemmascript-crosscheck/cases`; or
3. `~/.cache/lemmascript-crosscheck/cases`.

Replay requires a lowercase ten-hex ID, a `case/v2` object whose `id` field
matches it, recognized category/source/runtime/target fields, and syntactically
valid SHA-256 strings. This is a shallow schema check: it does not recursively
validate the tagged arguments or recompute the ID digest from the stored
fields. Replay then selects the stored target and runtime export and uses
exactly the decoded stored formal tuple. For an input-representation case it
also recomputes the numeric projection and requires the stored runtime tuple to
match it. Replay performs no generation, no optional-variant enumeration, and
no shrinking. An explicit source/runtime path may replace a recorded path only
when its content hash is the same. If the recorded runtime was the recorded
source, a source override also becomes the runtime unless `--runtime` is
explicit.

The stored category is validated as a known category, but the current replay
path does not require the new observation to have that category. It reports
the outcome observed now: an issue may receive a newly computed category/ID, a
clean replay may report `NO ISSUE FOUND`, and a now-precondition-invalid replay
ends as `NOT CHECKED` because zero inputs satisfied the precondition.

## 13. Report and exit policy

Each target returns exactly one of:

- `ISSUE FOUND` / `counterexample` for a faithfully represented executable
  issue, an observed numeric-projection result mismatch, or the remembered
  input-domain witness;
- `NOT CHECKED` / `tool-failure` for unsupported semantics or an incomplete
  comparison; or
- `NO ISSUE FOUND` / `sampled|exhaustive` after the candidate budget ends.

The `cases` field is the `checked` counter from section 10. For an executable
issue it includes the failing main candidate. For an input-representation or
input-domain issue it is the number of completed representable main
comparisons made before the remembered witness was reported. Optional and
numeric variants are never included. Shrink and final-witness evaluations are
not included either.

Process exit status is `2` if any target is `NOT CHECKED`, otherwise `1` if any
target has an issue, otherwise `0`. Thus `NOT CHECKED` takes precedence in a
mixed file even though every target row remains in the report.

## 14. Determinism boundary

For fixed tool versions, source/runtime entry bytes, typed metadata, options,
and deterministic target behavior, the following are deterministic:

- target and candidate order;
- the seeded random stream;
- stable deduplication;
- optional-variant order;
- numeric-site and projection-variant order;
- issue classification precedence;
- shrink proposal and acceptance order;
- tagged encodings; and
- issue IDs.

The algorithm does not repeat clean executions to detect nondeterminism.
Runtime code, model helpers, ambient state, external tools, scheduling, and the
contents of unhashed transitive runtime dependencies can therefore make two
runs differ.

## Implementation index

| Procedure | Implementation |
| --- | --- |
| Whole-file and per-target loops, classification | [`src/audit.ts`](src/audit.ts) |
| Candidate sequence and RNG | [`src/generate.ts`](src/generate.ts) |
| Preconditions | [`src/spec.ts`](src/spec.ts) |
| Formal/runtime bridge and presence variants | [`src/bridge.ts`](src/bridge.ts) |
| Exact rationals and tagged values | [`src/rational.ts`](src/rational.ts), [`src/codec.ts`](src/codec.ts) |
| Dafny marshalling and equality | [`src/dafny-runtime.ts`](src/dafny-runtime.ts) |
| Worker observations and recovery | [`src/runtime-worker.ts`](src/runtime-worker.ts), [`src/model-worker.ts`](src/model-worker.ts), [`src/json-line-client.ts`](src/json-line-client.ts) |
| Minimization | [`src/shrink.ts`](src/shrink.ts) |
| Issue IDs and replay files | [`src/cases.ts`](src/cases.ts) |
| Rendering and exit status | [`src/report.ts`](src/report.ts) |
