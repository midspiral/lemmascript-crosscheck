//@ backend dafny

// A quote callback closes over a live discount, not its value at creation time.
export function previewBeforeSale(): number {
  //@ ensures \result === 10000
  let discountCents = 0;
  const quote = (price: number): number => price - discountCents;
  discountCents = 500;
  return quote(10000);
}
