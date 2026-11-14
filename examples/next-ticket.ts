//@ backend dafny

// Issue a ticket after the last one. At 2^53, adding one reissues the same ID.
export function nextTicket(last: number): number {
  //@ requires last >= 0
  //@ ensures \result > last
  return last + 1;
}
