import path from "node:path";
import { decode, encode, encodedEqual, type Encoded } from "./codec.js";
import {
  encodeRuntime,
  numericPrecisionVariants,
  optionalPresenceVariants,
  presentUndefinedPath,
  projectRuntime,
  runtimeDomainFailure,
  type BridgeContext,
  type RuntimeEncodingFailure,
  type RuntimeEncodingResult,
  type RuntimeDomainFailure,
  type RuntimeProjectionLoss,
  typeSupportReason,
} from "./bridge.js";
import { candidateCases, runtimeCandidateCases } from "./generate.js";
import type { Ty, TypedFunction, TypedInfo } from "./ir.js";
import { WorkerTimeoutError } from "./json-line-client.js";
import { compileVerifiedDafny } from "./dafny-build.js";
import { issueId, saveCase, type StoredCase } from "./cases.js";
import type { AuditReport, CheckKind, Issue, IssueCategory, Provenance, TargetReport } from "./report-types.js";
import { shrinkArgs } from "./shrink.js";
import {
  checkRuntimePostconditions,
  RuntimeSpecUnsupported,
  satisfiesRuntimePreconditions,
} from "./runtime-spec.js";
import { satisfiesPreconditions, SpecUnsupported } from "./spec.js";
import { hashFile, verifyAndInspect } from "./toolchain.js";
import { startWorkers, type AuditWorkers } from "./workers.js";

export interface AuditOptions {
  cases: number;
  seed: number;
  timeoutMs: number;
  verifyTimeoutMs: number;
  only?: string;
  runtime?: string;
  entries: ReadonlyMap<string, string>;
  replay?: StoredCase;
  saveCases: boolean;
  checks?: ReadonlySet<CheckKind>;
  progress?: (phase: string) => void;
}

interface DomainWitness {
  args: unknown[];
  failure: RuntimeEncodingFailure;
}

interface RuntimeDomainWitness {
  args: unknown[];
  failure: RuntimeDomainFailure;
  runtimeResult?: Encoded;
  postconditionsSatisfied?: boolean;
}

interface RuntimeContractViolation {
  args: unknown[];
  runtimeResult?: Encoded;
  runtimeError?: string;
  postconditionClause?: number;
}

type DifferentialIssueCategory = Exclude<
  IssueCategory,
  "input-domain" | "proof-domain-gap" | "runtime-postcondition-violation"
>;

interface ExecutedIssue {
  category: DifferentialIssueCategory;
  args: unknown[];
  modelResult?: string;
  runtimeResult?: Encoded;
  runtimeExact?: string;
  before?: Encoded;
  after?: Encoded;
  output?: string[];
  runtimeError?: string;
  runtimeArgs?: unknown[];
  presencePath?: string;
  representationLosses?: RuntimeProjectionLoss[];
}

type RuntimeVariant =
  | { kind: "optional-presence"; args: unknown[]; path: string }
  | { kind: "numeric-projection"; args: unknown[]; losses: RuntimeProjectionLoss[] };

interface CaseOutcome {
  kind: "clean" | "invalid" | "unrepresentable" | "issue" | "not-checked";
  failure?: RuntimeEncodingFailure;
  issue?: ExecutedIssue;
  reason?: string;
  nextStep?: string;
}

export interface AuditIdentity {
  source: string;
  sourceSha256: string;
  runtime: string;
  runtimeSha256: string;
}

export async function auditFile(source: string, options: AuditOptions): Promise<AuditReport> {
  options.progress?.("verifying with LemmaScript");
  const verified = await verifyAndInspect(source, options.verifyTimeoutMs);
  if (options.replay && verified.sourceHash !== options.replay.sourceSha256) {
    throw new Error(`source changed since replay ${options.replay.id} was recorded`);
  }
  options.progress?.("compiling the verified Dafny model");
  const compiled = await compileVerifiedDafny(
    verified.artifact,
    verified.artifactHash,
    verified.dafnyVersion,
    options.verifyTimeoutMs,
  );

  const selected = verified.info.functions.filter(fn => fn.exported && (!options.only || fn.name === options.only));
  if (options.only && selected.length === 0) throw new Error(`no exported verified target named ${options.only}`);
  if (selected.length === 0) throw new Error("typed-info contains no exported verified functions");

  const recordedRuntime = options.replay?.runtime === options.replay?.source
    ? verified.source
    : options.replay?.runtime;
  const runtime = path.resolve(options.runtime ?? recordedRuntime ?? verified.source);
  const runtimeSha256 = await hashFile(runtime);
  if (options.replay && runtimeSha256 !== options.replay.runtimeSha256) {
    throw new Error(`runtime module changed since replay ${options.replay.id} was recorded`);
  }
  const identity: AuditIdentity = {
    source: verified.source,
    sourceSha256: verified.sourceHash,
    runtime,
    runtimeSha256,
  };
  const provenance: Provenance = {
    source: verified.source,
    sourceSha256: verified.sourceHash,
    artifact: verified.artifact,
    artifactSha256: compiled.artifactHash,
    lemmascript: verified.lemmascriptVersion,
    dafny: verified.dafnyVersion,
    runtime,
    runtimeSha256,
  };

  const workers = await startWorkers(compiled.modulePath, runtime, verified.info, options.timeoutMs);
  try {
    const targets: TargetReport[] = [];
    for (const fn of selected) {
      options.progress?.(`checking ${fn.name}`);
      targets.push(await auditTarget(fn, verified.info, identity, workers, options));
    }
    return {
      schema: "lemmascript-crosscheck.report/v1",
      provenance,
      targets,
    };
  } finally {
    workers.close();
  }
}

export async function auditTarget(
  fn: TypedFunction,
  info: TypedInfo,
  identity: AuditIdentity,
  workers: AuditWorkers,
  options: AuditOptions,
): Promise<TargetReport> {
  const replayContract = options.replay?.category === "proof-domain-gap"
    || options.replay?.category === "runtime-postcondition-violation";
  const checks = options.replay
    ? new Set<CheckKind>([replayContract ? "contract" : "differential"])
    : options.checks ?? new Set<CheckKind>(["differential"]);
  if (checks.has("contract")) {
    const contract = await auditRuntimeContractTarget(fn, info, identity, workers, options);
    const taggedContract: TargetReport = { ...contract, checks: ["contract"] };
    if (contract.conclusion !== "no-issue" || !checks.has("differential")) return taggedContract;
    const differential = await auditDifferentialTarget(fn, info, identity, workers, options);
    return {
      ...differential,
      checks: ["contract", "differential"],
      contractCases: contract.cases,
    };
  }
  return { ...await auditDifferentialTarget(fn, info, identity, workers, options), checks: ["differential"] };
}

async function auditDifferentialTarget(
  fn: TypedFunction,
  info: TypedInfo,
  identity: AuditIdentity,
  workers: AuditWorkers,
  options: AuditOptions,
): Promise<TargetReport> {
  const runtimeTarget = options.entries.get(fn.name) ?? fn.name;
  const context: BridgeContext = { declarations: new Map(info.typeDecls.map(declaration => [declaration.name, declaration])) };
  const unsupported = supportReason(fn, context);
  if (unsupported) return notChecked(fn.name, runtimeTarget, options, unsupported, "Use a supported synchronous value type or extend the semantic bridge.");

  const allCases = options.replay
    ? [decode(options.replay.args) as unknown[]]
    : candidateCases(fn, info, options.cases, options.seed);
  let checked = 0;
  let domainWitness: DomainWitness | undefined;
  let projectedIssue: ExecutedIssue | undefined;
  const precisionTried = new Set<string>();
  let incomplete: { reason: string; nextStep: string } | undefined;

  const evaluate = async (args: unknown[], variant?: RuntimeVariant): Promise<CaseOutcome> => {
    // Numeric projection establishes only an unequal normal return. Other
    // projected behavior leaves the exact input as an ordinary domain witness.
    let valid: boolean;
    try {
      valid = await satisfiesPreconditions(fn, args, info.constants, async (name, callArgs) => {
        const callee = info.functions.find(candidate => candidate.name === name);
        if (!callee) throw new SpecUnsupported(`model function ${name} is not in typed-info`);
        const response = await workers.model.request({
          type: "call",
          target: info.dafny.emittedNames?.[callee.name] ?? callee.name,
          paramTys: callee.params.map(param => param.ty),
          returnTy: callee.returnTy,
          args: encode(callArgs),
        }, options.timeoutMs);
        if (response.status !== "ok") throw new Error(`verified precondition model function ${name} failed: ${String(response.error ?? response.status)}`);
        if (!("modelValue" in response)) throw new SpecUnsupported(`model function ${name} returned a value the bridge cannot decode`);
        return decode(response.modelValue as Encoded);
      }, info.typeDecls);
    } catch (error) {
      if (error instanceof SpecUnsupported) return {
        kind: "not-checked",
        reason: `precondition semantics are unsupported: ${error.reason}`,
        nextStep: "Extend the typed precondition evaluator before drawing a compatibility conclusion.",
      };
      if (error instanceof WorkerTimeoutError) return {
        kind: "not-checked",
        reason: "the verified precondition model timed out",
        nextStep: "Increase --timeout or simplify the verified predicate used by the precondition.",
      };
      return {
        kind: "not-checked",
        reason: `could not evaluate the verified precondition: ${error instanceof Error ? error.message : String(error)}`,
        nextStep: "Fix the verified precondition model failure before drawing a compatibility conclusion.",
      };
    }
    if (!valid) return { kind: "invalid" };

    const encoded = encodeArguments(fn, args, context);
    if (!encoded.ok && variant?.kind !== "numeric-projection") {
      return { kind: "unrepresentable", failure: encoded };
    }
    const runtimeArgs = variant?.args ?? (encoded.ok ? encoded.value : undefined);
    if (!Array.isArray(runtimeArgs)) return {
      kind: "not-checked",
      reason: "the runtime argument representation is not an argument tuple",
      nextStep: "Fix the semantic bridge before rerunning this comparison.",
    };

    let runtimeResponse: Record<string, unknown>;
    try {
      runtimeResponse = await workers.runtime.request({
        type: "call",
        target: runtimeTarget,
        args: encode(runtimeArgs),
      }, options.timeoutMs);
    } catch (error) {
      if (error instanceof WorkerTimeoutError) {
        if (variant?.kind === "numeric-projection") return { kind: "clean" };
        const model = await callModel(workers, fn, info, args, options.timeoutMs);
        return model.status === "ok"
          ? { kind: "issue", issue: { category: "runtime-timeout", args, modelResult: String(model.modelDisplay) } }
          : {
              kind: "not-checked",
              reason: `runtime and model could not be compared after timeout: ${String(model.error ?? model.status)}`,
              nextStep: "Fix the model execution failure, then rerun the timeout comparison.",
            };
      }
      return {
        kind: "not-checked",
        reason: `runtime worker failed: ${error instanceof Error ? error.message : String(error)}`,
        nextStep: "Fix the runtime worker failure and rerun the audit.",
      };
    }
    if (runtimeResponse.status === "unsupported") return {
      kind: "not-checked",
      reason: String(runtimeResponse.reason ?? "runtime target is unsupported"),
      nextStep: "Use a supported synchronous runtime target.",
    };
    if (runtimeResponse.status === "error") {
      const missingExport = runtimeResponse.kind === "missing-export";
      return {
        kind: "not-checked",
        reason: String(runtimeResponse.error ?? "runtime worker failed"),
        nextStep: missingExport
          ? `Export ${runtimeTarget} from the runtime module, or correct the mapping with --entry ${fn.name}=<export>.`
          : "Fix the runtime module failure and rerun the audit.",
      };
    }
    if (runtimeResponse.status === "threw") {
      if (variant?.kind === "numeric-projection") return { kind: "clean" };
      const model = await callModel(workers, fn, info, args, options.timeoutMs);
      return model.status === "ok"
        ? {
            kind: "issue",
            issue: {
              category: "runtime-threw",
              args,
              modelResult: String(model.modelDisplay),
              runtimeError: String(runtimeResponse.error),
              before: runtimeResponse.before as Encoded,
              after: runtimeResponse.after as Encoded,
              output: runtimeResponse.console as string[],
            },
          }
        : {
            kind: "not-checked",
            reason: `runtime and model both failed: ${String(model.error ?? model.status)}`,
            nextStep: "Fix the verified model execution failure before comparing the runtime exception.",
          };
    }

    const model = await callModel(workers, fn, info, args, options.timeoutMs, runtimeResponse.result as Encoded);
    if (model.status !== "ok" && variant?.kind === "numeric-projection") return { kind: "clean" };
    if (model.status !== "ok") return {
      kind: "not-checked",
      reason: `verified model failed: ${String(model.error ?? model.status)}`,
      nextStep: "Fix the verified model execution failure before drawing a compatibility conclusion.",
    };
    const common = {
      args,
      modelResult: String(model.modelDisplay),
      runtimeResult: runtimeResponse.result as Encoded,
      runtimeExact: String(model.runtimeExact ?? ""),
      before: runtimeResponse.before as Encoded,
      after: runtimeResponse.after as Encoded,
      output: runtimeResponse.console as string[],
    };
    if (model.equal !== true) return {
      kind: "issue",
      issue: {
        category: variant?.kind === "numeric-projection"
          ? "input-representation-mismatch"
          : variant?.kind === "optional-presence"
            ? "optional-presence"
            : "result-mismatch",
        ...common,
        ...(variant === undefined ? {} : { runtimeArgs: variant.args }),
        ...(variant?.kind === "optional-presence" ? { presencePath: variant.path } : {}),
        ...(variant?.kind === "numeric-projection" ? { representationLosses: variant.losses } : {}),
      },
    };
    if (variant?.kind === "numeric-projection") return { kind: "clean" };
    if (variant?.kind === "optional-presence") {
      const resultPresence = presentUndefinedPath(fn.returnTy, decode(runtimeResponse.result as Encoded), context);
      if (resultPresence) return {
        kind: "issue",
        issue: {
          category: "optional-presence",
          ...common,
          runtimeArgs: variant.args,
          presencePath: variant.path,
        },
      };
    }
    if (!encodedEqual(common.before, common.after)) return { kind: "issue", issue: { category: "input-mutation", ...common } };
    if (common.output.length > 0) return { kind: "issue", issue: { category: "console-output", ...common } };
    return { kind: "clean" };
  };

  const probeNumericProjection = async (args: unknown[]): Promise<CaseOutcome | null> => {
    const projection = projectArguments(fn, args, context);
    if (!projection.ok || projection.losses.length === 0) return null;
    return await evaluate(args, {
      kind: "numeric-projection",
      args: projection.value,
      losses: projection.losses,
    });
  };

  for (const args of allCases) {
    if (!options.replay && checked >= options.cases) break;
    const replayRuntimeArgs = options.replay?.runtimeArgs ? decode(options.replay.runtimeArgs) as unknown[] : undefined;
    let replayVariant: RuntimeVariant | undefined;
    if (replayRuntimeArgs && options.replay?.category === "input-representation-mismatch") {
      const projection = projectArguments(fn, args, context);
      if (!projection.ok || projection.losses.length === 0 || !stableArgsEqual(projection.value, replayRuntimeArgs)) {
        return notChecked(
          fn.name,
          runtimeTarget,
          options,
          "the replayed JavaScript arguments are not the current numeric projection of the formal witness",
          "Regenerate the case with the current semantic bridge.",
          checked,
        );
      }
      replayVariant = { kind: "numeric-projection", args: replayRuntimeArgs, losses: projection.losses };
    } else if (replayRuntimeArgs && options.replay?.presencePath) {
      replayVariant = { kind: "optional-presence", args: replayRuntimeArgs, path: options.replay.presencePath };
    }
    const outcome = await evaluate(args, replayVariant);
    if (outcome.kind === "invalid") continue;
    if (outcome.kind === "not-checked") {
      incomplete = {
        reason: outcome.reason ?? "Crosscheck could not complete this target.",
        nextStep: outcome.nextStep ?? "Resolve the reported failure and rerun the audit.",
      };
      break;
    }
    if (outcome.kind === "unrepresentable") {
      domainWitness ??= { args, failure: outcome.failure! };
      if (!projectedIssue) {
        const projected = await probeNumericProjection(args);
        if (projected?.kind === "issue" && projected.issue?.category === "input-representation-mismatch") {
          projectedIssue = projected.issue;
        }
      }
      continue;
    }
    checked++;
    let selectedOutcome = outcome;
    if (outcome.kind === "clean" && !options.replay) {
      const canonical = encodeArguments(fn, args, context);
      if (canonical.ok) {
        for (const variant of optionalPresenceVariants(fn.params.map(param => param.ty), args, canonical.value as unknown[], context)) {
          const variantOutcome = await evaluate(args, { kind: "optional-presence", args: variant.args, path: variant.path });
          if (variantOutcome.kind === "issue" || variantOutcome.kind === "not-checked") {
            selectedOutcome = variantOutcome;
            break;
          }
        }
      }
      if (selectedOutcome.kind === "clean" && !projectedIssue) {
        for (const variant of numericPrecisionVariants(fn.params, args, context)) {
          if (precisionTried.has(variant.key)) continue;
          precisionTried.add(variant.key);
          const exactOutcome = await evaluate(variant.args);
          if (exactOutcome.kind === "unrepresentable") {
            domainWitness ??= { args: variant.args, failure: exactOutcome.failure! };
            const projected = await probeNumericProjection(variant.args);
            if (projected?.kind === "issue" && projected.issue?.category === "input-representation-mismatch") {
              projectedIssue = projected.issue;
              break;
            }
          } else if (exactOutcome.kind === "issue") {
            selectedOutcome = exactOutcome;
            break;
          }
        }
      }
    }
    if (selectedOutcome.kind === "not-checked") {
      incomplete = {
        reason: selectedOutcome.reason ?? "Crosscheck could not complete this target.",
        nextStep: selectedOutcome.nextStep ?? "Resolve the reported failure and rerun the audit.",
      };
      break;
    }
    if (selectedOutcome.kind === "issue") {
      const original = selectedOutcome.issue!;
      const canShrink = original.category !== "optional-presence"
        && original.category !== "runtime-timeout"
        && original.category !== "input-representation-mismatch";
      const minimized = options.replay || !canShrink ? original.args : await shrinkArgs(original.args, async candidate => {
        const result = await evaluate(candidate);
        return result.kind === "issue" && result.issue?.category === original.category;
      });
      const replayed = stableArgsEqual(minimized, original.args) ? original : (await evaluate(minimized)).issue ?? original;
      return await issueReport(fn, runtimeTarget, identity, checked, options, replayed);
    }
  }

  if (incomplete) {
    return notChecked(
      fn.name,
      runtimeTarget,
      options,
      incomplete.reason,
      incomplete.nextStep,
      checked,
    );
  }
  if (projectedIssue) {
    return await issueReport(fn, runtimeTarget, identity, checked, options, projectedIssue);
  }
  if (domainWitness) {
    // Retain the precondition-valid input and its original bridge failure.
    // The representation-directed shrinker can invalidate union members or
    // tuple shapes and mistake that invalid value for another domain witness.
    return await domainIssueReport(fn, runtimeTarget, identity, checked, options, domainWitness);
  }
  if (checked === 0) {
    return notChecked(fn.name, runtimeTarget, options, "no generated input satisfied the verified precondition", "Increase --cases or strengthen the generator for this precondition.");
  }
  return {
    target: fn.name,
    runtimeTarget,
    conclusion: "no-issue",
    evidence: fn.params.length === 0 ? "exhaustive" : "sampled",
    cases: checked,
    seed: options.seed,
  };
}

async function auditRuntimeContractTarget(
  fn: TypedFunction,
  info: TypedInfo,
  identity: AuditIdentity,
  workers: AuditWorkers,
  options: AuditOptions,
): Promise<TargetReport> {
  const runtimeTarget = options.entries.get(fn.name) ?? fn.name;
  const context: BridgeContext = {
    declarations: new Map(info.typeDecls.map(declaration => [declaration.name, declaration])),
  };
  const unsupported = supportReason(fn, context);
  if (unsupported) {
    return notChecked(
      fn.name,
      runtimeTarget,
      options,
      `runtime contract target is unsupported: ${unsupported}`,
      "Use a supported synchronous value type or extend the runtime contract bridge.",
    );
  }
  const allCases = options.replay
    ? [decode(options.replay.args) as unknown[]]
    : runtimeCandidateCases(fn, info, options.cases, options.seed);
  let checked = 0;
  let domainWitness: RuntimeDomainWitness | undefined;
  let incomplete: { reason: string; nextStep: string } | undefined;

  const callRuntime = async (name: string, args: unknown[]): Promise<unknown> => {
    let response: Record<string, unknown>;
    try {
      response = await workers.runtime.request({
        type: "call",
        target: options.entries.get(name) ?? name,
        args: encode(args),
      }, options.timeoutMs);
    } catch (error) {
      if (error instanceof WorkerTimeoutError) throw new RuntimeSpecUnsupported(`runtime predicate ${name} timed out`);
      throw new RuntimeSpecUnsupported(`runtime predicate ${name} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (response.status !== "ok") {
      throw new RuntimeSpecUnsupported(
        `runtime predicate ${name} ${response.status === "threw" ? "threw" : "failed"}: ${String(response.error ?? response.reason ?? response.status)}`,
      );
    }
    return decode(response.result as Encoded);
  };

  for (const args of allCases) {
    if (!options.replay && checked >= options.cases) break;
    let valid: boolean;
    try {
      valid = await satisfiesRuntimePreconditions(fn, args, info.constants, callRuntime, info.typeDecls);
    } catch (error) {
      incomplete = runtimeContractIncomplete("precondition", error);
      break;
    }
    if (!valid) continue;
    checked++;
    const failure = runtimeArgumentsDomainFailure(fn, args, context);

    let runtimeResponse: Record<string, unknown>;
    try {
      runtimeResponse = await workers.runtime.request({
        type: "call",
        target: runtimeTarget,
        args: encode(args),
      }, options.timeoutMs);
    } catch (error) {
      if (error instanceof WorkerTimeoutError) {
        return await runtimeContractViolationReport(fn, runtimeTarget, identity, checked, options, {
          args,
          runtimeError: `<timeout after ${options.timeoutMs} ms>`,
        });
      }
      incomplete = {
        reason: `runtime contract worker failed: ${error instanceof Error ? error.message : String(error)}`,
        nextStep: "Fix the runtime worker failure and rerun the contract audit.",
      };
      break;
    }
    if (runtimeResponse.status === "unsupported") {
      incomplete = {
        reason: String(runtimeResponse.reason ?? "runtime contract target is unsupported"),
        nextStep: "Use a supported synchronous runtime target.",
      };
      break;
    }
    if (runtimeResponse.status === "error") {
      const missingExport = runtimeResponse.kind === "missing-export";
      incomplete = {
        reason: String(runtimeResponse.error ?? "runtime contract worker failed"),
        nextStep: missingExport
          ? `Export ${runtimeTarget} from the runtime module, or correct the mapping with --entry ${fn.name}=<export>.`
          : "Fix the runtime module failure and rerun the contract audit.",
      };
      break;
    }
    if (runtimeResponse.status === "threw") {
      return await runtimeContractViolationReport(fn, runtimeTarget, identity, checked, options, {
        args,
        runtimeError: String(runtimeResponse.error ?? "JavaScript threw"),
      });
    }

    const result = runtimeResponse.result as Encoded;
    const after = decode(runtimeResponse.after as Encoded);
    const postArgs = Array.isArray(after) ? after : args;
    try {
      const postcondition = await checkRuntimePostconditions(
        fn,
        postArgs,
        decode(result),
        info.constants,
        callRuntime,
        info.typeDecls,
      );
      if (postcondition.status === "failed") {
        return await runtimeContractViolationReport(fn, runtimeTarget, identity, checked, options, {
          args,
          runtimeResult: result,
          postconditionClause: postcondition.clause,
        });
      }
      if (failure && !domainWitness) {
        domainWitness = { args, failure, runtimeResult: result, postconditionsSatisfied: true };
      }
    } catch (error) {
      if (failure) {
        domainWitness ??= { args, failure, runtimeResult: result };
        continue;
      }
      incomplete = runtimeContractIncomplete("postcondition", error);
      break;
    }
  }

  if (domainWitness) {
    return await runtimeDomainIssueReport(fn, runtimeTarget, identity, checked, options, domainWitness);
  }
  if (incomplete) {
    return notChecked(fn.name, runtimeTarget, options, incomplete.reason, incomplete.nextStep, checked);
  }
  if (checked === 0) {
    return notChecked(
      fn.name,
      runtimeTarget,
      options,
      "no generated TypeScript input satisfied the runtime precondition",
      "Increase --cases or strengthen the TypeScript-domain generator for this precondition.",
    );
  }
  if (options.replay) {
    return notChecked(
      fn.name,
      runtimeTarget,
      options,
      `replay ${options.replay.id} no longer reproduces ${options.replay.category}`,
      "Record a new counterexample with the current source and Crosscheck version.",
      checked,
    );
  }
  return {
    target: fn.name,
    runtimeTarget,
    conclusion: "no-issue",
    evidence: fn.params.length === 0 ? "exhaustive" : "sampled",
    cases: checked,
    seed: options.seed,
  };
}

function runtimeArgumentsDomainFailure(
  fn: TypedFunction,
  args: unknown[],
  context: BridgeContext,
): RuntimeDomainFailure | null {
  for (let index = 0; index < fn.params.length; index++) {
    const param = fn.params[index]!;
    const failure = runtimeDomainFailure(param.ty, args[index], context, param.tsType, param.name);
    if (failure) return failure;
  }
  return null;
}

function runtimeContractIncomplete(
  phase: "precondition" | "postcondition",
  error: unknown,
): { reason: string; nextStep: string } {
  const detail = error instanceof RuntimeSpecUnsupported
    ? error.reason
    : error instanceof Error ? error.message : String(error);
  return {
    reason: `runtime ${phase} semantics are unsupported: ${detail}`,
    nextStep: `Extend the JavaScript ${phase} evaluator before drawing a runtime-contract conclusion.`,
  };
}

function supportReason(fn: TypedFunction, context: BridgeContext): string | null {
  if (fn.typeParams.length) return "generic targets are not yet supported";
  if (fn.autohavoc || fn.bodyKinds.includes("havoc") || fn.bodyKinds.includes("assume")) {
    return "the verified model contains nondeterministic or assumed behavior";
  }
  for (const param of fn.params) {
    const reason = typeSupportReason(param.ty, context);
    if (reason) return `${param.name}: ${reason}`;
  }
  const resultReason = typeSupportReason(fn.returnTy, context);
  return resultReason ? `result: ${resultReason}` : null;
}

function encodeArguments(fn: TypedFunction, args: unknown[], context: BridgeContext): RuntimeEncodingResult {
  const output: unknown[] = [];
  for (let index = 0; index < fn.params.length; index++) {
    const param = fn.params[index]!;
    const encoded = encodeRuntime(param.ty, args[index], context, param.tsType, param.name);
    if (!encoded.ok) return encoded;
    output.push(encoded.value);
  }
  return { ok: true, value: output };
}

type ArgumentProjection =
  | { ok: true; value: unknown[]; losses: RuntimeProjectionLoss[] }
  | RuntimeEncodingFailure;

function projectArguments(fn: TypedFunction, args: unknown[], context: BridgeContext): ArgumentProjection {
  const output: unknown[] = [];
  const losses: RuntimeProjectionLoss[] = [];
  for (let index = 0; index < fn.params.length; index++) {
    const param = fn.params[index]!;
    const projected = projectRuntime(param.ty, args[index], context, param.tsType, param.name);
    if (!projected.ok) return projected;
    output.push(projected.value);
    losses.push(...projected.losses);
  }
  return { ok: true, value: output, losses };
}

async function callModel(
  workers: AuditWorkers,
  fn: TypedFunction,
  info: TypedInfo,
  args: unknown[],
  timeoutMs: number,
  runtimeResult?: Encoded,
): Promise<Record<string, unknown>> {
  try {
    return await workers.model.request({
      type: "call",
      target: info.dafny.emittedNames?.[fn.name] ?? fn.name,
      paramTys: fn.params.map(param => param.ty),
      returnTy: fn.returnTy,
      args: encode(args),
      ...(runtimeResult === undefined ? {} : { runtimeResult }),
    }, timeoutMs);
  } catch (error) {
    return { status: "error", error: error instanceof Error ? error.message : String(error) };
  }
}

async function issueReport(
  fn: TypedFunction,
  runtimeTarget: string,
  identity: AuditIdentity,
  cases: number,
  options: AuditOptions,
  observed: ExecutedIssue,
): Promise<TargetReport> {
  const args = encode(observed.args);
  const runtimeArgs = observed.runtimeArgs === undefined ? undefined : encode(observed.runtimeArgs);
  const idWitness = runtimeArgs === undefined ? args : encode([decode(args), decode(runtimeArgs)]);
  const id = issueId({
    sourceSha256: identity.sourceSha256,
    runtimeSha256: identity.runtimeSha256,
    target: fn.name,
    runtimeTarget,
    category: observed.category,
    args: idWitness,
  });
  const language = issueLanguage(observed.category, fn.returnTy);
  const issue: Issue = {
    id,
    category: observed.category,
    summary: language.summary,
    diagnosis: language.diagnosis,
    resolution: language.resolution,
    args,
    paramNames: fn.params.map(param => param.name),
    argDisplays: fn.params.map((param, index) => formatModelInput(param.ty, observed.args[index])),
    ...(observed.runtimeArgs === undefined ? {} : {
      runtimeArgDisplays: fn.params.map((_, index) => formatRuntimeInput(observed.runtimeArgs![index])),
    }),
    ...(observed.representationLosses === undefined ? {} : {
      representationLosses: observed.representationLosses.map(loss => ({
        path: loss.path,
        formalValue: encode(loss.formalValue),
        runtimeValue: encode(loss.runtimeValue),
      })),
    }),
    ...(observed.modelResult === undefined ? {} : { modelResult: observed.modelResult }),
    ...(observed.runtimeResult === undefined ? {} : { runtimeResult: observed.runtimeResult }),
    ...(observed.runtimeExact === undefined ? {} : { runtimeExact: observed.runtimeExact }),
    ...(observed.before === undefined ? {} : { mutationBefore: observed.before }),
    ...(observed.after === undefined ? {} : { mutationAfter: observed.after }),
    ...(observed.output === undefined ? {} : { console: observed.output }),
    ...(observed.runtimeError === undefined ? {} : { runtimeError: observed.runtimeError }),
  };
  if (options.saveCases) await saveCase({
    schema: "lemmascript-crosscheck.case/v2", id,
    source: identity.source, sourceSha256: identity.sourceSha256,
    runtime: identity.runtime, runtimeSha256: identity.runtimeSha256,
    target: fn.name, runtimeTarget, category: observed.category, args,
    ...(runtimeArgs === undefined ? {} : { runtimeArgs }),
    ...(observed.presencePath === undefined ? {} : { presencePath: observed.presencePath }),
  });
  return { target: fn.name, runtimeTarget, conclusion: "issue", evidence: "counterexample", cases, seed: options.seed, issue };
}

async function runtimeDomainIssueReport(
  fn: TypedFunction,
  runtimeTarget: string,
  identity: AuditIdentity,
  cases: number,
  options: AuditOptions,
  witness: RuntimeDomainWitness,
): Promise<TargetReport> {
  const args = encode(witness.args);
  const id = issueId({
    sourceSha256: identity.sourceSha256,
    runtimeSha256: identity.runtimeSha256,
    target: fn.name,
    runtimeTarget,
    category: "proof-domain-gap",
    args,
  });
  const issue: Issue = {
    id,
    category: "proof-domain-gap",
    summary: "TypeScript accepts a precondition-valid input outside the verified domain",
    diagnosis: witness.failure.reason,
    resolution: "Narrow and enforce the TypeScript input domain at runtime, or widen the formal type and proof to cover this value.",
    args,
    paramNames: fn.params.map(param => param.name),
    argDisplays: witness.args.map(formatRuntimeInput),
    runtimePath: witness.failure.path,
    runtimeValue: encode(witness.failure.runtimeValue),
    runtimeDisplay: formatRuntimeInput(witness.failure.runtimeValue),
    ...(witness.runtimeResult === undefined ? {} : { runtimeResult: witness.runtimeResult }),
    ...(witness.postconditionsSatisfied === undefined ? {} : {
      postconditionsSatisfied: witness.postconditionsSatisfied,
    }),
  };
  if (options.saveCases) await saveCase({
    schema: "lemmascript-crosscheck.case/v2",
    id,
    source: identity.source,
    sourceSha256: identity.sourceSha256,
    runtime: identity.runtime,
    runtimeSha256: identity.runtimeSha256,
    target: fn.name,
    runtimeTarget,
    category: "proof-domain-gap",
    args,
  });
  return { target: fn.name, runtimeTarget, conclusion: "issue", evidence: "counterexample", cases, seed: options.seed, issue };
}

async function runtimeContractViolationReport(
  fn: TypedFunction,
  runtimeTarget: string,
  identity: AuditIdentity,
  cases: number,
  options: AuditOptions,
  observed: RuntimeContractViolation,
): Promise<TargetReport> {
  const args = encode(observed.args);
  const id = issueId({
    sourceSha256: identity.sourceSha256,
    runtimeSha256: identity.runtimeSha256,
    target: fn.name,
    runtimeTarget,
    category: "runtime-postcondition-violation",
    args,
  });
  const threw = observed.runtimeError !== undefined;
  const issue: Issue = {
    id,
    category: "runtime-postcondition-violation",
    summary: threw
      ? "TypeScript does not return on a precondition-valid runtime input"
      : "TypeScript violates a postcondition on a precondition-valid runtime input",
    diagnosis: threw
      ? `The runtime could not produce a result required by the contract: ${observed.runtimeError}`
      : `Runtime postcondition clause ${observed.postconditionClause ?? "<unknown>"} evaluated to false using JavaScript semantics.`,
    resolution: "Repair the TypeScript implementation or strengthen and enforce its runtime precondition.",
    args,
    paramNames: fn.params.map(param => param.name),
    argDisplays: observed.args.map(formatRuntimeInput),
    ...(observed.runtimeResult === undefined ? {} : { runtimeResult: observed.runtimeResult }),
    ...(observed.runtimeError === undefined ? {} : { runtimeError: observed.runtimeError }),
    ...(observed.postconditionClause === undefined ? {} : {
      postconditionClause: observed.postconditionClause,
    }),
  };
  if (options.saveCases) await saveCase({
    schema: "lemmascript-crosscheck.case/v2",
    id,
    source: identity.source,
    sourceSha256: identity.sourceSha256,
    runtime: identity.runtime,
    runtimeSha256: identity.runtimeSha256,
    target: fn.name,
    runtimeTarget,
    category: "runtime-postcondition-violation",
    args,
  });
  return { target: fn.name, runtimeTarget, conclusion: "issue", evidence: "counterexample", cases, seed: options.seed, issue };
}

async function domainIssueReport(
  fn: TypedFunction,
  runtimeTarget: string,
  identity: AuditIdentity,
  cases: number,
  options: AuditOptions,
  witness: DomainWitness,
): Promise<TargetReport> {
  const args = encode(witness.args);
  const id = issueId({
    sourceSha256: identity.sourceSha256,
    runtimeSha256: identity.runtimeSha256,
    target: fn.name,
    runtimeTarget,
    category: "input-domain",
    args,
  });
  const issue: Issue = {
    id,
    category: "input-domain",
    summary: "the proof accepts an input JavaScript cannot represent exactly",
    diagnosis: witness.failure.reason,
    resolution: "Use bigint, or restrict and prove the JavaScript representation domain.",
    args,
    paramNames: fn.params.map(param => param.name),
    argDisplays: fn.params.map((param, index) => formatModelInput(param.ty, witness.args[index])),
    formalPath: witness.failure.path,
    formalValue: encode(witness.failure.formalValue),
    formalDisplay: formatFormalValue(witness.failure.formalValue),
  };
  if (options.saveCases) await saveCase({
    schema: "lemmascript-crosscheck.case/v2", id,
    source: identity.source, sourceSha256: identity.sourceSha256,
    runtime: identity.runtime, runtimeSha256: identity.runtimeSha256,
    target: fn.name, runtimeTarget, category: "input-domain", args,
  });
  return { target: fn.name, runtimeTarget, conclusion: "issue", evidence: "counterexample", cases, seed: options.seed, issue };
}

function issueLanguage(category: DifferentialIssueCategory, returnTy: Ty): { summary: string; diagnosis: string; resolution: string } {
  if (category === "input-representation-mismatch") return {
    summary: "JavaScript input rounding changes the result",
    diagnosis: "JavaScript's IEEE-754 number representation rounds an exact formal numeric input before the function executes; distinct formal values can therefore collapse to the same runtime value.",
    resolution: "Use an exact runtime representation, or restrict and enforce inputs to values that remain exact as JavaScript numbers.",
  };
  if (category === "result-mismatch" && (returnTy.kind === "int" || returnTy.kind === "nat") && !returnTy.big) {
    return {
      summary: "result differs because JavaScript integer arithmetic lost precision",
      diagnosis: "The verified model uses exact integers, while this TypeScript result is represented by an IEEE-754 number.",
      resolution: "Use bigint, or prove that every input, intermediate, and result remains exact as a JavaScript number.",
    };
  }
  if (category === "result-mismatch" && returnTy.kind === "real") {
    return {
      summary: "result differs because binary floating-point is not the exact real result",
      diagnosis: "The verified model computes an exact rational, while JavaScript computes the nearest binary64 value.",
      resolution: "Use an exact numeric representation, or change the specification to an explicit rounding/error contract.",
    };
  }
  if (category === "result-mismatch") return {
    summary: "JavaScript returned a different result from the verified model",
    diagnosis: "Whole-function differential execution found unequal observable results.",
    resolution: "Make the runtime representation and operations agree with the verified model.",
  };
  if (category === "input-mutation") return {
    summary: "JavaScript mutates an input absent from the verified model",
    diagnosis: "LemmaScript models the argument as an immutable value, but the caller-visible JavaScript argument changed.",
    resolution: "Return a new value, or add caller-visible mutation to the formal effect model.",
  };
  if (category === "optional-presence") return {
    summary: "JavaScript distinguishes an omitted property from a present undefined property",
    diagnosis: "The formal optional value is absent in both cases, but JavaScript object spread and property presence can observe the difference.",
    resolution: "Canonicalize optional records at the boundary, or extend the formal representation to track property presence.",
  };
  if (category === "console-output") return {
    summary: "JavaScript produces output absent from the verified model",
    diagnosis: "The runtime emitted an observable effect that the functional model does not contain.",
    resolution: "Remove the effect, or model it explicitly before crosschecking this target.",
  };
  if (category === "runtime-threw") return {
    summary: "JavaScript throws on an input where the verified model returns",
    diagnosis: "A proof-valid, representable input has different termination behavior.",
    resolution: "Handle this input without throwing, or constrain it in the verified precondition.",
  };
  return {
    summary: "JavaScript does not terminate within the deadline while the verified model returns",
    diagnosis: "A proof-valid, representable input has different termination behavior.",
    resolution: "Repair the runtime loop/resource behavior, or state and enforce a smaller verified domain.",
  };
}

function notChecked(
  target: string,
  runtimeTarget: string,
  options: AuditOptions,
  reason: string,
  nextStep: string,
  cases = 0,
): TargetReport {
  return {
    target, runtimeTarget, conclusion: "not-checked", evidence: "tool-failure",
    cases, seed: options.seed, reason, nextStep,
  };
}

function stableArgsEqual(left: unknown[], right: unknown[]): boolean {
  return JSON.stringify(encode(left)) === JSON.stringify(encode(right));
}

function formatModelInput(ty: Ty, value: unknown): string {
  if ((ty.kind === "int" || ty.kind === "nat") && typeof value === "bigint") return ty.big ? `${value}n` : value.toString();
  if (ty.kind === "real" && value && typeof value === "object" && "toString" in value) return String(value);
  if (ty.kind === "array" && Array.isArray(value)) return `[${value.map(entry => formatModelInput(ty.elem, entry)).join(", ")}]`;
  if (ty.kind === "tuple" && Array.isArray(value)) return `[${value.map((entry, index) => formatModelInput(ty.elems[index]!, entry)).join(", ")}]`;
  if (ty.kind === "optional") return value === undefined ? "<omitted>" : formatModelInput(ty.inner, value);
  return formatFormalValue(value);
}

function formatFormalValue(value: unknown): string {
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(formatFormalValue).join(", ")}]`;
  if (value && typeof value === "object") {
    const fields = Object.entries(value).filter(([, entry]) => entry !== undefined);
    return `{ ${fields.map(([key, entry]) => `${key}: ${formatFormalValue(entry)}`).join(", ")} }`;
  }
  if (value === undefined) return "<omitted>";
  return String(value);
}

function formatRuntimeInput(value: unknown): string {
  if (typeof value === "bigint") return `${value}n`;
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(formatRuntimeInput).join(", ")}]`;
  if (value && typeof value === "object") {
    return `{ ${Object.entries(value).map(([key, entry]) => `${key}: ${entry === undefined ? "<present undefined>" : formatRuntimeInput(entry)}`).join(", ")} }`;
  }
  if (value === undefined) return "<present undefined>";
  return String(value);
}
