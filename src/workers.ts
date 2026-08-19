import { fileURLToPath } from "node:url";
import type { TypedInfo } from "./ir.js";
import { JsonLineClient } from "./json-line-client.js";
import { runtimePackageRoot } from "./dafny-build.js";

export interface AuditWorkers {
  model: JsonLineClient;
  runtime: JsonLineClient;
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
  const model = new JsonLineClient(process.execPath, [modelPath], cwd);
  const runtime = new JsonLineClient(process.execPath, ["--import", "tsx", runtimePath], cwd);
  try {
    const modelSetup = await model.request({
      type: "setup",
      modulePath: compiledModel,
      tables: { typeDecls: info.typeDecls, nameMap: info.dafny.emittedNames ?? {} },
    }, timeoutMs);
    if (modelSetup.status !== "ok") throw new Error(`model worker setup failed: ${String(modelSetup.error ?? modelSetup.status)}`);
    const runtimeSetup = await runtime.request({ type: "setup", modulePath: runtimeModule }, timeoutMs);
    if (runtimeSetup.status !== "ok") throw new Error(`runtime worker setup failed: ${String(runtimeSetup.error ?? runtimeSetup.status)}`);
    return { model, runtime, close: () => { model.close(); runtime.close(); } };
  } catch (error) {
    model.close();
    runtime.close();
    throw error;
  }
}
