//@ backend dafny

export interface Workspace {
  members: string[];
}

export interface SeatQuote {
  currentSeats: number;
  projectedSeats: number;
  currentMonthlyCents: number;
  projectedMonthlyCents: number;
}

// Preview the monthly bill after inviting another member.
export function quoteExtraSeat(
  workspace: Workspace,
  newMember: string,
  seatPriceCents: number,
): SeatQuote {
  //@ requires newMember.length > 0
  //@ requires seatPriceCents >= 1 && seatPriceCents <= 10000
  //@ ensures \result.currentSeats === workspace.members.length
  //@ ensures \result.projectedSeats === \result.currentSeats + 1
  //@ ensures \result.currentMonthlyCents === \result.currentSeats * seatPriceCents
  //@ ensures \result.projectedMonthlyCents === \result.currentMonthlyCents + seatPriceCents

  const preview: Workspace = { ...workspace };
  preview.members.push(newMember);

  return {
    currentSeats: workspace.members.length,
    projectedSeats: preview.members.length,
    currentMonthlyCents: workspace.members.length * seatPriceCents,
    projectedMonthlyCents: preview.members.length * seatPriceCents,
  };
}
