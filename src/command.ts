import { spawn } from "node:child_process";

export interface CommandSpec {
  command: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

export interface CommandResult {
  stdout: string;
  stderr: string;
}

export class CommandError extends Error {
  constructor(
    message: string,
    readonly spec: CommandSpec,
    readonly stdout: string,
    readonly stderr: string,
    readonly exitCode: number | null,
  ) {
    super(message);
    this.name = "CommandError";
  }
}

export async function runCommand(spec: CommandSpec): Promise<CommandResult> {
  return await new Promise((resolve, reject) => {
    const child = spawn(spec.command, spec.args, {
      cwd: spec.cwd,
      env: spec.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    const timer = spec.timeoutMs === undefined ? undefined : setTimeout(() => {
      child.kill("SIGKILL");
      reject(new CommandError(
        `${spec.command} timed out after ${spec.timeoutMs}ms`, spec, stdout, stderr, null,
      ));
    }, spec.timeoutMs);
    timer?.unref();
    child.on("error", error => {
      if (timer) clearTimeout(timer);
      reject(new CommandError(
        `could not start ${spec.command}: ${error.message}`, spec, stdout, stderr, null,
      ));
    });
    child.on("close", code => {
      if (timer) clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new CommandError(
        `${spec.command} exited with status ${code ?? "unknown"}`, spec, stdout, stderr, code,
      ));
    });
  });
}

export function conciseCommandError(error: unknown): string {
  if (!(error instanceof CommandError)) return error instanceof Error ? error.message : String(error);
  const detail = (error.stderr || error.stdout).trim();
  const finalLines = detail.split("\n").slice(-12).join("\n");
  return finalLines ? `${error.message}\n${finalLines}` : error.message;
}
