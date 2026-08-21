import { decode, formatValue } from "./codec.js";
import type { AuditReport, Issue, TargetReport } from "./report-types.js";

export interface RenderOptions {
  details: boolean;
}

export function renderReport(report: AuditReport, options: RenderOptions): string {
  if (report.targets.length === 1 || options.details) {
    return report.targets.map(target => renderTarget(target, report)).join("\n\n");
  }
  return renderSuite(report);
}

export function exitCode(report: AuditReport): number {
  if (report.targets.some(target => target.conclusion === "not-checked")) return 2;
  if (report.targets.some(target => target.conclusion === "issue")) return 1;
  return 0;
}

function renderTarget(target: TargetReport, report: AuditReport): string {
  if (target.conclusion === "issue") return renderIssue(target, target.issue!, report);
  if (target.conclusion === "no-issue") {
    const evidence = target.evidence === "exhaustive"
      ? "exhaustive input domain (the function has no parameters)"
      : `${target.cases} sampled proof-valid inputs · seed ${target.seed} · not a proof`;
    return `${target.target} — NO ISSUE FOUND\nEvidence: ${evidence}`;
  }
  return [
    `${target.target} — NOT CHECKED`,
    target.reason ?? "Crosscheck could not complete this target.",
    "",
    "Next step",
    `  ${target.nextStep ?? "Resolve the reported failure and rerun the audit."}`,
  ].join("\n");
}

function renderIssue(target: TargetReport, issue: Issue, report: AuditReport): string {
  const lines = [`${target.target} — ISSUE FOUND`, capitalize(issue.summary) + ".", ""];
  if (issue.category === "input-domain") {
    lines.push("Formal witness");
    appendArgs(lines, issue);
    if (issue.formalPath && issue.formalDisplay) lines.push(`  ${issue.formalPath.padEnd(12)}${issue.formalDisplay}`);
    lines.push("", issue.diagnosis + ".", "This is a model/runtime domain mismatch, not an executed JavaScript call.");
  } else {
    lines.push("Input");
    appendArgs(lines, issue);
    if (issue.runtimeArgDisplays) {
      lines.push("", "JavaScript representation");
      for (let index = 0; index < issue.paramNames.length; index++) {
        lines.push(`  ${issue.paramNames[index]!.padEnd(12)}${issue.runtimeArgDisplays[index] ?? "<unknown>"}`);
      }
    }
    if (issue.category === "input-mutation") {
      lines.push("", "Observed arguments", `  before      ${formatValue(decode(issue.mutationBefore!))}`, `  after       ${formatValue(decode(issue.mutationAfter!))}`);
    } else if (issue.category === "runtime-threw") {
      lines.push("", "Result", `  verified    ${issue.modelResult}`, `  JavaScript  ${issue.runtimeError}`);
    } else if (issue.category === "runtime-timeout") {
      lines.push("", "Result", `  verified    ${issue.modelResult}`, "  JavaScript  <timeout>");
    } else if (issue.category === "console-output") {
      lines.push("", "Output", ...(issue.console ?? []).map(entry => `  ${entry}`));
    } else {
      const actual = formatValue(decode(issue.runtimeResult!));
      const exact = issue.runtimeExact && issue.runtimeExact !== actual ? ` (exactly ${issue.runtimeExact})` : "";
      lines.push("", "Result", `  verified    ${issue.modelResult}`, `  JavaScript  ${actual}${exact}`);
    }
    lines.push("", "Cause", `  ${issue.diagnosis}`);
  }
  lines.push("", "Resolve", `  ${issue.resolution}`, "", "Replay", `  lemmascript-crosscheck ${shellPath(report.provenance?.source ?? "source.ts")} --replay ${issue.id}`);
  const backend = report.provenance ? ` · Dafny ${report.provenance.dafny} model` : "";
  lines.push("", `Evidence: replayed counterexample${backend}`);
  return lines.join("\n");
}

function appendArgs(lines: string[], issue: Issue): void {
  if (issue.paramNames.length === 0) {
    lines.push("  (no arguments)");
    return;
  }
  for (let index = 0; index < issue.paramNames.length; index++) {
    lines.push(`  ${issue.paramNames[index]!.padEnd(12)}${issue.argDisplays[index] ?? "<unknown>"}`);
  }
}

function renderSuite(report: AuditReport): string {
  const issues = report.targets.filter(target => target.conclusion === "issue");
  const incomplete = report.targets.filter(target => target.conclusion === "not-checked");
  const clean = report.targets.filter(target => target.conclusion === "no-issue");
  const lines = [
    `${report.targets.length} targets · ${issues.length} issues · ${incomplete.length} not checked · ${clean.length} with no issue found`,
    "",
  ];
  const ordered = [...issues, ...incomplete, ...clean];
  for (const target of ordered) {
    const label = target.conclusion === "issue" ? "ISSUE" : target.conclusion === "not-checked" ? "NOT CHECKED" : "NO ISSUE";
    const detail = target.issue?.summary ?? target.reason
      ?? (target.evidence === "exhaustive" ? "exhaustive singleton domain" : `sampled ${target.cases} inputs`);
    lines.push(`${label.padEnd(13)}${target.target.padEnd(22)}${detail}`);
  }
  if (issues[0]?.issue) {
    lines.push("", `Explain an issue: lemmascript-crosscheck ${shellPath(report.provenance?.source ?? "source.ts")} --replay ${issues[0].issue.id}`);
  }
  return lines.join("\n");
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1).replace(/\.$/, "");
}

function shellPath(value: string): string {
  return /[\s'"\\]/.test(value) ? JSON.stringify(value) : value;
}

export function renderFatal(source: string, message: string): string {
  return [
    `${source} — NOT CHECKED`,
    message,
    "",
    "No compatibility claim was made.",
  ].join("\n");
}
