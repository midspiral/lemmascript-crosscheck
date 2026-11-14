//@ backend dafny

// Copying the outer calendar still shares each day's list of appointments.
// The current lowering also discards the push through the indexed receiver.
export function originalMondayCount(): number {
  //@ ensures \result === 2
  const calendar: number[][] = [[9, 14]];
  const preview = [...calendar];
  preview[0].push(16);
  return calendar[0].length;
}
