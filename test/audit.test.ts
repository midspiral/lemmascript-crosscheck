import assert from "node:assert/strict";
import test from "node:test";
import { auditTarget, type AuditOptions } from "../src/audit.js";
import { decode, encode, type Encoded } from "../src/codec.js";
import type { TypedFunction, TypedInfo } from "../src/ir.js";
import { WorkerTimeoutError, type JsonLineRequestClient } from "../src/json-line-client.js";
import type { AuditWorkers } from "../src/workers.js";

const arrayFn: TypedFunction = {
  name: "f",
  exported: true,
  typeParams: [],
  params: [{ name: "values", ty: { kind: "array", elem: { kind: "int" } }, tsType: "number[]" }],
  returnTy: { kind: "int" },
  requires: [],
  ensures: [],
  decreases: null,
  contract: [],
  isPure: true,
  forcePure: false,
  autohavoc: false,
  bodyKinds: ["return"],
};

const searchFn: TypedFunction = {
  ...arrayFn,
  name: "search",
  params: [
    { name: "arr", ty: { kind: "array", elem: { kind: "int" } }, tsType: "number[]" },
    { name: "target", ty: { kind: "int" }, tsType: "number" },
  ],
};

const nonnegativeArrayFn: TypedFunction = {
  ...arrayFn,
  name: "nonnegative",
  requires: [{
    kind: "forall",
    var: "k",
    varTy: { kind: "nat" },
    body: {
      kind: "binop",
      op: "==>",
      left: {
        kind: "binop",
        op: "<",
        left: { kind: "var", name: "k", ty: { kind: "nat" } },
        right: {
          kind: "field",
          obj: { kind: "var", name: "values", ty: { kind: "array", elem: { kind: "int" } } },
          field: "length",
          ty: { kind: "nat" },
        },
        ty: { kind: "bool" },
      },
      right: {
        kind: "binop",
        op: ">=",
        left: {
          kind: "index",
          obj: { kind: "var", name: "values", ty: { kind: "array", elem: { kind: "int" } } },
          idx: { kind: "var", name: "k", ty: { kind: "nat" } },
          ty: { kind: "int" },
        },
        right: { kind: "num", value: 0, ty: { kind: "int" } },
        ty: { kind: "bool" },
      },
      ty: { kind: "bool" },
    },
    ty: { kind: "bool" },
  }],
};

const info: TypedInfo = {
  schema: 1,
  lemmascript: "0.6.0",
  file: "fixture.ts",
  backendDirective: "dafny",
  typeDecls: [],
  externs: [],
  constants: [],
  functions: [arrayFn],
  classes: [],
  dafny: { emittedNames: {} },
};

const options: AuditOptions = {
  cases: 20,
  seed: 17,
  timeoutMs: 10,
  verifyTimeoutMs: 1_000,
  entries: new Map(),
  saveCases: false,
};

const identity = {
  source: "/tmp/fixture.ts",
  sourceSha256: "1".repeat(64),
  runtime: "/tmp/fixture.ts",
  runtimeSha256: "1".repeat(64),
};

function client(request: JsonLineRequestClient["request"]): JsonLineRequestClient {
  return { request, close() {} };
}

function modelClient(): JsonLineRequestClient {
  return client(async message => ({
    status: "ok",
    modelDisplay: "0",
    modelValue: encode(0n),
    ...(message.runtimeResult === undefined ? {} : { equal: true, runtimeExact: "0" }),
  }));
}

test("differential audits cross bounded forall preconditions and reach representability checks", async () => {
  const runtime = client(async message => ({
    status: "ok",
    result: encode(0),
    before: message.args,
    after: message.args,
    console: [],
  }));
  const workers: AuditWorkers = { model: modelClient(), runtime, close() {} };
  const quantifiedInfo: TypedInfo = { ...info, functions: [nonnegativeArrayFn] };

  const report = await auditTarget(nonnegativeArrayFn, quantifiedInfo, identity, workers, {
    ...options,
    cases: 5,
  });

  assert.equal(report.conclusion, "issue", JSON.stringify(report, null, 2));
  assert.equal(report.issue?.category, "input-domain");
  assert.equal(report.cases, 5);
});

test("runtime timeout witnesses are not shrunk against a poisoned worker", async () => {
  let poisoned = false;
  let requestsAfterTimeout = 0;
  const runtime = client(async message => {
    const args = decode(message.args as Encoded) as unknown[][];
    if (poisoned) {
      requestsAfterTimeout++;
      throw new WorkerTimeoutError(options.timeoutMs);
    }
    if (Array.isArray(args[0]) && args[0].length === 1 && args[0][0] === 1) {
      poisoned = true;
      throw new WorkerTimeoutError(options.timeoutMs);
    }
    return {
      status: "ok",
      result: encode(0),
      before: message.args,
      after: message.args,
      console: [],
    };
  });
  const workers: AuditWorkers = { model: modelClient(), runtime, close() {} };

  const report = await auditTarget(arrayFn, info, identity, workers, options);

  assert.equal(report.issue?.category, "runtime-timeout");
  assert.deepEqual(decode(report.issue!.args), [[1n]]);
  assert.equal(requestsAfterTimeout, 0);
});

test("a missing runtime export is reported as a mapping failure", async () => {
  const runtimeTarget = "missing";
  const runtime = client(async () => ({
    status: "error",
    kind: "missing-export",
    error: `runtime module does not export function ${runtimeTarget}`,
  }));
  const workers: AuditWorkers = { model: modelClient(), runtime, close() {} };
  const mappedOptions: AuditOptions = {
    ...options,
    entries: new Map([[arrayFn.name, runtimeTarget]]),
  };

  const report = await auditTarget(arrayFn, info, identity, workers, mappedOptions);

  assert.equal(report.conclusion, "not-checked");
  assert.equal(report.reason, "runtime module does not export function missing");
  assert.doesNotMatch(report.reason!, /precondition/i);
  assert.match(report.nextStep!, /--entry f=<export>/);
});

test("number input collisions expose an actual projected result mismatch", async () => {
  const searchInfo: TypedInfo = { ...info, functions: [searchFn] };
  const model = client(async message => {
    const args = decode(message.args as Encoded) as [bigint[], bigint];
    const result = args[0][0] === args[1] ? 0n : -1n;
    const runtimeResult = "runtimeResult" in message
      ? decode(message.runtimeResult as Encoded)
      : undefined;
    return {
      status: "ok",
      modelDisplay: result.toString(),
      modelValue: encode(result),
      ...(runtimeResult === undefined ? {} : {
        equal: typeof runtimeResult === "number" && BigInt(runtimeResult) === result,
        runtimeExact: String(runtimeResult),
      }),
    };
  });
  const runtime = client(async message => {
    const args = decode(message.args as Encoded) as [number[], number];
    const result = args[0][0] === args[1] ? 0 : -1;
    return { status: "ok", result: encode(result), before: message.args, after: message.args, console: [] };
  });
  const workers: AuditWorkers = { model, runtime, close() {} };

  const report = await auditTarget(searchFn, searchInfo, identity, workers, { ...options, cases: 10 });

  assert.equal(report.issue?.category, "input-representation-mismatch");
  assert.deepEqual(decode(report.issue!.args), [[9_007_199_254_740_992n], 9_007_199_254_740_993n]);
  assert.deepEqual(report.issue?.runtimeArgDisplays, ["[9007199254740992]", "9007199254740992"]);
  assert.equal(report.issue?.modelResult, "-1");
  assert.equal(decode(report.issue!.runtimeResult!), 0);
  assert.deepEqual(report.issue?.representationLosses?.map(loss => loss.path), ["target"]);

  const replay = await auditTarget(searchFn, searchInfo, identity, workers, {
    ...options,
    checks: new Set(["contract", "differential"]),
    replay: {
      schema: "lemmascript-crosscheck.case/v2",
      id: report.issue!.id,
      source: identity.source,
      sourceSha256: identity.sourceSha256,
      runtime: identity.runtime,
      runtimeSha256: identity.runtimeSha256,
      target: searchFn.name,
      runtimeTarget: searchFn.name,
      category: "input-representation-mismatch",
      args: report.issue!.args,
      runtimeArgs: encode([[9_007_199_254_740_992], 9_007_199_254_740_992]),
    },
  });
  assert.equal(replay.issue?.category, "input-representation-mismatch");
  assert.equal(replay.issue?.id, report.issue?.id);
});

test("contract audits expose fractional inputs accepted by binary search but excluded by its proof", async () => {
  const contractSearch: TypedFunction = {
    ...searchFn,
    requires: [{
      kind: "call",
      fn: { kind: "var", name: "sorted", ty: { kind: "unknown" } },
      args: [{ kind: "var", name: "arr", ty: { kind: "array", elem: { kind: "int" } } }],
      ty: { kind: "bool" },
    }],
    ensures: [{
      kind: "binop",
      op: ">=",
      left: { kind: "var", name: "\\result", ty: { kind: "int" } },
      right: { kind: "num", value: -1, ty: { kind: "int" } },
      ty: { kind: "bool" },
    }],
  };
  const contractInfo: TypedInfo = { ...info, functions: [contractSearch] };
  const runtime = client(async message => {
    const args = decode(message.args as Encoded) as unknown[];
    if (message.target === "sorted") {
      const arr = args[0] as number[];
      const result = arr.every((value, index) => index === 0 || arr[index - 1]! <= value);
      return { status: "ok", result: encode(result), before: message.args, after: message.args, console: [] };
    }
    const [arr, target] = args as [number[], number];
    const result = arr.findIndex(value => value === target);
    return { status: "ok", result: encode(result), before: message.args, after: message.args, console: [] };
  });
  const model = client(async () => { throw new Error("contract audit must not execute the Dafny model"); });
  const workers: AuditWorkers = { model, runtime, close() {} };

  const report = await auditTarget(contractSearch, contractInfo, identity, workers, {
    ...options,
    cases: 20,
    checks: new Set(["contract"]),
  });

  assert.equal(report.issue?.category, "proof-domain-gap");
  assert.equal(report.issue?.runtimePath, "arr[0]");
  assert.deepEqual(decode(report.issue!.args), [[0.5], 0]);
  assert.equal(report.issue?.postconditionsSatisfied, true);

  const replay = await auditTarget(contractSearch, contractInfo, identity, workers, {
    ...options,
    replay: {
      schema: "lemmascript-crosscheck.case/v2",
      id: report.issue!.id,
      source: identity.source,
      sourceSha256: identity.sourceSha256,
      runtime: identity.runtime,
      runtimeSha256: identity.runtimeSha256,
      target: contractSearch.name,
      runtimeTarget: contractSearch.name,
      category: "proof-domain-gap",
      args: report.issue!.args,
    },
  });
  assert.equal(replay.issue?.category, "proof-domain-gap");
  assert.equal(replay.issue?.id, report.issue?.id);
});

test("contract audits report a false TypeScript postcondition directly", async () => {
  const target: TypedFunction = {
    ...arrayFn,
    name: "bad",
    params: [{ name: "x", ty: { kind: "int" }, tsType: "number" }],
    ensures: [{
      kind: "binop",
      op: ">=",
      left: { kind: "var", name: "\\result", ty: { kind: "int" } },
      right: { kind: "var", name: "x", ty: { kind: "int" } },
      ty: { kind: "bool" },
    }],
  };
  const targetInfo: TypedInfo = { ...info, functions: [target] };
  const runtime = client(async message => ({
    status: "ok",
    result: encode(-1),
    before: message.args,
    after: message.args,
    console: [],
  }));
  const workers: AuditWorkers = { model: modelClient(), runtime, close() {} };

  const report = await auditTarget(target, targetInfo, identity, workers, {
    ...options,
    checks: new Set(["contract"]),
  });

  assert.equal(report.issue?.category, "runtime-postcondition-violation");
  assert.equal(report.issue?.postconditionClause, 1);
  assert.deepEqual(decode(report.issue!.args), [0]);
});
