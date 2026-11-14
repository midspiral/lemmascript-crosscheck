//@ backend dafny

// Trying a feature flag through an alias also changes the live configuration.
export function betaBeforeRollout(): boolean {
  //@ ensures \result === false
  const flags = new Map<string, boolean>();
  flags.set("beta", false);
  const preview = flags;
  preview.set("beta", true);
  return flags.get("beta") ?? false;
}
