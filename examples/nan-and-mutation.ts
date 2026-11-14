//@ backend dafny
// crosscheck: --checks contract,differential

// NaN passes through this clamp and violates the nonnegative postcondition.
export function clampNonNegative(x: number): number {
  //@ ensures \result >= 0
  return x < 0 ? 0 : x;
}

// A JavaScript closure reads the current binding, so this returns 6.
export function readAfterMutation(): number {
  let current = 1;
  const read = (extra: number): number => current + extra;
  current = 5;
  return read(1);
}
