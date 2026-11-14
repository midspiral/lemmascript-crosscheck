//@ backend dafny

// A compact two-slot offset calculation wraps as a signed 32-bit number in JS.
export function queueOffset(ticket: number): number {
  //@ requires ticket >= 0
  //@ ensures \result === ticket * 2
  return ticket << 1;
}
