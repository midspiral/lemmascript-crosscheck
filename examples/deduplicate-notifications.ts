//@ backend dafny

export interface Notification {
  recipientId: string;
}

// A Set of records compares their contents in Dafny and their identity in JS.
export function alreadyNotified(recipientId: string): boolean {
  //@ requires recipientId.length > 0
  //@ ensures \result === true
  const sent = new Set<Notification>();
  const first: Notification = { recipientId };
  sent.add(first);
  const retry: Notification = { recipientId };
  return sent.has(retry);
}
