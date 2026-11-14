//@ backend dafny

// Saving an undo snapshot by assignment shares the live array.
export function previousRevisionCount(): number {
  //@ ensures \result === 1
  const revisions: string[] = ["draft"];
  const previous = revisions;
  revisions.push("published");
  return previous.length;
}
