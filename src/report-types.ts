import type { Encoded } from "./codec.js";

export type Conclusion = "issue" | "no-issue" | "not-checked";
export type EvidenceKind = "counterexample" | "sampled" | "exhaustive" | "tool-failure";
export type CheckKind = "contract" | "differential";

export type IssueCategory =
  | "result-mismatch"
  | "input-domain"
  | "input-representation-mismatch"
  | "proof-domain-gap"
  | "runtime-postcondition-violation"
  | "input-mutation"
  | "optional-presence"
  | "console-output"
  | "runtime-threw"
  | "runtime-timeout";

export interface Issue {
  id: string;
  category: IssueCategory;
  summary: string;
  diagnosis: string;
  resolution: string;
  args: Encoded;
  paramNames: string[];
  argDisplays: string[];
  runtimeArgDisplays?: string[];
  representationLosses?: {
    path: string;
    formalValue: Encoded;
    runtimeValue: Encoded;
  }[];
  modelResult?: string;
  runtimeResult?: Encoded;
  runtimeExact?: string;
  mutationBefore?: Encoded;
  mutationAfter?: Encoded;
  formalPath?: string;
  formalValue?: Encoded;
  formalDisplay?: string;
  runtimePath?: string;
  runtimeValue?: Encoded;
  runtimeDisplay?: string;
  postconditionClause?: number;
  postconditionsSatisfied?: boolean;
  console?: string[];
  runtimeError?: string;
}

export interface TargetReport {
  target: string;
  runtimeTarget: string;
  conclusion: Conclusion;
  evidence: EvidenceKind;
  cases: number;
  seed: number;
  checks?: CheckKind[];
  contractCases?: number;
  issue?: Issue;
  reason?: string;
  nextStep?: string;
}

export interface Provenance {
  source: string;
  sourceSha256: string;
  artifact: string;
  artifactSha256: string;
  lemmascript: string;
  dafny: string;
  runtime: string;
  runtimeSha256: string;
}

export interface AuditReport {
  schema: "lemmascript-crosscheck.report/v1";
  provenance?: Provenance;
  targets: TargetReport[];
}
