// Reproductions from midspiral/LemmaScript#267. The mutable cases assert stale
// captured values instead of JavaScript's actual results (6, 2, and 1).

//@ ensures \result === 2
export function late(): number {
  let n = 1;
  const f = (x: number): number => x + n;
  n = 5;
  return f(1);
}

//@ ensures \result === 1
export function stale(): number {
  const a: number[] = [1];
  const len = (k: number): number => a.length + k;
  a.push(2);
  return len(0);
}

//@ ensures \result === 0
export function viaAlias(): number {
  const arr: number[] = [];
  const f = (k: number): number => arr.length + k;
  const b = arr;
  b.push(1);
  return f(0);
}

//@ ensures \result === 4
export function constantCapture(): number {
  const n = 3;
  const f = (x: number): number => x + n;
  return f(1);
}
