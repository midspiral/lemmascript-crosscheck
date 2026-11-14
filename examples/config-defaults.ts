//@ backend dafny

export interface RetryConfig {
  retries?: number;
}

// An absent key preserves the default; an explicit undefined overwrites it.
// The model represents both cases by the same optional value.
export function configure(base: RetryConfig, override: RetryConfig): RetryConfig {
  //@ requires base.retries !== undefined
  //@ ensures override.retries === undefined ==> \result.retries === base.retries
  //@ ensures override.retries !== undefined ==> \result.retries === override.retries
  return { ...base, ...override };
}
