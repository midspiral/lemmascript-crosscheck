//@ backend dafny

// Distinct formal IDs can become the same number before JS compares them.
export function sameRequest(left: number, right: number): boolean {
  //@ requires left >= 0 && right >= 0
  //@ ensures \result === (left === right)
  return left === right;
}
