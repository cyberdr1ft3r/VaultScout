import { TextDecoder } from "node:util";
import { z } from "zod";
import {
  CredentialBackendFailure,
  type CredentialBackend,
  type CredentialUseRequest,
  type EphemeralPasswordConsumer,
} from "./credential-backend.js";
import {
  type CredentialItemReference,
  validateCredentialBinding,
} from "./credential-binding.js";
import {
  createOnePasswordEnvironment,
  OnePasswordProcessFailure,
  SpawnOnePasswordProcessRunner,
  type OnePasswordProcessRequest,
  type OnePasswordProcessResult,
} from "./one-password-process-runner.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT_BYTES = 8 * 1024;
const onePasswordIdSchema = z.string().regex(/^[a-z0-9]{26}$/u);
const fieldIdSchema = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/u);
const onePasswordBackendSchema = z
  .object({
    accountId: onePasswordIdSchema,
    vaultId: onePasswordIdSchema,
    itemReference: z.string(),
    passwordFieldId: fieldIdSchema,
    allowedOrigin: z.string(),
    timeoutMs: z
      .number()
      .int()
      .min(1_000)
      .max(120_000)
      .default(DEFAULT_TIMEOUT_MS),
    maxOutputBytes: z
      .number()
      .int()
      .min(128)
      .max(32 * 1024)
      .default(DEFAULT_MAX_OUTPUT_BYTES),
  })
  .strict();

export interface OnePasswordBackendConfiguration {
  accountId: string;
  vaultId: string;
  itemReference: string;
  passwordFieldId: string;
  allowedOrigin: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

export interface OnePasswordProcessRunner {
  run(request: OnePasswordProcessRequest): Promise<OnePasswordProcessResult>;
}

export interface OnePasswordBackendDependencies {
  runner?: OnePasswordProcessRunner;
  environment?: NodeJS.ProcessEnv;
}

export interface OnePasswordBackendSnapshot {
  kind: "one_password";
}

export class OnePasswordBackendConfigurationError extends Error {
  readonly code = "INVALID_ONE_PASSWORD_CONFIGURATION";

  constructor() {
    super("The 1Password backend configuration is invalid.");
    this.name = "OnePasswordBackendConfigurationError";
  }
}

interface ValidatedConfiguration {
  accountId: string;
  vaultId: string;
  itemReference: CredentialItemReference;
  itemId: string;
  passwordFieldId: string;
  allowedOrigin: string;
  timeoutMs: number;
  maxOutputBytes: number;
}

function validateConfiguration(
  value: OnePasswordBackendConfiguration,
): ValidatedConfiguration {
  try {
    const parsed = onePasswordBackendSchema.safeParse(value);
    if (!parsed.success) {
      throw new OnePasswordBackendConfigurationError();
    }
    const binding = validateCredentialBinding({
      accountReference: "acct_00000000000000000000000000000000",
      backendKind: "one_password",
      itemReference: parsed.data.itemReference,
      allowedOrigin: parsed.data.allowedOrigin,
    });
    const itemId = binding.itemReference.slice("item_".length);
    if (!onePasswordIdSchema.safeParse(itemId).success) {
      throw new OnePasswordBackendConfigurationError();
    }

    return Object.freeze({
      accountId: parsed.data.accountId,
      vaultId: parsed.data.vaultId,
      itemReference: binding.itemReference,
      itemId,
      passwordFieldId: parsed.data.passwordFieldId,
      allowedOrigin: binding.allowedOrigin,
      timeoutMs: parsed.data.timeoutMs,
      maxOutputBytes: parsed.data.maxOutputBytes,
    });
  } catch {
    throw new OnePasswordBackendConfigurationError();
  }
}

function mapProcessFailure(
  error: OnePasswordProcessFailure,
): CredentialBackendFailure {
  switch (error.code) {
    case "EXECUTABLE_UNAVAILABLE":
      return new CredentialBackendFailure("BACKEND_UNAVAILABLE");
    case "PROCESS_TIMEOUT":
      return new CredentialBackendFailure("PROCESS_TIMEOUT");
    case "OUTPUT_LIMIT_EXCEEDED":
      return new CredentialBackendFailure("OUTPUT_LIMIT_EXCEEDED");
    case "CANCELLED":
      return new CredentialBackendFailure("CANCELLED");
    case "PROCESS_FAILED":
      return new CredentialBackendFailure("PROCESS_FAILED");
  }
}

function decodeUtf8(value: Buffer): string | undefined {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(value);
  } catch {
    return undefined;
  }
}

function classifyCliFailure(stderr: Buffer): CredentialBackendFailure {
  const decoded = decodeUtf8(stderr);
  if (decoded === undefined) {
    return new CredentialBackendFailure("PROCESS_FAILED");
  }
  const privateMessage = decoded.toLowerCase();

  if (
    /(?:field|section).*(?:not found|does not exist|isn't|is not)/u.test(
      privateMessage,
    ) ||
    /(?:not found|does not exist|isn't|is not).*(?:field|section)/u.test(
      privateMessage,
    )
  ) {
    return new CredentialBackendFailure("FIELD_NOT_FOUND");
  }
  if (
    /item.*(?:not found|does not exist|isn't|is not)/u.test(privateMessage) ||
    /(?:not found|does not exist|isn't|is not).*item/u.test(privateMessage)
  ) {
    return new CredentialBackendFailure("ITEM_NOT_FOUND");
  }
  if (
    /vault.*(?:not found|does not exist|isn't|is not)/u.test(privateMessage) ||
    /(?:not found|does not exist|isn't|is not).*vault/u.test(privateMessage)
  ) {
    return new CredentialBackendFailure("VAULT_NOT_FOUND");
  }
  if (
    /(?:authorization|request).*(?:denied|declined|cancelled|canceled)/u.test(
      privateMessage,
    ) ||
    /(?:denied|declined|cancelled|canceled).*(?:authorization|request)/u.test(
      privateMessage,
    )
  ) {
    return new CredentialBackendFailure("AUTHORIZATION_DENIED");
  }
  if (
    /(?:app|account|1password).*(?:locked|not signed in)/u.test(
      privateMessage,
    ) ||
    /(?:locked|not signed in).*(?:app|account|1password)/u.test(privateMessage)
  ) {
    return new CredentialBackendFailure("BACKEND_LOCKED");
  }
  if (
    /lostconnectiontoapp|connectionreset|no accounts configured|could(?: not|n't) connect|failed to connect/u.test(
      privateMessage,
    )
  ) {
    return new CredentialBackendFailure("BACKEND_UNAVAILABLE");
  }
  return new CredentialBackendFailure("PROCESS_FAILED");
}

export class OnePasswordCredentialBackend implements CredentialBackend {
  readonly kind = "one_password";
  readonly #configuration: ValidatedConfiguration;
  readonly #runner: OnePasswordProcessRunner;
  readonly #environment: Readonly<Record<string, string>>;

  constructor(
    configuration: OnePasswordBackendConfiguration,
    dependencies: OnePasswordBackendDependencies = {},
  ) {
    this.#configuration = validateConfiguration(configuration);
    this.#runner =
      dependencies.runner ?? new SpawnOnePasswordProcessRunner();
    this.#environment = createOnePasswordEnvironment(
      dependencies.environment,
    );
  }

  async usePassword(
    request: Readonly<CredentialUseRequest>,
    consume: EphemeralPasswordConsumer,
  ): Promise<void> {
    if (request.itemReference !== this.#configuration.itemReference) {
      throw new CredentialBackendFailure("ITEM_NOT_FOUND");
    }
    if (request.allowedOrigin !== this.#configuration.allowedOrigin) {
      throw new CredentialBackendFailure("ORIGIN_MISMATCH");
    }
    if (request.signal?.aborted) {
      throw new CredentialBackendFailure("CANCELLED");
    }

    const secretReference = `op://${this.#configuration.vaultId}/${this.#configuration.itemId}/${this.#configuration.passwordFieldId}`;
    let result: OnePasswordProcessResult | undefined;
    let password: string | undefined;

    try {
      try {
        result = await this.#runner.run({
          arguments: Object.freeze([
            "read",
            secretReference,
            "--account",
            this.#configuration.accountId,
            "--no-newline",
            "--no-color",
          ]),
          environment: this.#environment,
          timeoutMs: this.#configuration.timeoutMs,
          maxStdoutBytes: this.#configuration.maxOutputBytes,
          maxStderrBytes: this.#configuration.maxOutputBytes,
          ...(request.signal ? { signal: request.signal } : {}),
        });
      } catch (error) {
        if (error instanceof OnePasswordProcessFailure) {
          throw mapProcessFailure(error);
        }
        throw new CredentialBackendFailure("PROCESS_FAILED");
      }

      if (
        result.stdout.length > this.#configuration.maxOutputBytes ||
        result.stderr.length > this.#configuration.maxOutputBytes
      ) {
        throw new CredentialBackendFailure("OUTPUT_LIMIT_EXCEEDED");
      }
      if (!Number.isInteger(result.exitCode) || result.exitCode < 0) {
        throw new CredentialBackendFailure("PROCESS_FAILED");
      }
      if (result.exitCode !== 0) {
        throw classifyCliFailure(result.stderr);
      }
      if (result.stderr.length !== 0) {
        throw new CredentialBackendFailure("PROCESS_FAILED");
      }

      password = decodeUtf8(result.stdout);
      if (
        password === undefined ||
        password.length === 0 ||
        password.trim().length === 0 ||
        password.includes("\0") ||
        password.includes("\r") ||
        password.includes("\n")
      ) {
        throw new CredentialBackendFailure("MALFORMED_OUTPUT");
      }

      try {
        await consume(password);
      } catch {
        throw new CredentialBackendFailure("CONSUMER_FAILED");
      }
    } finally {
      result?.stdout.fill(0);
      result?.stderr.fill(0);
      password = undefined;
      result = undefined;
    }
  }

  safeSnapshot(): OnePasswordBackendSnapshot {
    return Object.freeze({ kind: this.kind });
  }

  toJSON(): OnePasswordBackendSnapshot {
    return this.safeSnapshot();
  }
}
