import assert from "node:assert/strict";
import test from "node:test";
import { decode } from "../../src/codec.js";
import { renderReport } from "../../src/report.js";
import { auditFixture } from "./harness.js";

test("mutable closures expose stale captures", async t => {
  const report = await auditFixture(t, "closures.ts", 1, ["--cases", "1"]);
  assert.equal(report.targets.length, 4);
  for (const [name, model, runtime] of [
    ["late", "2", 6],
    ["stale", "1", 2],
    ["viaAlias", "0", 1],
  ] as const) {
    const target = report.targets.find(candidate => candidate.target === name);
    assert.ok(target, name);
    assert.equal(target.conclusion, "issue");
    assert.equal(target.cases, 1);
    assert.equal(target.issue?.category, "result-mismatch");
    assert.equal(target.issue?.modelResult, model);
    assert.equal(decode(target.issue!.runtimeResult!), runtime);
  }
  const control = report.targets.find(target => target.target === "constantCapture");
  assert.equal(control?.conclusion, "no-issue");
  assert.equal(control?.cases, 1);
  const rendered = renderReport(report, { details: true });
  assert.match(rendered, /JavaScript returned a different result from the verified model/);
  assert.doesNotMatch(rendered, /precision|floating.point|bigint|round/i);
});

test("runtime contracts expose a false verified postcondition", async t => {
  const contract = await auditFixture(t, "closures.ts", 1, ["--only", "late", "--checks", "contract,differential"]);
  assert.equal(contract.targets[0]?.issue?.category, "runtime-postcondition-violation");
  assert.equal(contract.targets[0]?.issue?.postconditionClause, 1);
  assert.equal(decode(contract.targets[0]!.issue!.runtimeResult!), 6);
});

test("invalid generated Dafny remains visibly not checked", async t => {
  // This void helper call currently produces invalid Dafny. It must remain
  // visibly NOT CHECKED rather than turning missing coverage into success.
  const unsupported = await auditFixture(t, "closure-via-call.ts", 2, ["--only", "viaCall"]);
  assert.equal(unsupported.targets[0]?.conclusion, "not-checked");
  assert.equal(unsupported.targets[0]?.cases, 0);
  assert.match(unsupported.targets[0]?.reason ?? "", /method returns 0 value/);
});

test("integer arithmetic exposes a result mismatch on an exact input", async t => {
  const report = await auditFixture(t, "integer-precision.ts", 1, ["--cases", "40"]);
  assert.equal(report.targets.length, 1);
  const issue = report.targets[0]?.issue;
  assert.equal(issue?.category, "result-mismatch");
  assert.deepEqual(decode(issue!.args), [9_007_199_254_740_992n]);
  assert.equal(issue?.modelResult, "9007199254740993");
  assert.equal(decode(issue!.runtimeResult!), 9_007_199_254_740_992);
});

test("array mutation exposes a caller-visible effect absent from the model", async t => {
  const report = await auditFixture(t, "input-mutation.ts", 1, ["--cases", "1"]);
  assert.equal(report.targets.length, 1);
  const issue = report.targets[0]?.issue;
  assert.equal(issue?.category, "input-mutation");
  assert.deepEqual(decode(issue!.args), [[]]);
  assert.deepEqual(decode(issue!.mutationBefore!), [[]]);
  assert.deepEqual(decode(issue!.mutationAfter!), [[1]]);
});
