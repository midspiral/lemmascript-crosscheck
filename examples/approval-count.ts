//@ backend dafny

// The callback sees approvals added after it was created.
export function originalApprovalCount(): number {
  //@ ensures \result === 1
  const approvals: string[] = ["reviewer"];
  const count = (extra: number): number => approvals.length + extra;
  approvals.push("owner");
  return count(0);
}
