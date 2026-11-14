//@ backend dafny

// Exact integer IDs keep increasing beyond the number precision limit.
export function nextBigTicket(last: bigint): bigint {
  //@ requires last >= 0n
  //@ ensures \result > last
  return last + 1n;
}

// An array spread copies these primitive elements before editing.
export function copiedCartTotal(): number {
  //@ ensures \result === 65
  const cart: number[] = [25, 40];
  const preview = [...cart];
  preview[0] = 0;
  return cart[0] + cart[1];
}

// Capture an immutable value when a snapshot is intended.
export function fixedDiscountQuote(): number {
  //@ ensures \result === 9500
  const discountCents = 500;
  const quote = (price: number): number => price - discountCents;
  return quote(10000);
}

// Primitive Map keys compare by value in both languages.
export function primitiveKeyPrice(sku: string): number {
  //@ ensures \result === 100
  const prices = new Map<string, number>();
  prices.set(sku, 100);
  return prices.get(sku) ?? 0;
}

export interface Workspace {
  members: string[];
}

// Copy the nested member list before changing the preview.
export function copiedSeatPreview(workspace: Workspace): number {
  //@ ensures \result === workspace.members.length + 1
  const preview: Workspace = { ...workspace, members: [...workspace.members] };
  preview.members.push("guest");
  return preview.members.length;
}
