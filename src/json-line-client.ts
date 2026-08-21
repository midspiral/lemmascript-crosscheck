import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";

export class WorkerTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`worker timed out after ${timeoutMs}ms`);
    this.name = "WorkerTimeoutError";
  }
}

export interface JsonLineRequestClient {
  request(message: Record<string, unknown>, timeoutMs: number): Promise<Record<string, unknown>>;
  close(): void;
}

export interface RestartableClientOptions {
  command: string;
  args: string[];
  cwd: string;
  setup: Record<string, unknown>;
  setupTimeoutMs: number;
  label: string;
  env?: NodeJS.ProcessEnv;
}

interface Pending {
  resolve: (value: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export class JsonLineClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private stderr = "";
  private closed = false;
  private failure: Error | undefined;

  constructor(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = process.env) {
    this.child = spawn(command, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", chunk => { this.stderr = (this.stderr + chunk).slice(-32_000); });
    const lines = createInterface({ input: this.child.stdout });
    lines.on("line", line => this.receive(line));
    this.child.on("error", error => this.failAll(error));
    this.child.on("exit", code => {
      if (!this.closed) this.failAll(new Error(`worker exited with status ${code ?? "unknown"}${this.stderr ? `\n${this.stderr.trim()}` : ""}`));
    });
  }

  async request(message: Record<string, unknown>, timeoutMs: number): Promise<Record<string, unknown>> {
    if (this.closed) throw new Error("worker is closed");
    if (this.failure) throw this.failure;
    const id = this.nextId++;
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.child.kill("SIGKILL");
        reject(new WorkerTimeoutError(timeoutMs));
      }, timeoutMs);
      timer.unref();
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(`${JSON.stringify({ ...message, id })}\n`);
    });
  }

  close(): void {
    this.closed = true;
    this.child.kill("SIGTERM");
    this.failAll(new Error("worker closed"));
  }

  private receive(line: string): void {
    let response: Record<string, unknown>;
    try {
      response = JSON.parse(line) as Record<string, unknown>;
    } catch {
      this.failAll(new Error(`worker emitted non-JSON output: ${line}${this.stderr ? `\n${this.stderr.trim()}` : ""}`));
      this.child.kill("SIGKILL");
      return;
    }
    const id = response.id;
    if (typeof id !== "number") return;
    const pending = this.pending.get(id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(id);
    pending.resolve(response);
  }

  private failAll(error: Error): void {
    this.failure ??= error;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

/** Restarts a worker and repeats its setup after any process-level request failure. */
export class RestartableJsonLineClient implements JsonLineRequestClient {
  private client: JsonLineClient | undefined;
  private closed = false;

  constructor(private readonly options: RestartableClientOptions) {}

  async start(): Promise<void> {
    if (this.closed) throw new Error(`${this.options.label} worker is closed`);
    await this.ensureStarted();
  }

  async request(message: Record<string, unknown>, timeoutMs: number): Promise<Record<string, unknown>> {
    if (this.closed) throw new Error(`${this.options.label} worker is closed`);
    await this.ensureStarted();
    try {
      return await this.client!.request(message, timeoutMs);
    } catch (error) {
      this.discardClient();
      throw error;
    }
  }

  close(): void {
    this.closed = true;
    this.discardClient();
  }

  private async ensureStarted(): Promise<void> {
    if (this.client) return;
    const client = new JsonLineClient(
      this.options.command,
      this.options.args,
      this.options.cwd,
      this.options.env ?? process.env,
    );
    try {
      const setup = await client.request(this.options.setup, this.options.setupTimeoutMs);
      if (setup.status !== "ok") {
        throw new Error(`${this.options.label} worker setup failed: ${String(setup.error ?? setup.status)}`);
      }
      this.client = client;
    } catch (error) {
      client.close();
      throw error;
    }
  }

  private discardClient(): void {
    this.client?.close();
    this.client = undefined;
  }
}
