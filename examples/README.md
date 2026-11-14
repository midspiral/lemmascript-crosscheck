# Soundness examples

A successful LemmaScript verification proves the annotations for a **generated
Dafny model** of the program. JavaScript executes the TypeScript program using
JavaScript's numbers, objects, and references. For the proof to describe that
execution, the model must preserve the relevant runtime behavior.

These examples show where that correspondence fails. Every source file verifies
as written. Crosscheck then executes the program and records the disagreement in
a companion `.out`. The [controls](#controls) show versions that agree in the
checked cases.

## What the two semantics mean

Consider [cart-discount.ts](cart-discount.ts):

```ts
export function originalCartTotal(): number {
  //@ ensures \result === 65
  const cart: number[] = [25, 40];
  const preview = cart;
  preview[0] = 0;
  return cart[0] + cart[1];
}
```

| Step | Generated Dafny model | JavaScript runtime |
| --- | --- | --- |
| `const preview = cart` | Both variables hold the sequence value `[25, 40]`. | Both variables refer to the same mutable array. |
| `preview[0] = 0` | Replace `preview` with the sequence `[0, 40]`; `cart` still holds `[25, 40]`. | Change the shared array to `[0, 40]`; reads through `cart` see that change too. |
| Return the original total | `65`: the postcondition is proven. | `40`: the postcondition is false. |

Dafny has proved a true statement about the generated program. That program
lost a relationship that matters in JavaScript: `preview` and `cart` share one
array. A successful proof therefore coexists with a failing TypeScript promise.
Other examples lose different facts, such as floating-point rounding, live
closure bindings, or object identity.

Crosscheck has two ways to expose these differences:

- **Differential checking** executes the verified model and JavaScript, then
  compares results and observed effects. It can find a mismatch even without
  an `ensures` clause. This is the default check.
- **Runtime contract checking** executes JavaScript inputs satisfying the
  JavaScript interpretation of `requires`, then checks `ensures` using
  JavaScript operations. Its inputs include `NaN` and fractions, which may be
  absent from the model's parameter domain. Use `--checks contract` or
  `--checks contract,differential`.

With both selected, a contract finding takes precedence; differential checking
runs only if the contract check reports no issue. Run the modes separately to
see both accounts of a failing program. The [issue catalog](../SOUNDNESS_ISSUES.md)
explains every report category and the current detection limits.

## Numbers and validation

### Next ticket

[Source](next-ticket.ts) · [Output](next-ticket.out)

For `last = 9007199254740992`, the model returns `9007199254740993` and proves
that the next ticket is larger. JavaScript returns `9007199254740992` again.
The input is exactly representable, but adding one produces an integer between
representable JavaScript numbers, so the result rounds back. Differential
checking catches the unequal results (`result-mismatch`).

### Split bill

[Source](split-bill.ts) · [Output](split-bill.out)

Splitting one cent among three people returns the exact rational `1/3` in the
model. JavaScript returns `0.3333333333333333`, whose exact binary64 value is
slightly smaller. Crosscheck converts that runtime number to its exact rational
value and detects a `result-mismatch`. The runtime check `result * 3 === 1` can
still pass because that multiplication also rounds; this illustrates why
comparing executions can find a difference that a runtime postcondition misses.

### Request identity

[Source](request-identity.ts) · [Output](request-identity.out)

The model compares IDs `9007199254740992` and `9007199254740993` and returns
`false`. JavaScript receives `9007199254740992` for both and returns `true`.
The second ID was rounded **before the function started**. Crosscheck's numeric
projection probe retains the exact formal inputs, records the rounded runtime
inputs, and executes both versions. The changed result is an
`input-representation-mismatch`, rather than a rounding error in the comparison.

### Queue offset

[Source](queue-offset.ts) · [Output](queue-offset.out)

For ticket `2147483647`, the generated model treats `ticket << 1` as mathematical
multiplication by two and returns `4294967294`. JavaScript's number shift uses
signed 32-bit arithmetic and returns `-2`. The input is exact in both executions;
the operator semantics differ. Differential checking reports `result-mismatch`.

### Payment validation

[Source](payment-validation.ts) · [Output](payment-validation.out)

With balance `0` and amount `NaN`, both rejection tests—`amount < 0` and
`amount > balance`—are false, so JavaScript approves the payment. Its promised
condition, `amount >= 0 && amount <= balance`, is false. The integer model has
no `NaN`, so its proof does not cover this call. Runtime contract checking
executes the admitted TypeScript input and reports a
`runtime-postcondition-violation`.

### NaN and mutation: two minimal examples

[Source](nan-and-mutation.ts) · [Output](nan-and-mutation.out)

`clampNonNegative(NaN)` returns `NaN`: the test `x < 0` is false, so the function
returns `x`. The model proves a nonnegative result over integers; the runtime
comparison `NaN >= 0` is false. Contract checking catches the false guarantee.

`readAfterMutation()` captures `current = 1`, changes it to `5`, and calls the
closure with `1`. The generated model retained the earlier value and returns
`2`; JavaScript reads the current binding and returns `6`. Differential checking
catches this second issue. The combined `.out` demonstrates both checks.

## Captures and shared mutable values

### Discount preview

[Source](discount-preview.ts) · [Output](discount-preview.out)

The quote callback is created when the discount is zero. After the discount
changes to 500 cents, the model still quotes 10,000 cents, satisfying the
original-price postcondition. JavaScript reads the updated discount and quotes
9,500 cents. Creating a closure did not freeze the variable it references;
differential checking exposes the stale capture as `result-mismatch`.

### Approval count

[Source](approval-count.ts) · [Output](approval-count.out)

A callback is created with one approval in the array, then another approval is
pushed before the callback runs. The model's captured sequence still has length
`1`; JavaScript's captured array now has length `2`. Differential checking
finds `result-mismatch`. Here the array contents changed even though its
`const` binding was never reassigned.

### Undo history

[Source](undo-history.ts) · [Output](undo-history.out)

Saving `previous = revisions` is intended to preserve the one-entry history.
The model updates only the `revisions` sequence when a revision is pushed, so
reading `previous.length` returns `1`. JavaScript keeps both names attached to
one array, and the supposed snapshot has length `2`. Differential checking
finds `result-mismatch`; no closure is involved.

### Cart discount

[Source](cart-discount.ts) · [Output](cart-discount.out)

The opening walkthrough shows this case: the model returns the original total
`65`, while JavaScript returns `40`. The preview aliases the original array,
so changing its first element changes both views. Differential checking catches
the unequal totals. [The copied-cart control](controls.ts) uses `[...cart]` to
create an independent array and returns `65` in both executions.

### Seat upgrade

[Source](seat-upgrade.ts) · [Output](seat-upgrade.out)

For an empty workspace, inviting `"a"` at one cent per seat produces a model
quote of **0 current seats, 1 projected seat**, with bills of 0 and 1 cent.
JavaScript reports **1 current seat, 1 projected seat**, with both bills already
at 1 cent. `{ ...workspace }` copies the outer object but shares `members`;
pushing into the preview also changes the original workspace before its current
bill is read. The model's value update changes only the preview. Differential
checking catches the quote mismatch; the claim that projected seats equal
current seats plus one is also false in JavaScript.

### Calendar preview

[Source](calendar-preview.ts) · [Output](calendar-preview.out)

Monday starts with appointments at 9 and 14. JavaScript's `[...calendar]` copies
the outer array but shares Monday's inner array, so adding 16 through the
preview makes the original Monday count `3`. The current generated model
returns `2`; it discards the push through the indexed receiver `preview[0]`.
This case combines a shallow-copy alias with a lost nested mutation.
Differential checking observes `result-mismatch` without diagnosing either
cause automatically.

### Feature rollout

[Source](feature-rollout.ts) · [Output](feature-rollout.out)

The live `"beta"` flag starts as `false`. Assigning the Map to `preview` and
setting that flag to `true` changes only the preview's value in the model, so
reading the live flag still returns `false`. JavaScript shares one Map and
returns `true`. Differential checking catches the aliasing error as
`result-mismatch`.

## Identity and property presence

### Deduplicate notifications

[Source](deduplicate-notifications.ts) · [Output](deduplicate-notifications.out)

For recipient `"a"`, two separately allocated notification records have the
same fields. The model uses structural record equality, so its Set says the
second record was already sent (`true`). JavaScript's Set compares these
objects by identity and says `false`. Differential checking catches
`result-mismatch`: the intended deduplication fails even without mutation.

### Object-key cache

[Source](object-key-cache.ts) · [Output](object-key-cache.out)

A price of `100` is stored under `{ sku: "a" }`, then looked up using a newly
allocated `{ sku: "a" }`. The model regards the keys as equal and returns
`100`. JavaScript regards them as different objects, misses the entry, and
returns the fallback `0`. Differential checking finds `result-mismatch`.
Using the SKU string itself as the key makes the control agree.

### Configuration defaults

[Source](config-defaults.ts) · [Output](config-defaults.out)

With a default retry count of `0`, an omitted override should retain `0`.
Crosscheck also tries the runtime representation `{ retries: undefined }`.
The model represents both omission and explicit `undefined` as `None` and keeps
the default. JavaScript object spread copies the present property, so the
result's retry count becomes `undefined`. The optional-property probe records
these two representations and reports `optional-presence`.

## Strings and observable effects

### Launch badge

[Source](launch-badge.ts) · [Output](launch-badge.out)

The label `"🚀 Ready"` has seven Unicode scalar values. The default Dafny string
model therefore returns `7`, satisfying the annotation. JavaScript `.length`
counts UTF-16 code units: the rocket takes two, so it returns `8`. Differential
checking catches `result-mismatch`. This finding depends on the selected string
semantics; a scalar count and a UTF-16 length measure different things.

### Audit log

[Source](audit-log.ts) · [Output](audit-log.out)

Appending `"login"` to an empty log returns `1` in both executions. JavaScript
also changes the caller's array from `[]` to `["login"]`; the formal argument
is a sequence value with no corresponding caller-visible mutation.
Crosscheck compares argument snapshots before and after execution and reports
`input-mutation`. The append may be intended, and the positive-length
postcondition still holds. The finding is an effect missing from the model.

## Controls

[Source](controls.ts) · [Output](controls.out)

Each control makes the relevant runtime behavior agree with the value model:

- `nextBigTicket` uses JavaScript `bigint`, so incrementing an ID remains exact
  beyond the `number` precision boundary. Both executions return the same ID.
- `copiedCartTotal` copies the primitive array elements with `[...cart]` before
  editing the preview. Both executions leave the original total at `65`.
- `fixedDiscountQuote` captures a discount that never changes. Both executions
  quote `9500` for a price of `10000`.
- `primitiveKeyPrice` stores and looks up the SKU string directly. Strings use
  value equality in both Maps, so both return `100`.
- `copiedSeatPreview` copies the nested `members` array as well as the outer
  workspace. Both return one more projected seat while the original member list
  stays unchanged; the mutation observation also agrees.

`NO ISSUE FOUND` describes the displayed executions. Parameterized controls are
sampled; a parameterless control has one input tuple. This does not establish
correctness for other programs using the same technique.

## Run and reproduce

After the [normal setup](../README.md#installation), build Crosscheck and select
your LemmaScript checkout (or leave `LEMMASCRIPT` unset to use an installed `lsc`):

```sh
npm run build
export LEMMASCRIPT=/path/to/LemmaScript
node dist/src/cli.js examples/seat-upgrade.ts --cases 40 --seed 17 --details
node dist/src/cli.js examples/payment-validation.ts --checks contract --cases 40 --seed 17 --details
```

An issue exits with status **1**. `NOT CHECKED` exits with **2** and means no
comparison was established for that target. Direct audits generate ignored
Dafny sidecars beside the source. None of these examples needs proof additions,
`assume`, or `extern` declarations.

```sh
npm run examples:check                    # every example, including controls
npm run examples:check -- seat-upgrade    # one example
npm run examples:update -- seat-upgrade   # record a reviewed new outcome
```

The runner discovers `.ts` files, checks temporary copies with 40 cases and seed
17, and replays every finding. A `// crosscheck:` comment selects extra CLI
options for that runner; a direct CLI invocation needs those flags explicitly.
The `.out` records the full report, with temporary paths replaced by relative
paths, plus the command and verification versions. Tool failures never replace
an existing output.

Temporary proofs and case caches are removed afterward. To use a replay command
from an `.out`, first run its audit command in your checkout to create the saved
case. In a source checkout, replace `lemmascript-crosscheck` with
`node dist/src/cli.js`.

The snapshot check is opt-in; CI runs the focused soundness integration tests.
A LemmaScript fix can change a result or make a deliberately false contract fail
verification. Inspect such changes before refreshing the outputs.
