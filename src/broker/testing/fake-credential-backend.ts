import {
  CredentialBackendFailure,
  type CredentialBackend,
  type CredentialBackendFailureCode,
  type CredentialUseRequest,
  type EphemeralPasswordConsumer,
} from "../credential-backend.js";
import { validateCredentialBinding } from "../credential-binding.js";

export interface FakeCredentialEntry {
  itemReference: string;
  allowedOrigin: string;
  password: string;
}

export interface FakeCredentialBackendOptions {
  entries: readonly FakeCredentialEntry[];
  failWith?: CredentialBackendFailureCode;
}

export interface FakeCredentialBackendSnapshot {
  kind: "synthetic_fake";
  configuredEntries: number;
  useAttempts: number;
  completedUses: number;
}

export class FakeCredentialBackendConfigurationError extends Error {
  readonly code = "INVALID_FAKE_BACKEND_CONFIGURATION";

  constructor() {
    super("The synthetic credential backend configuration is invalid.");
    this.name = "FakeCredentialBackendConfigurationError";
  }
}

interface StoredFakeEntry {
  allowedOrigin: string;
  password: string;
}

const backendFailureCodes = new Set<CredentialBackendFailureCode>([
  "BACKEND_UNAVAILABLE",
  "AUTHORIZATION_DENIED",
  "ITEM_NOT_FOUND",
  "ORIGIN_MISMATCH",
]);

export class FakeCredentialBackend implements CredentialBackend {
  readonly kind = "synthetic_fake";
  readonly #entries: ReadonlyMap<string, StoredFakeEntry>;
  readonly #failWith: CredentialBackendFailureCode | undefined;
  #useAttempts = 0;
  #completedUses = 0;

  constructor(options: FakeCredentialBackendOptions) {
    try {
      if (
        options.failWith !== undefined &&
        !backendFailureCodes.has(options.failWith)
      ) {
        throw new FakeCredentialBackendConfigurationError();
      }
      const entries = new Map<string, StoredFakeEntry>();
      for (const entry of options.entries) {
        const binding = validateCredentialBinding({
          accountReference: "acct_00000000000000000000000000000000",
          backendKind: "synthetic_fake",
          itemReference: entry.itemReference,
          allowedOrigin: entry.allowedOrigin,
        });
        if (
          typeof entry.password !== "string" ||
          entry.password.length === 0 ||
          entries.has(binding.itemReference)
        ) {
          throw new FakeCredentialBackendConfigurationError();
        }
        entries.set(binding.itemReference, {
          allowedOrigin: binding.allowedOrigin,
          password: entry.password,
        });
      }
      this.#entries = entries;
      this.#failWith = options.failWith;
    } catch {
      throw new FakeCredentialBackendConfigurationError();
    }
  }

  async usePassword(
    request: Readonly<CredentialUseRequest>,
    consume: EphemeralPasswordConsumer,
  ): Promise<void> {
    this.#useAttempts += 1;
    if (this.#failWith) {
      throw new CredentialBackendFailure(this.#failWith);
    }

    const entry = this.#entries.get(request.itemReference);
    if (!entry) {
      throw new CredentialBackendFailure("ITEM_NOT_FOUND");
    }
    if (entry.allowedOrigin !== request.allowedOrigin) {
      throw new CredentialBackendFailure("ORIGIN_MISMATCH");
    }

    await consume(entry.password);
    this.#completedUses += 1;
  }

  safeSnapshot(): FakeCredentialBackendSnapshot {
    return Object.freeze({
      kind: this.kind,
      configuredEntries: this.#entries.size,
      useAttempts: this.#useAttempts,
      completedUses: this.#completedUses,
    });
  }

  toJSON(): FakeCredentialBackendSnapshot {
    return this.safeSnapshot();
  }
}
