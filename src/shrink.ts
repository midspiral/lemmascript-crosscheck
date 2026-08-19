import { stableKey } from "./codec.js";
import { Rational } from "./rational.js";

/** Deterministic, representation-agnostic candidates. The audit relation decides which remain failures. */
export async function shrinkArgs(
  initial: unknown[],
  stillFails: (args: unknown[]) => Promise<boolean>,
): Promise<unknown[]> {
  let current = initial;
  let changed = true;
  while (changed) {
    changed = false;
    for (let index = 0; index < current.length; index++) {
      for (const candidateValue of shrinkValue(current[index])) {
        const candidate = [...current];
        candidate[index] = candidateValue;
        if (stableKey(candidate) === stableKey(current)) continue;
        if (await stillFails(candidate)) {
          current = candidate;
          changed = true;
          break;
        }
      }
      if (changed) break;
    }
  }
  return current;
}

function shrinkValue(value: unknown): unknown[] {
  if (typeof value === "bigint") {
    if (value === 0n) return [];
    const sign = value < 0n ? -1n : 1n;
    const candidates = [0n];
    if (value !== sign) candidates.push(sign, value / 2n);
    if (value > 9_007_199_254_740_991n) candidates.push(9_007_199_254_740_993n);
    if (value < -9_007_199_254_740_991n) candidates.push(-9_007_199_254_740_993n);
    return unique(candidates);
  }
  if (value instanceof Rational) {
    if (value.numerator === 0n) return [];
    const sign = new Rational(value.numerator < 0n ? -1n : 1n);
    const candidates = [new Rational(0n)];
    if (!value.equals(sign)) candidates.push(sign, new Rational(value.numerator / 2n, value.denominator));
    return unique(candidates);
  }
  if (typeof value === "string") return value ? ["", value.slice(0, Math.floor(value.length / 2))] : [];
  if (typeof value === "boolean") return value ? [false] : [];
  if (Array.isArray(value)) {
    const output: unknown[] = [];
    if (value.length) output.push([]);
    for (let index = 0; index < value.length; index++) output.push(value.filter((_, candidate) => candidate !== index));
    for (let index = 0; index < value.length; index++) {
      for (const entry of shrinkValue(value[index])) {
        const candidate = [...value];
        candidate[index] = entry;
        output.push(candidate);
      }
    }
    return unique(output);
  }
  if (value && typeof value === "object" && !(value instanceof Set) && !(value instanceof Map)) {
    const output: unknown[] = [];
    for (const [key, entry] of Object.entries(value)) {
      for (const shrunk of shrinkValue(entry)) output.push({ ...value, [key]: shrunk });
    }
    return unique(output);
  }
  return [];
}

function unique<T>(values: T[]): T[] {
  const seen = new Set<string>();
  return values.filter(value => {
    const key = stableKey(value);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
