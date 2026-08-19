import { createRequire } from "node:module";
import { createInterface } from "node:readline";
import { decode, encode, type Encoded } from "./codec.js";
import { DafnyRuntime, MarshalError, type DafnyRuntimeModule, type MarshalTables } from "./dafny-runtime.js";
import type { Ty } from "./ir.js";

console.log = console.info = console.debug = (...args: unknown[]) => console.error(...args);

let model: DafnyRuntime | undefined;

function send(message: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function handle(message: Record<string, unknown>): void {
  const id = message.id;
  try {
    if (message.type === "setup") {
      const modulePath = String(message.modulePath);
      const runtime = createRequire(import.meta.url)(modulePath) as DafnyRuntimeModule;
      model = new DafnyRuntime(runtime, message.tables as unknown as MarshalTables);
      send({ id, status: "ok" });
      return;
    }
    if (message.type !== "call" || !model) throw new Error("model worker is not initialized");
    const args = decode(message.args as Encoded) as unknown[];
    const returnTy = message.returnTy as unknown as Ty;
    const result = model.invoke(String(message.target), message.paramTys as unknown as Ty[], args);
    let modelValue: Encoded | undefined;
    try { modelValue = encode(model.fromDafny(returnTy, result)); }
    catch (error) { if (!(error instanceof MarshalError)) throw error; }
    const response: Record<string, unknown> = {
      id,
      status: "ok",
      modelDisplay: model.display(result),
      ...(modelValue === undefined ? {} : { modelValue }),
    };
    if ("runtimeResult" in message) {
      const comparison = model.compareWithRuntime(returnTy, result, decode(message.runtimeResult as Encoded));
      response.equal = comparison.equal;
      response.runtimeExact = comparison.runtimeExact;
    }
    send(response);
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    const kind = error instanceof MarshalError ? "unsupported"
      : error instanceof RangeError && /stack|allocation|memory/i.test(text) ? "resource"
        : "execution";
    send({ id, status: "error", kind, error: text });
  }
}

const input = createInterface({ input: process.stdin });
input.on("line", line => {
  if (!line.trim()) return;
  try { handle(JSON.parse(line) as Record<string, unknown>); }
  catch (error) { send({ status: "error", kind: "protocol", error: error instanceof Error ? error.message : String(error) }); }
});
input.on("close", () => process.exit(0));
