import { execFile } from "node:child_process";

export interface ExecResult {
  stdout: string;
  stderr: string;
}

export class CommandError extends Error {
  constructor(
    message: string,
    readonly command: string,
    readonly stdout: string,
    readonly stderr: string,
    readonly code: number | string | null,
  ) {
    super(message);
    this.name = "CommandError";
  }
}

/** Run a command without a shell and collect its output. */
export function run(
  command: string,
  args: string[],
  options: { timeoutMs?: number; env?: NodeJS.ProcessEnv; input?: string } = {},
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      command,
      args,
      {
        maxBuffer: 64 * 1024 * 1024,
        timeout: options.timeoutMs ?? 120_000,
        env: options.env ?? process.env,
        encoding: "utf8",
      },
      (error, stdout, stderr) => {
        if (error) {
          const printable = [command, ...args].join(" ");
          const detail = (stderr || stdout || error.message).trim();
          reject(
            new CommandError(
              `\`${printable}\` failed: ${detail}`,
              printable,
              stdout,
              stderr,
              (error as NodeJS.ErrnoException).code ?? null,
            ),
          );
          return;
        }
        resolve({ stdout, stderr });
      },
    );
    if (options.input !== undefined) {
      child.stdin?.end(options.input);
    }
  });
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
