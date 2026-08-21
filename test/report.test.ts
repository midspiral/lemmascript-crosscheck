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

test("a numeric counterexample leads with exact expected and actual values", () => {
  const report: AuditReport = {
    schema: "lemmascript-crosscheck.report/v1",
    provenance: {
      source: "/tmp/arraySum.ts", sourceSha256: "s", artifact: "/tmp/arraySum.dfy",
      artifactSha256: "a", lemmascript: "0.6.0", dafny: "4.11.0", runtime: "/tmp/arraySum.ts",
    },
    targets: [{
      target: "arraySum", runtimeTarget: "arraySum", conclusion: "issue", evidence: "counterexample",
      cases: 4, seed: 17,
      issue: {
        id: "1234567890", category: "result-mismatch",
        summary: "result differs because JavaScript integer arithmetic lost precision",
        diagnosis: "The model is exact.", resolution: "Use bigint.",
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
  assert.match(text, /Replay\n  lemmascript-crosscheck \/tmp\/arraySum\.ts --replay 1234567890/);
  assert.match(text, /Evidence: replayed counterexample · Dafny 4\.11\.0 model/);
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
