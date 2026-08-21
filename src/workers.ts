import { fileURLToPath } from "node:url";
import type { TypedInfo } from "./ir.js";
import { RestartableJsonLineClient, type JsonLineRequestClient } from "./json-line-client.js";
import { runtimePackageRoot } from "./dafny-build.js";

export interface AuditWorkers {
  model: JsonLineRequestClient;
  runtime: JsonLineRequestClient;
  close(): void;
}

export async function startWorkers(
  compiledModel: string,
  runtimeModule: string,
  info: TypedInfo,
  timeoutMs: number,
): Promise<AuditWorkers> {
  const cwd = runtimePackageRoot();
  const modelPath = fileURLToPath(new URL("./model-worker.js", import.meta.url));
  const runtimePath = fileURLToPath(new URL("./runtime-worker.js", import.meta.url));
  const model = new RestartableJsonLineClient({
    command: process.execPath,
    args: [modelPath],
    cwd,
    setup: {
      type: "setup",
      modulePath: compiledModel,
      tables: { typeDecls: info.typeDecls, nameMap: info.dafny.emittedNames ?? {} },
    },
    setupTimeoutMs: timeoutMs,
    label: "model",
  });
  const runtime = new RestartableJsonLineClient({
    command: process.execPath,
    args: ["--import", "tsx", runtimePath],
    cwd,
    setup: { type: "setup", modulePath: runtimeModule },
    setupTimeoutMs: timeoutMs,
    label: "runtime",
  });
  try {
    await model.start();
    await runtime.start();
    return { model, runtime, close: () => { model.close(); runtime.close(); } };
  } catch (error) {
    model.close();
    runtime.close();
    throw error;
  }
}
