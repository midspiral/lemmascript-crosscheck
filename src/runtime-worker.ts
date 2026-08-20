import { format } from "node:util";
import { pathToFileURL } from "node:url";
import { createInterface } from "node:readline";
import { decode, encode, type Encoded } from "./codec.js";

let runtimeModule: Record<string, unknown> | undefined;

function send(message: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

async function handle(message: Record<string, unknown>): Promise<void> {
  const id = message.id;
  try {
    if (message.type === "setup") {
      const modulePath = String(message.modulePath);
      runtimeModule = await import(`${pathToFileURL(modulePath).href}?lemmascript-crosscheck=${Date.now()}`) as Record<string, unknown>;
      send({ id, status: "ok" });
      return;
    }
    if (message.type !== "call" || !runtimeModule) throw new Error("runtime worker is not initialized");
    const target = String(message.target);
    const fn = runtimeModule[target];
    if (typeof fn !== "function") throw new Error(`runtime module does not export function ${target}`);
    const args = decode(message.args as Encoded) as unknown[];
    const before = encode(args);
    const output: string[] = [];
    const original = {
      log: console.log, info: console.info, debug: console.debug, warn: console.warn, error: console.error,
    };
    const capture = (...values: unknown[]) => { output.push(format(...values)); };
    console.log = console.info = console.debug = console.warn = console.error = capture;
    try {
      const result = (fn as (...values: unknown[]) => unknown)(...args);
      if (result && typeof (result as { then?: unknown }).then === "function") {
        send({ id, status: "unsupported", reason: "async target" });
        return;
      }
      send({ id, status: "ok", result: encode(result), before, after: encode(args), console: output });
    } catch (error) {
      send({
        id,
        status: "threw",
        error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
        before,
        after: encode(args),
        console: output,
      });
    } finally {
      Object.assign(console, original);
    }
  } catch (error) {
    send({ id, status: "error", error: error instanceof Error ? error.message : String(error) });
  }
}

const input = createInterface({ input: process.stdin });
input.on("line", line => {
  if (!line.trim()) return;
  void handle(JSON.parse(line) as Record<string, unknown>);
});
input.on("close", () => process.exit(0));
