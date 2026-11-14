//@ backend dafny

// Dividing a bill evenly is exact in the model, but not in binary floating point.
export function perPerson(totalCents: number, people: number): number {
  //@ type \result real
  //@ requires totalCents >= 0
  //@ requires people >= 1 && people <= 10
  //@ ensures \result * people === totalCents
  return totalCents / people;
}
