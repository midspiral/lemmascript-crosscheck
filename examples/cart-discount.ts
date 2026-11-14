//@ backend dafny

// A discount preview edits the original cart through its alias.
export function originalCartTotal(): number {
  //@ ensures \result === 65
  const cart: number[] = [25, 40];
  const preview = cart;
  preview[0] = 0;
  return cart[0] + cart[1];
}
