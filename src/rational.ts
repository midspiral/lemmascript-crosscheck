/** A normalized exact rational used for model-space real values. */
export class Rational {
  readonly numerator: bigint;
  readonly denominator: bigint;

  constructor(numerator: bigint, denominator: bigint = 1n) {
    if (denominator === 0n) throw new Error("rational denominator is zero");
    if (denominator < 0n) {
      numerator = -numerator;
      denominator = -denominator;
    }
    const divisor = gcd(abs(numerator), denominator);
    this.numerator = numerator / divisor;
    this.denominator = denominator / divisor;
  }

  static integer(value: bigint): Rational {
    return new Rational(value);
  }

  static parseDecimal(text: string): Rational {
    const match = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(text.trim());
    if (!match || (!match[2] && !match[3])) throw new Error(`invalid decimal rational: ${text}`);
    const sign = match[1] === "-" ? -1n : 1n;
    const whole = match[2] || "0";
    const fraction = match[3] || "";
    const exponent = Number(match[4] || "0") - fraction.length;
    let numerator = sign * BigInt(whole + fraction);
    if (exponent >= 0) numerator *= 10n ** BigInt(exponent);
    else return new Rational(numerator, 10n ** BigInt(-exponent));
    return new Rational(numerator);
  }

  /** Exact value represented by an IEEE-754 binary64 number. */
  static fromDouble(value: number): Rational {
    if (!Number.isFinite(value)) throw new Error(`non-finite number has no rational image: ${value}`);
    const view = new DataView(new ArrayBuffer(8));
    view.setFloat64(0, value);
    const bits = view.getBigUint64(0);
    const sign = bits >> 63n === 0n ? 1n : -1n;
    const exponentBits = Number((bits >> 52n) & 0x7ffn);
    const fraction = bits & 0xfffffffffffffn;
    if (exponentBits === 0 && fraction === 0n) return new Rational(0n);
    const significand = exponentBits === 0 ? fraction : fraction | (1n << 52n);
    const exponent = exponentBits === 0 ? -1074 : exponentBits - 1075;
    return exponent >= 0
      ? new Rational(sign * (significand << BigInt(exponent)))
      : new Rational(sign * significand, 1n << BigInt(-exponent));
  }

  add(other: Rational): Rational {
    return new Rational(
      this.numerator * other.denominator + other.numerator * this.denominator,
      this.denominator * other.denominator,
    );
  }

  subtract(other: Rational): Rational {
    return new Rational(
      this.numerator * other.denominator - other.numerator * this.denominator,
      this.denominator * other.denominator,
    );
  }

  multiply(other: Rational): Rational {
    return new Rational(this.numerator * other.numerator, this.denominator * other.denominator);
  }

  divide(other: Rational): Rational {
    if (other.numerator === 0n) throw new Error("division by zero");
    return new Rational(this.numerator * other.denominator, this.denominator * other.numerator);
  }

  negate(): Rational {
    return new Rational(-this.numerator, this.denominator);
  }

  compare(other: Rational): number {
    const delta = this.numerator * other.denominator - other.numerator * this.denominator;
    return delta < 0n ? -1 : delta > 0n ? 1 : 0;
  }

  equals(other: Rational): boolean {
    return this.numerator === other.numerator && this.denominator === other.denominator;
  }

  isInteger(): boolean {
    return this.denominator === 1n;
  }

  toString(): string {
    return this.denominator === 1n
      ? this.numerator.toString()
      : `${this.numerator}/${this.denominator}`;
  }
}

function abs(value: bigint): bigint {
  return value < 0n ? -value : value;
}

function gcd(a: bigint, b: bigint): bigint {
  while (b !== 0n) [a, b] = [b, a % b];
  return a === 0n ? 1n : a;
}

export function asRational(value: unknown): Rational {
  if (value instanceof Rational) return value;
  if (typeof value === "bigint") return Rational.integer(value);
  if (typeof value === "number" && Number.isFinite(value)) return Rational.fromDouble(value);
  throw new Error(`expected numeric model value, got ${typeof value}`);
}
