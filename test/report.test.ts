import assert from "node:assert/strict";
import test from "node:test";
import { encode } from "../src/codec.js";
import { renderReport } from "../src/report.js";
import type { AuditReport } from "../src/report-types.js";

test("sampled success says it is not a proof", () => {
  const report: AuditReport = {
    schema: "lemmascript-crosscheck.report/v1",
    targets: [{
      target: "search", runtimeTarget: "search", conclusion: "no-issue", evidence: "sampled",
      cases: 100, seed: 17,
    }],
  };
  assert.match(renderReport(report, { details: false }), /100 sampled proof-valid inputs · seed 17 · not a proof/);
});

test("contract-only success describes TypeScript-domain evidence", () => {
  const report: AuditReport = {
    schema: "lemmascript-crosscheck.report/v1",
    targets: [{
      target: "search",
      runtimeTarget: "search",
      conclusion: "no-issue",
      evidence: "sampled",
      cases: 40,
      seed: 17,
      checks: ["contract"],
    }],
  };
  const text = renderReport(report, { details: false });
  assert.match(text, /40 sampled precondition-valid TypeScript inputs/);
  assert.doesNotMatch(text, /proof-valid inputs/);
});

test("a numeric counterexample leads with exact expected and actual values", () => {
  const report: AuditReport = {
    schema: "lemmascript-crosscheck.report/v1",
    provenance: {
      source: "/tmp/arraySum.ts", sourceSha256: "s", artifact: "/tmp/arraySum.dfy",
      artifactSha256: "a", lemmascript: "0.6.0", dafny: "4.11.0", runtime: "/tmp/arraySum.ts", runtimeSha256: "r",
    },
    targets: [{
      target: "arraySum", runtimeTarget: "arraySum", conclusion: "issue", evidence: "counterexample",
      cases: 4, seed: 17,
      issue: {
        id: "1234567890", category: "result-mismatch",
        summary: "JavaScript returned a different result from the verified model",
        diagnosis: "Whole-function differential execution found unequal observable results.",
        resolution: "Inspect the source and generated model to locate the differing behavior for this input.",
        args: encode([[9_007_199_254_740_991n, 2n]]), paramNames: ["arr"],
        argDisplays: ["[9007199254740991, 2]"], modelResult: "9007199254740993",
        runtimeResult: encode(9_007_199_254_740_992), runtimeExact: "9007199254740992",
      },
    }],
  };
  const text = renderReport(report, { details: false });
  assert.match(text, /arraySum — ISSUE FOUND/);
  assert.match(text, /verified\s+9007199254740993/);
  assert.match(text, /JavaScript\s+9007199254740992/);
  assert.match(text, /JavaScript returned a different result from the verified model/);
  assert.match(text, /Replay\n  lemmascript-crosscheck \/tmp\/arraySum\.ts --replay 1234567890/);
  assert.match(text, /Evidence: replayed counterexample · Dafny 4\.11\.0 model/);
});

test("an input representation mismatch shows formal and rounded JavaScript arguments", () => {
  const report: AuditReport = {
    schema: "lemmascript-crosscheck.report/v1",
    targets: [{
      target: "binarySearch", runtimeTarget: "binarySearch", conclusion: "issue", evidence: "counterexample",
      cases: 10, seed: 17,
      issue: {
        id: "1234567890", category: "input-representation-mismatch",
        summary: "JavaScript input rounding changes the result",
        diagnosis: "Distinct model inputs collapsed.", resolution: "Use bigint.",
        args: encode([[9_007_199_254_740_992n], 9_007_199_254_740_993n]),
        paramNames: ["arr", "target"],
        argDisplays: ["[9007199254740992]", "9007199254740993"],
        runtimeArgDisplays: ["[9007199254740992]", "9007199254740992"],
        representationLosses: [{
          path: "target",
          formalValue: encode(9_007_199_254_740_993n),
          runtimeValue: encode(9_007_199_254_740_992),
        }],
        modelResult: "-1", runtimeResult: encode(0), runtimeExact: "0",
      },
    }],
  };

  const text = renderReport(report, { details: false });
  assert.match(text, /Formal input/);
  assert.match(text, /JavaScript representation/);
  assert.match(text, /target\s+9007199254740993 → 9007199254740992/);
  assert.match(text, /verified\s+-1/);
  assert.match(text, /JavaScript\s+0/);
});

test("a proof-domain gap is rendered as an executed TypeScript witness", () => {
  const report: AuditReport = {
    schema: "lemmascript-crosscheck.report/v1",
    targets: [{
      target: "binarySearch",
      runtimeTarget: "binarySearch",
      conclusion: "issue",
      evidence: "counterexample",
      cases: 3,
      seed: 17,
      issue: {
        id: "1234567890",
        category: "proof-domain-gap",
        summary: "TypeScript accepts a precondition-valid input outside the verified domain",
        diagnosis: "fractional TypeScript number is outside the verified int domain",
        resolution: "Narrow the runtime domain.",
        args: encode([[0.5], 0]),
        paramNames: ["arr", "target"],
        argDisplays: ["[0.5]", "0"],
        runtimePath: "arr[0]",
        runtimeValue: encode(0.5),
        runtimeDisplay: "0.5",
        runtimeResult: encode(-1),
        postconditionsSatisfied: true,
      },
    }],
  };

  const text = renderReport(report, { details: false });
  assert.match(text, /TypeScript witness/);
  assert.match(text, /Outside verified domain/);
  assert.match(text, /arr\[0\]\s+0\.5/);
  assert.match(text, /postconditions, but the Dafny proof does not cover this input/);
  assert.match(text, /executed TypeScript contract counterexample/);
});

test("an alternate runtime is included in the replay command", () => {
  const report: AuditReport = {
    schema: "lemmascript-crosscheck.report/v1",
    provenance: {
      source: "/tmp/source.ts", sourceSha256: "s", artifact: "/tmp/source.dfy",
      artifactSha256: "a", lemmascript: "0.6.0", dafny: "4.11.0", runtime: "/tmp/dist/runtime.js", runtimeSha256: "r",
    },
    targets: [{
      target: "formal", runtimeTarget: "deployed", conclusion: "issue", evidence: "counterexample",
      cases: 1, seed: 17,
      issue: {
        id: "1234567890", category: "result-mismatch",
        summary: "results differ", diagnosis: "Different results", resolution: "Repair the runtime",
        args: encode([0n]), paramNames: ["x"], argDisplays: ["0"],
        modelResult: "0", runtimeResult: encode(1), runtimeExact: "1",
      },
    }],
  };

  assert.match(
    renderReport(report, { details: false }),
    /lemmascript-crosscheck \/tmp\/source\.ts --runtime \/tmp\/dist\/runtime\.js --replay 1234567890/,
  );
});

test("present undefined is not rendered as an omitted object property", () => {
  const value = { retries: undefined };
  const rendered = renderReport({
    schema: "lemmascript-crosscheck.report/v1",
    targets: [{
      target: "withDefaults", runtimeTarget: "withDefaults", conclusion: "issue", evidence: "counterexample", cases: 1, seed: 17,
      issue: {
        id: "1234567890", category: "optional-presence",
        summary: "optional presence differs", diagnosis: "Presence differs", resolution: "Canonicalize",
        args: encode([{}]), paramNames: ["value"], argDisplays: ["{  }"],
        runtimeArgDisplays: ["{ retries: <present undefined> }"],
        modelResult: "None", runtimeResult: encode(value), runtimeExact: "None",
      },
    }],
  }, { details: false });
  assert.match(rendered, /JavaScript\s+\{ retries: <present undefined> \}/);
});

test("the not-checked fallback suggests an available action", () => {
  const rendered = renderReport({
    schema: "lemmascript-crosscheck.report/v1",
    targets: [{
      target: "search", runtimeTarget: "search", conclusion: "not-checked",
      evidence: "tool-failure", cases: 0, seed: 17, reason: "worker failed",
    }],
  }, { details: false });
  assert.doesNotMatch(rendered, /--debug/);
  assert.match(rendered, /Resolve the reported failure and rerun the audit/);
});
