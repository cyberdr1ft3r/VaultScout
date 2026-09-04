import { spawn } from "node:child_process";
import type { Readable } from "node:stream";

export type OnePasswordProcessFailureCode =
  | "EXECUTABLE_UNAVAILABLE"
  | "PROCESS_TIMEOUT"
  | "OUTPUT_LIMIT_EXCEEDED"
  | "PROCESS_FAILED"
  | "CANCELLED";

export class OnePasswordProcessFailure extends Error {
  constructor(readonly code: OnePasswordProcessFailureCode) {
    super("The 1Password process failed.");
    this.name = "OnePasswordProcessFailure";
  }
}

export interface OnePasswordProcessRequest {
  arguments: readonly string[];
  environment: Readonly<Record<string, string>>;
  timeoutMs: number;
  maxStdoutBytes: number;
  maxStderrBytes: number;
  signal?: AbortSignal;
}

export interface OnePasswordProcessResult {
  exitCode: number;
  stdout: Buffer;
  stderr: Buffer;
}

interface SpawnedProcess {
  stdout: Readable;
  stderr: Readable;
  once(event: "error", listener: (error: NodeJS.ErrnoException) => void): this;
  once(
    event: "close",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): this;
  kill(signal?: NodeJS.Signals): boolean;
}

export type OnePasswordSpawn = (
  executable: string,
  arguments_: readonly string[],
  options: {
    env: Readonly<Record<string, string>>;
    shell: false;
    stdio: ["ignore", "pipe", "pipe"];
    windowsHide: true;
  },
) => SpawnedProcess;

const defaultSpawn: OnePasswordSpawn = (
  executable,
  arguments_,
  options,
) =>
  spawn(executable, [...arguments_], options) as unknown as SpawnedProcess;

const inheritedEnvironmentNames = new Set([
  "APPDATA",
  "HOME",
  "LOCALAPPDATA",
  "PATH",
  "SYSTEMROOT",
  "TEMP",
  "TMP",
  "USERPROFILE",
  "WINDIR",
]);

export function createOnePasswordEnvironment(
  source: NodeJS.ProcessEnv = process.env,
): Readonly<Record<string, string>> {
  const environment: Record<string, string> = {};
  for (const [name, value] of Object.entries(source)) {
    const normalizedName = name.toUpperCase();
    if (
      value !== undefined &&
      inheritedEnvironmentNames.has(normalizedName) &&
      normalizedName !== "OP_SERVICE_ACCOUNT_TOKEN"
    ) {
      environment[name] = value;
    }
  }

  environment.LANG = "C";
  environment.LC_ALL = "C";
  environment.NO_COLOR = "1";
  environment.OP_BIOMETRIC_UNLOCK_ENABLED = "true";
  return Object.freeze(environment);
}

export class SpawnOnePasswordProcessRunner {
  readonly #spawn: OnePasswordSpawn;

  constructor(spawnProcess: OnePasswordSpawn = defaultSpawn) {
    this.#spawn = spawnProcess;
  }

  async run(
    request: OnePasswordProcessRequest,
  ): Promise<OnePasswordProcessResult> {
    if (request.signal?.aborted) {
      throw new OnePasswordProcessFailure("CANCELLED");
    }

    return new Promise<OnePasswordProcessResult>((resolve, reject) => {
      let child: SpawnedProcess;
      try {
        child = this.#spawn("op", request.arguments, {
          env: request.environment,
          shell: false,
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
        });
      } catch (error) {
        const code =
          error instanceof Error &&
          "code" in error &&
          (error as NodeJS.ErrnoException).code === "ENOENT"
            ? "EXECUTABLE_UNAVAILABLE"
            : "PROCESS_FAILED";
        reject(new OnePasswordProcessFailure(code));
        return;
      }

      let settled = false;
      let terminationCode: OnePasswordProcessFailureCode | undefined;
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let stdoutChunks: Buffer[] = [];
      let stderrChunks: Buffer[] = [];
      let forceKillTimer: NodeJS.Timeout | undefined;

      const clearCapturedOutput = (): void => {
        for (const chunk of [...stdoutChunks, ...stderrChunks]) {
          chunk.fill(0);
        }
        stdoutChunks = [];
        stderrChunks = [];
      };
      const cleanup = (): void => {
        clearTimeout(timeout);
        if (forceKillTimer) {
          clearTimeout(forceKillTimer);
        }
        request.signal?.removeEventListener("abort", abort);
      };
      const fail = (code: OnePasswordProcessFailureCode): void => {
        if (settled) return;
        settled = true;
        cleanup();
        clearCapturedOutput();
        reject(new OnePasswordProcessFailure(code));
      };
      const terminate = (code: OnePasswordProcessFailureCode): void => {
        if (terminationCode || settled) return;
        terminationCode = code;
        clearCapturedOutput();
        child.kill("SIGTERM");
        forceKillTimer = setTimeout(() => {
          child.kill("SIGKILL");
          fail(code);
        }, 500);
        forceKillTimer.unref();
      };
      const abort = (): void => terminate("CANCELLED");
      const timeout = setTimeout(
        () => terminate("PROCESS_TIMEOUT"),
        request.timeoutMs,
      );
      timeout.unref();

      request.signal?.addEventListener("abort", abort, { once: true });

      child.stdout.on("data", (chunk: Buffer) => {
        if (settled || terminationCode) return;
        stdoutBytes += chunk.length;
        if (stdoutBytes > request.maxStdoutBytes) {
          terminate("OUTPUT_LIMIT_EXCEEDED");
          return;
        }
        stdoutChunks.push(chunk);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        if (settled || terminationCode) return;
        stderrBytes += chunk.length;
        if (stderrBytes > request.maxStderrBytes) {
          terminate("OUTPUT_LIMIT_EXCEEDED");
          return;
        }
        stderrChunks.push(chunk);
      });

      child.once("error", (error) => {
        fail(
          error.code === "ENOENT"
            ? "EXECUTABLE_UNAVAILABLE"
            : "PROCESS_FAILED",
        );
      });
      child.once("close", (code, signal) => {
        if (settled) return;
        if (terminationCode) {
          fail(terminationCode);
          return;
        }
        if (code === null || signal !== null) {
          fail("PROCESS_FAILED");
          return;
        }

        settled = true;
        cleanup();
        const stdout = Buffer.concat(stdoutChunks, stdoutBytes);
        const stderr = Buffer.concat(stderrChunks, stderrBytes);
        clearCapturedOutput();
        resolve({ exitCode: code, stdout, stderr });
      });
    });
  }
}
