//@ backend dafny

// The returned count agrees; the caller's log changes only in JavaScript.
export function appendLogin(events: string[]): number {
  //@ ensures \result > 0
  events.push("login");
  return events.length;
}
