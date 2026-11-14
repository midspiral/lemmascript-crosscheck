function push1(a: number[]): void { a.push(1); }

//@ ensures \result === 0
export function viaCall(): number {
  const arr: number[] = [];
  const f = (k: number): number => arr.length + k;
  push1(arr);
  return f(0);
}
