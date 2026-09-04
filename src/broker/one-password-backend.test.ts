import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CredentialBackendFailure,
  type CredentialUseRequest,
} from "./credential-backend.js";
import type { CredentialItemReference } from "./credential-binding.js";
import {
  OnePasswordBackendConfigurationError,
  OnePasswordCredentialBackend,
  type OnePasswordBackendConfiguration,
  type OnePasswordProcessRunner,
} from "./one-password-backend.js";
import {
  OnePasswordProcessFailure,
  type OnePasswordProcessRequest,
  type OnePasswordProcessResult,
} from "./one-password-process-runner.js";

const SYNTHETIC_PASSWORD = [
  "VAULTSCOUT",
  "SYNTHETIC",
  "ONEPASSWORD",
  "TEST",
  "ONLY",
].join("_");
const ACCOUNT_ID = "a".repeat(26);
const VAULT_ID = "v".repeat(26);
const ITEM_ID = "i".repeat(26);
const ITEM_REFERENCE = `item_${ITEM_ID}` as CredentialItemReference;
const FIELD_ID = "password";
const ALLOWED_ORIGIN = "https://login.synthetic.invalid";
const temporaryDirectories: string[] = [];

class MockProcessRunner implements OnePasswordProcessRunner {
  readonly requests: OnePasswordProcessRequest[] = [];
  result: OnePasswordProcessResult = {
    exitCode: 0,
    stdout: Buffer.from(SYNTHETIC_PASSWORD),
    stderr: Buffer.alloc(0),
  };
  failure: unknown;

  async run(
    request: OnePasswordProcessRequest,
  ): Promise<OnePasswordProcessResult> {
    this.requests.push(request);
    if (this.failure) throw this.failure;
    return this.result;
  }
}

function configuration(
  overrides: Record<string, unknown> = {},
): OnePasswordBackendConfiguration {
  return {
    accountId: ACCOUNT_ID,
    vaultId: VAULT_ID,
    itemReference: ITEM_REFERENCE,
    passwordFieldId: FIELD_ID,
    allowedOrigin: ALLOWED_ORIGIN,
    ...overrides,
  } as OnePasswordBackendConfiguration;
}

function request(
  overrides: Partial<CredentialUseRequest> = {},
): CredentialUseRequest {
  return {
    itemReference: ITEM_REFERENCE,
    allowedOrigin: ALLOWED_ORIGIN,
    ...overrides,
  };
}

function backendFailureCode(error: unknown): string | undefined {
  return error instanceof CredentialBackendFailure ? error.code : undefined;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("OnePasswordCredentialBackend", () => {
  it("uses one fixed field only inside the callback scope", async () => {
    const runner = new MockProcessRunner();
    const backend = new OnePasswordCredentialBackend(configuration(), {
      runner,
      environment: {
        Path: "C:\\Program Files\\1Password CLI",
        SystemRoot: "C:\\Windows",
        OP_SERVICE_ACCOUNT_TOKEN: SYNTHETIC_PASSWORD,
        UNRELATED_VALUE: SYNTHETIC_PASSWORD,
      },
    });
    let callbackValue = "";

    await expect(
      backend.usePassword(request(), async (password) => {
        callbackValue = password;
      }),
    ).resolves.toBeUndefined();

    expect(callbackValue).toBe(SYNTHETIC_PASSWORD);
    expect(runner.requests).toHaveLength(1);
    expect(runner.requests[0]?.arguments).toEqual([
      "read",
      `op://${VAULT_ID}/${ITEM_ID}/${FIELD_ID}`,
      "--account",
      ACCOUNT_ID,
      "--no-newline",
      "--no-color",
    ]);
    expect(runner.requests[0]?.arguments.join(" ")).not.toContain(
      SYNTHETIC_PASSWORD,
    );
    expect(runner.requests[0]?.environment).toMatchObject({
      Path: "C:\\Program Files\\1Password CLI",
      SystemRoot: "C:\\Windows",
      OP_BIOMETRIC_UNLOCK_ENABLED: "true",
      NO_COLOR: "1",
    });
    expect(runner.requests[0]?.environment).not.toHaveProperty(
      "OP_SERVICE_ACCOUNT_TOKEN",
    );
    expect(JSON.stringify(runner.requests[0]?.environment)).not.toContain(
      SYNTHETIC_PASSWORD,
    );
    expect(runner.result.stdout.every((byte) => byte === 0)).toBe(true);
  });

  it("accepts documented mixed-case 26-character object IDs", async () => {
    const runner = new MockProcessRunner();
    const mixedAccountId = "Ac".repeat(13);
    const mixedVaultId = "V1".repeat(13);
    const mixedItemId = "It".repeat(13);
    const backend = new OnePasswordCredentialBackend(
      configuration({
        accountId: mixedAccountId,
        vaultId: mixedVaultId,
        itemReference: `item_${mixedItemId}`,
      }),
      { runner },
    );

    await backend.usePassword(
      request({
        itemReference: `item_${mixedItemId}` as CredentialItemReference,
      }),
      async () => undefined,
    );

    expect(runner.requests[0]?.arguments).toContain(
      `op://${mixedVaultId}/${mixedItemId}/${FIELD_ID}`,
    );
    expect(runner.requests[0]?.arguments).toContain(mixedAccountId);
  });

  it.each([
    ["EXECUTABLE_UNAVAILABLE", "BACKEND_UNAVAILABLE"],
    ["PROCESS_TIMEOUT", "PROCESS_TIMEOUT"],
    ["OUTPUT_LIMIT_EXCEEDED", "OUTPUT_LIMIT_EXCEEDED"],
    ["PROCESS_FAILED", "PROCESS_FAILED"],
    ["CANCELLED", "CANCELLED"],
  ] as const)("maps process failure %s to %s", async (
    processCode,
    backendCode,
  ) => {
    const runner = new MockProcessRunner();
    runner.failure = new OnePasswordProcessFailure(processCode);
    const backend = new OnePasswordCredentialBackend(configuration(), {
      runner,
    });

    const failure = await backend
      .usePassword(request(), async () => undefined)
      .catch((error: unknown) => error);
    expect(backendFailureCode(failure)).toBe(backendCode);
    expect(String(failure)).not.toContain(processCode);
  });

  it.each([
    ["1Password app is locked", "BACKEND_LOCKED"],
    ["authorization request denied", "AUTHORIZATION_DENIED"],
    ["the selected vault is not found", "VAULT_NOT_FOUND"],
    ["the selected item does not exist", "ITEM_NOT_FOUND"],
    ["the password field is not found", "FIELD_NOT_FOUND"],
    ["LostConnectionToApp", "BACKEND_UNAVAILABLE"],
    ["connectionreset", "BACKEND_UNAVAILABLE"],
    ["No accounts configured for use with 1Password CLI", "BACKEND_UNAVAILABLE"],
    ["unrecognized synthetic CLI failure", "PROCESS_FAILED"],
  ] as const)("classifies private CLI failure without exposing it", async (
    privateStderr,
    expectedCode,
  ) => {
    const runner = new MockProcessRunner();
    runner.result = {
      exitCode: 1,
      stdout: Buffer.alloc(0),
      stderr: Buffer.from(privateStderr),
    };
    const backend = new OnePasswordCredentialBackend(configuration(), {
      runner,
    });

    const failure = await backend
      .usePassword(request(), async () => undefined)
      .catch((error: unknown) => error);
    expect(backendFailureCode(failure)).toBe(expectedCode);
    expect(String(failure)).not.toContain(privateStderr);
    expect(runner.result.stderr.every((byte) => byte === 0)).toBe(true);
  });

  it.each([
    Buffer.alloc(0),
    Buffer.from("   "),
    Buffer.from("line-one\nline-two"),
    Buffer.from([0xff, 0xfe]),
    Buffer.from("value\0suffix"),
  ])("rejects malformed or empty credential output", async (stdout) => {
    const runner = new MockProcessRunner();
    runner.result = { exitCode: 0, stdout, stderr: Buffer.alloc(0) };
    const backend = new OnePasswordCredentialBackend(configuration(), {
      runner,
    });

    const failure = await backend
      .usePassword(request(), async () => undefined)
      .catch((error: unknown) => error);
    expect(backendFailureCode(failure)).toBe("MALFORMED_OUTPUT");
  });

  it("rejects oversized output even from a faulty process runner", async () => {
    const runner = new MockProcessRunner();
    runner.result = {
      exitCode: 0,
      stdout: Buffer.alloc(8_193, 65),
      stderr: Buffer.alloc(0),
    };
    const backend = new OnePasswordCredentialBackend(configuration(), {
      runner,
    });

    const failure = await backend
      .usePassword(request(), async () => undefined)
      .catch((error: unknown) => error);
    expect(backendFailureCode(failure)).toBe("OUTPUT_LIMIT_EXCEEDED");
  });

  it("rejects any stderr output on an otherwise successful process", async () => {
    const runner = new MockProcessRunner();
    runner.result = {
      exitCode: 0,
      stdout: Buffer.from(SYNTHETIC_PASSWORD),
      stderr: Buffer.from("synthetic warning"),
    };
    const backend = new OnePasswordCredentialBackend(configuration(), {
      runner,
    });

    const failure = await backend
      .usePassword(request(), async () => undefined)
      .catch((error: unknown) => error);
    expect(backendFailureCode(failure)).toBe("PROCESS_FAILED");
    expect(String(failure)).not.toContain("synthetic warning");
  });

  it("rejects non-zero exit without relying on stderr content", async () => {
    const runner = new MockProcessRunner();
    runner.result = {
      exitCode: 7,
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
    };
    const backend = new OnePasswordCredentialBackend(configuration(), {
      runner,
    });

    const failure = await backend
      .usePassword(request(), async () => undefined)
      .catch((error: unknown) => error);
    expect(backendFailureCode(failure)).toBe("PROCESS_FAILED");
  });

  it("wraps callback failures without exposing callback detail", async () => {
    const runner = new MockProcessRunner();
    const backend = new OnePasswordCredentialBackend(configuration(), {
      runner,
    });

    const failure = await backend
      .usePassword(request(), async () => {
        throw new Error(SYNTHETIC_PASSWORD);
      })
      .catch((error: unknown) => error);
    expect(backendFailureCode(failure)).toBe("CONSUMER_FAILED");
    expect(String(failure)).not.toContain(SYNTHETIC_PASSWORD);
  });

  it("fails before execution for mismatched item, origin, or cancellation", async () => {
    const runner = new MockProcessRunner();
    const backend = new OnePasswordCredentialBackend(configuration(), {
      runner,
    });
    const controller = new AbortController();
    controller.abort();

    const failures = await Promise.all([
      backend
        .usePassword(
          request({
            itemReference:
              `item_${"x".repeat(26)}` as CredentialItemReference,
          }),
          async () => undefined,
        )
        .catch((error: unknown) => error),
      backend
        .usePassword(
          request({ allowedOrigin: "https://other.synthetic.invalid" }),
          async () => undefined,
        )
        .catch((error: unknown) => error),
      backend
        .usePassword(
          request({ signal: controller.signal }),
          async () => undefined,
        )
        .catch((error: unknown) => error),
    ]);

    expect(failures.map(backendFailureCode)).toEqual([
      "ITEM_NOT_FOUND",
      "ORIGIN_MISMATCH",
      "CANCELLED",
    ]);
    expect(runner.requests).toHaveLength(0);
  });

  it.each([
    { accountId: "--help" },
    { vaultId: "--help" },
    { itemReference: "item_--help" },
    { passwordFieldId: "--reveal" },
    { allowedOrigin: "https://user@synthetic.invalid" },
    { timeoutMs: 0 },
    { maxOutputBytes: 1024 * 1024 },
  ])("rejects hostile or unsafe trusted identifier configuration", (override) => {
    expect(
      () => new OnePasswordCredentialBackend(configuration(override)),
    ).toThrowError(
      expect.objectContaining({
        code: "INVALID_ONE_PASSWORD_CONFIGURATION",
      }),
    );
  });

  it("serializes and snapshots no identifiers or credential material", async () => {
    const backend = new OnePasswordCredentialBackend(configuration(), {
      runner: new MockProcessRunner(),
    });

    expect(backend.safeSnapshot()).toEqual({ kind: "one_password" });
    const serialized = JSON.stringify(backend);
    expect(serialized).toBe('{"kind":"one_password"}');
    expect(serialized).not.toContain(SYNTHETIC_PASSWORD);
    expect(serialized).not.toContain(ACCOUNT_ID);
    expect(serialized).not.toContain(VAULT_ID);
    expect(serialized).not.toContain(ITEM_ID);

    const directory = await mkdtemp(
      join(tmpdir(), "vaultscout-one-password-test-"),
    );
    temporaryDirectories.push(directory);
    const path = join(directory, "safe-snapshot.json");
    await writeFile(path, serialized, { mode: 0o600 });
    expect(await readFile(path, "utf8")).toBe('{"kind":"one_password"}');
  });

  it("does not log credential output or process failures", async () => {
    const spies = [
      vi.spyOn(console, "log").mockImplementation(() => undefined),
      vi.spyOn(console, "warn").mockImplementation(() => undefined),
      vi.spyOn(console, "error").mockImplementation(() => undefined),
    ];
    const runner = new MockProcessRunner();
    const backend = new OnePasswordCredentialBackend(configuration(), {
      runner,
    });

    await backend.usePassword(request(), async () => undefined);
    expect(spies.flatMap((spy) => spy.mock.calls)).toEqual([]);
  });
});
