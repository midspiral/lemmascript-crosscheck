//@ backend dafny

export interface ProductKey {
  sku: string;
}

// Reconstructing an equal-looking key misses a JavaScript Map entry.
export function cachedPrice(sku: string): number {
  //@ requires sku.length > 0
  //@ ensures \result === 100
  const prices = new Map<ProductKey, number>();
  const stored: ProductKey = { sku };
  prices.set(stored, 100);
  const lookup: ProductKey = { sku };
  return prices.get(lookup) ?? 0;
}
