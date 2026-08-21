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

  const report = await auditTarget(arrayFn, info, "/tmp/fixture.ts", "hash", workers, options);

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

  const report = await auditTarget(arrayFn, info, "/tmp/fixture.ts", "hash", workers, mappedOptions);

  assert.equal(report.conclusion, "not-checked");
  assert.equal(report.reason, "runtime module does not export function missing");
  assert.doesNotMatch(report.reason!, /precondition/i);
  assert.match(report.nextStep!, /--entry f=<export>/);
});
