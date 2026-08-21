import { Rational } from "./rational.js";

export type Encoded =
  | null
  | boolean
  | number
  | string
  | Encoded[]
  | { $: "undefined" }
  | { $: "bigint"; value: string }
  | { $: "rational"; numerator: string; denominator: string }
  | { $: "float"; value: "NaN" | "+Infinity" | "-Infinity" | "-0" }
  | { $: "sparse-array"; length: number; entries: [number, Encoded][] }
  | { $: "set"; values: Encoded[] }
  | { $: "map"; entries: [Encoded, Encoded][] }
  | { $: "object"; entries: [string, Encoded][] };

export function encode(value: unknown): Encoded {
  if (value === undefined) return { $: "undefined" };
  if (value === null) return null;
  if (value instanceof Rational) {
    return {
      $: "rational",
      numerator: value.numerator.toString(),
      denominator: value.denominator.toString(),
    };
  }
  if (typeof value === "bigint") return { $: "bigint", value: value.toString() };
  if (typeof value === "number") {
    if (Number.isNaN(value)) return { $: "float", value: "NaN" };
    if (value === Infinity) return { $: "float", value: "+Infinity" };
    if (value === -Infinity) return { $: "float", value: "-Infinity" };
    if (Object.is(value, -0)) return { $: "float", value: "-0" };
    return value;
  }
  if (typeof value === "boolean" || typeof value === "string") return value;
  if (Array.isArray(value)) {
    let sparse = false;
    for (let index = 0; index < value.length; index++) {
      if (!(index in value)) { sparse = true; break; }
    }
    if (!sparse) return value.map(encode);
    const entries: [number, Encoded][] = [];
    value.forEach((entry, index) => entries.push([index, encode(entry)]));
    return { $: "sparse-array", length: value.length, entries };
  }
  if (value instanceof Set) return { $: "set", values: [...value].map(encode) };
  if (value instanceof Map) {
    return { $: "map", entries: [...value].map(([key, entry]) => [encode(key), encode(entry)]) };
  }
  if (typeof value === "object") {
    return {
      $: "object",
      entries: Object.entries(value).sort(([a], [b]) => compareCodePoints(a, b))
        .map(([key, entry]) => [key, encode(entry)]),
    };
  }
  throw new Error(`cannot encode ${typeof value}`);
}

export function decode(value: Encoded): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(decode);
  switch (value.$) {
    case "undefined": return undefined;
    case "bigint": return BigInt(value.value);
    case "rational": return new Rational(BigInt(value.numerator), BigInt(value.denominator));
    case "float":
      return value.value === "NaN" ? NaN
        : value.value === "+Infinity" ? Infinity
          : value.value === "-Infinity" ? -Infinity
            : -0;
    case "sparse-array": {
      const array = new Array<unknown>(value.length);
      for (const [index, entry] of value.entries) array[index] = decode(entry);
      return array;
    }
    case "set": return new Set(value.values.map(decode));
    case "map": return new Map(value.entries.map(([key, entry]) => [decode(key), decode(entry)]));
    case "object": return Object.fromEntries(value.entries.map(([key, entry]) => [key, decode(entry)]));
  }
}

export function stableKey(value: unknown): string {
  return JSON.stringify(encode(value));
}

export function encodedEqual(left: Encoded, right: Encoded): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function compareCodePoints(left: string, right: string): number {
  const leftPoints = left[Symbol.iterator]();
  const rightPoints = right[Symbol.iterator]();
  while (true) {
    const leftPoint = leftPoints.next();
    const rightPoint = rightPoints.next();
    if (leftPoint.done || rightPoint.done) {
      return leftPoint.done === rightPoint.done ? 0 : leftPoint.done ? -1 : 1;
    }
    const leftValue = leftPoint.value.codePointAt(0)!;
    const rightValue = rightPoint.value.codePointAt(0)!;
    if (leftValue !== rightValue) return leftValue < rightValue ? -1 : 1;
  }
}

export function formatValue(value: unknown): string {
  if (value instanceof Rational) return value.toString();
  if (typeof value === "bigint") return `${value}n`;
  if (typeof value === "number") {
    if (Number.isNaN(value)) return "NaN";
    if (value === Infinity) return "+Infinity";
    if (value === -Infinity) return "-Infinity";
    if (Object.is(value, -0)) return "-0";
    return String(value);
  }
  if (value === undefined) return "<omitted>";
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(formatValue).join(", ")}]`;
  if (value instanceof Set) return `Set(${formatValue([...value])})`;
  if (value instanceof Map) {
    return `Map(${formatValue([...value].map(([key, entry]) => [key, entry]))})`;
  }
  if (value && typeof value === "object") {
    return `{ ${Object.entries(value).map(([key, entry]) => `${key}: ${entry === undefined ? "<present undefined>" : formatValue(entry)}`).join(", ")} }`;
  }
  return String(value);
}
