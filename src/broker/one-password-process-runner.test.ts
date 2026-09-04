import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  createOnePasswordEnvironment,
  OnePasswordProcessFailure,
  type OnePasswordProcessRequest,
  type OnePasswordSpawn,
  SpawnOnePasswordProcessRunner,
} from "./one-password-process-runner.js";

class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly killSignals: NodeJS.Signals[] = [];
  closeWhenKilled = true;

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.killSignals.push(signal);
    if (this.closeWhenKilled) {
      queueMicrotask(() => this.emit("close", null, signal));
    }
    return true;
  }
}

function request(
  overrides: Partial<OnePasswordProcessRequest> = {},
): OnePasswordProcessRequest {
  return {
    arguments: ["read", "op://v/i/password"],
    environment: { PATH: "synthetic-path" },
    timeoutMs: 1_000,
    maxStdoutBytes: 64,
    maxStderrBytes: 64,
    ...overrides,
  };
}

describe("SpawnOnePasswordProcessRunner", () => {
  it("spawns op with an argument array, no shell, and minimal stdio", async () => {
    const child = new FakeChild();
    let invocation:
      | {
          executable: string;
          arguments_: readonly string[];
          options: Parameters<OnePasswordSpawn>[2];
        }
      | undefined;
    const spawn: OnePasswordSpawn = (executable, arguments_, options) => {
      invocation = { executable, arguments_, options };
      return child;
    };
    const runner = new SpawnOnePasswordProcessRunner(spawn);
    const outputChunk = Buffer.from("synthetic-output");
    const resultPromise = runner.run(request());

    child.stdout.write(outputChunk);
    child.emit("close", 0, null);
    const result = await resultPromise;

    expect(invocation).toEqual({
      executable: "op",
      arguments_: ["read", "op://v/i/password"],
      options: {
        env: { PATH: "synthetic-path" },
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      },
    });
    expect(result.stdout.toString("utf8")).toBe("synthetic-output");
    expect(result.stderr).toHaveLength(0);
    expect(outputChunk.every((byte) => byte === 0)).toBe(true);
  });

  it("maps an unavailable executable without exposing its path", async () => {
    const spawn: OnePasswordSpawn = () => {
      throw Object.assign(new Error("private executable path"), {
        code: "ENOENT",
      });
    };
    const runner = new SpawnOnePasswordProcessRunner(spawn);

    const failure = await runner
      .run(request())
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(OnePasswordProcessFailure);
    expect(failure).toMatchObject({ code: "EXECUTABLE_UNAVAILABLE" });
    expect(String(failure)).not.toContain("private executable path");
  });

  it("terminates the child when execution times out", async () => {
    const child = new FakeChild();
    const runner = new SpawnOnePasswordProcessRunner(() => child);

    const failure = await runner
      .run(request({ timeoutMs: 10 }))
      .catch((error: unknown) => error);

    expect(failure).toMatchObject({ code: "PROCESS_TIMEOUT" });
    expect(child.killSignals).toContain("SIGTERM");
  });

  it("terminates the child when the trusted request is cancelled", async () => {
    const child = new FakeChild();
    const runner = new SpawnOnePasswordProcessRunner(() => child);
    const controller = new AbortController();
    const result = runner
      .run(request({ signal: controller.signal }))
      .catch((error: unknown) => error);

    controller.abort();
    const failure = await result;

    expect(failure).toMatchObject({ code: "CANCELLED" });
    expect(child.killSignals).toContain("SIGTERM");
  });

  it("does not spawn an already-cancelled request", async () => {
    let spawned = false;
    const runner = new SpawnOnePasswordProcessRunner(() => {
      spawned = true;
      return new FakeChild();
    });
    const controller = new AbortController();
    controller.abort();

    await expect(
      runner.run(request({ signal: controller.signal })),
    ).rejects.toMatchObject({ code: "CANCELLED" });
    expect(spawned).toBe(false);
  });

  it.each(["stdout", "stderr"] as const)(
    "terminates the child when %s exceeds its limit",
    async (stream) => {
      const child = new FakeChild();
      const runner = new SpawnOnePasswordProcessRunner(() => child);
      const result = runner
        .run(
          request({
            maxStdoutBytes: 8,
            maxStderrBytes: 8,
          }),
        )
        .catch((error: unknown) => error);

      child[stream].write(Buffer.alloc(9, 65));
      const failure = await result;

      expect(failure).toMatchObject({ code: "OUTPUT_LIMIT_EXCEEDED" });
      expect(child.killSignals).toContain("SIGTERM");
    },
  );

  it("fails closed on a child-process error", async () => {
    const child = new FakeChild();
    const runner = new SpawnOnePasswordProcessRunner(() => child);
    const result = runner.run(request()).catch((error: unknown) => error);

    child.emit("error", Object.assign(new Error("private process detail"), {
      code: "EACCES",
    }));
    const failure = await result;

    expect(failure).toMatchObject({ code: "PROCESS_FAILED" });
    expect(String(failure)).not.toContain("private process detail");
  });

  it.each([
    [null, null],
    [null, "SIGKILL"],
  ] as const)("fails closed on an unexpected process exit", async (
    code,
    signal,
  ) => {
    const child = new FakeChild();
    const runner = new SpawnOnePasswordProcessRunner(() => child);
    const result = runner.run(request()).catch((error: unknown) => error);

    child.emit("close", code, signal);
    await expect(result).resolves.toMatchObject({ code: "PROCESS_FAILED" });
  });
});

describe("createOnePasswordEnvironment", () => {
  it("allowlists local integration variables and excludes all supplied secrets", () => {
    const environment = createOnePasswordEnvironment({
      Path: "synthetic-path",
      SystemRoot: "synthetic-root",
      USERPROFILE: "synthetic-profile",
      OP_SERVICE_ACCOUNT_TOKEN: "synthetic-service-value",
      OP_SESSION_SYNTHETIC: "synthetic-session-value",
      RANDOM_CREDENTIAL: "synthetic-random-value",
    });

    expect(environment).toMatchObject({
      Path: "synthetic-path",
      SystemRoot: "synthetic-root",
      USERPROFILE: "synthetic-profile",
      OP_BIOMETRIC_UNLOCK_ENABLED: "true",
      NO_COLOR: "1",
    });
    expect(environment).not.toHaveProperty("OP_SERVICE_ACCOUNT_TOKEN");
    expect(environment).not.toHaveProperty("OP_SESSION_SYNTHETIC");
    expect(environment).not.toHaveProperty("RANDOM_CREDENTIAL");
    expect(JSON.stringify(environment)).not.toContain(
      "synthetic-service-value",
    );
  });
});
