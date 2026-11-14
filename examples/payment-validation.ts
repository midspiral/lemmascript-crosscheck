//@ backend dafny
// crosscheck: --checks contract,differential

// Reject negative or unaffordable payments. Both rejection tests miss NaN.
export function canPay(balance: number, amount: number): boolean {
  //@ requires balance >= 0
  //@ ensures \result ==> amount >= 0 && amount <= balance
  if (amount < 0 || amount > balance) return false;
  return true;
}
