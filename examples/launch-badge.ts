//@ backend dafny

// The default model counts Unicode scalars; JS length counts UTF-16 code units.
export function launchBadgeLength(): number {
  //@ ensures \result === 7
  const label = "🚀 Ready";
  return label.length;
}
