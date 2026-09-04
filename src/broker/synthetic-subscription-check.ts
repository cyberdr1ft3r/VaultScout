import { z } from "zod";
import type { Browser } from "playwright";
import {
  CredentialBackendFailure,
  type CredentialBackend,
} from "./credential-backend.js";
import {
  type BrokerFailureCode,
  createCredentialBroker,
  type CredentialBroker,
  type TrustedSubscriptionCheckContext,
  type TrustedSubscriptionCheckExecutor,
  type TrustedSubscriptionCheckResult,
} from "./credential-broker.js";
import {
  type CredentialBinding,
  validateCredentialBinding,
} from "./credential-binding.js";
import {
  ControlledBrowserFailure,
  runControlledSyntheticBrowserCheck,
  type TrustedSyntheticTarget,
} from "./controlled-synthetic-browser.js";
import { SessionVault } from "../core/session-vault.js";
import {
  type OpaqueAccountReference,
  type RedactedFailureCode,
  type SubscriptionHistoryRepository,
} from "../persistence/subscription-history.js";

export interface BrokeredSyntheticCheckConfiguration {
  binding: unknown;
  backend: CredentialBackend;
  target: TrustedSyntheticTarget & {
    accountReference: string;
  };
  sessionVault: SessionVault;
  persistence: SubscriptionHistoryRepository;
  launchBrowser(): Promise<Browser>;
  now?: () => Date;
  checkTimeoutMs?: number;
}

export class BrokeredSyntheticCheckConfigurationError extends Error {
  readonly code = "INVALID_SYNTHETIC_CHECK_CONFIGURATION";

  constructor() {
    super("The synthetic subscription check configuration is invalid.");
    this.name = "BrokeredSyntheticCheckConfigurationError";
  }
}

const targetSchema = z
  .object({
    accountReference: z
      .string()
      .regex(/^acct_[a-f0-9]{32}$/u),
    providerId: z.string().regex(/^synthetic-[a-z0-9-]{1,54}$/u),
    providerName: z.string().min(1).max(100),
    trustedUsername: z
      .string()
      .min(1)
      .max(200)
      .refine((value) => !/[\u0000-\u001f\u007f]/u.test(value)),
    sessionLifetimeMs: z
      .number()
      .int()
      .min(60_000)
      .max(30 * 24 * 60 * 60 * 1_000),
    connector: z.object({
      id: z.string(),
      name: z.string(),
      extract: z.function(),
    }),
  })
  .strict();

function validateConfiguration(
  configuration: BrokeredSyntheticCheckConfiguration,
): {
  binding: CredentialBinding;
  target: TrustedSyntheticTarget;
  timeoutMs: number;
} {
  try {
    const binding = validateCredentialBinding(configuration.binding);
    const target = targetSchema.parse(configuration.target);
    const timeoutMs = configuration.checkTimeoutMs ?? 30_000;
    const now = configuration.now?.() ?? new Date();
    if (
      target.accountReference !== binding.accountReference ||
      target.providerId !== target.connector.id ||
      target.providerName !== target.connector.name ||
      !target.providerName.toLowerCase().includes("synthetic") ||
      configuration.backend.kind !== binding.backendKind ||
      !(configuration.sessionVault instanceof SessionVault) ||
      !configuration.persistence ||
      typeof configuration.persistence.recordSuccessfulCheck !== "function" ||
      typeof configuration.persistence.recordFailedCheck !== "function" ||
      typeof configuration.launchBrowser !== "function" ||
      !Number.isInteger(timeoutMs) ||
      timeoutMs < 100 ||
      timeoutMs > 120_000 ||
      !Number.isFinite(now.getTime())
    ) {
      throw new BrokeredSyntheticCheckConfigurationError();
    }

    return {
      binding,
      target: Object.freeze({
        providerId: target.providerId,
        providerName: target.providerName,
        trustedUsername: target.trustedUsername,
        sessionLifetimeMs: target.sessionLifetimeMs,
        connector: Object.freeze({
          id: target.connector.id,
          name: target.connector.name,
          extract: configuration.target.connector.extract,
        }),
      }),
      timeoutMs,
    };
  } catch {
    throw new BrokeredSyntheticCheckConfigurationError();
  }
}

function persistenceOutcome(error: unknown): {
  outcome: "failed" | "reauthentication_required";
  failureCode: RedactedFailureCode;
} {
  if (error instanceof CredentialBackendFailure) {
    switch (error.code) {
      case "BACKEND_LOCKED":
      case "AUTHORIZATION_DENIED":
      case "ITEM_NOT_FOUND":
      case "VAULT_NOT_FOUND":
      case "FIELD_NOT_FOUND":
      case "MALFORMED_OUTPUT":
      case "CONSUMER_FAILED":
        return {
          outcome: "reauthentication_required",
          failureCode: "AUTHENTICATION_REQUIRED",
        };
      case "ORIGIN_MISMATCH":
        return { outcome: "failed", failureCode: "INVALID_RESPONSE" };
      case "BACKEND_UNAVAILABLE":
      case "PROCESS_TIMEOUT":
      case "OUTPUT_LIMIT_EXCEEDED":
      case "PROCESS_FAILED":
        return { outcome: "failed", failureCode: "CONNECTOR_UNAVAILABLE" };
      case "CANCELLED":
        return { outcome: "failed", failureCode: "UNKNOWN_FAILURE" };
    }
  }

  if (error instanceof ControlledBrowserFailure) {
    switch (error.code) {
      case "SESSION_CORRUPT":
      case "ORIGIN_MISMATCH":
        return { outcome: "failed", failureCode: "INVALID_RESPONSE" };
      case "INTERACTIVE_REQUIRED":
      case "LOGIN_FAILED":
        return {
          outcome: "reauthentication_required",
          failureCode: "AUTHENTICATION_REQUIRED",
        };
      case "EXTRACTION_FAILED":
        return { outcome: "failed", failureCode: "EXTRACTION_FAILED" };
      case "CHECK_FAILED":
        return { outcome: "failed", failureCode: "UNKNOWN_FAILURE" };
    }
  }

  return { outcome: "failed", failureCode: "UNKNOWN_FAILURE" };
}

function publicFailure(error: unknown): BrokerFailureCode {
  if (error instanceof ControlledBrowserFailure) {
    return error.code;
  }
  return "CHECK_FAILED";
}

class SyntheticSubscriptionCheckExecutor
  implements TrustedSubscriptionCheckExecutor
{
  readonly #configuration: BrokeredSyntheticCheckConfiguration;
  readonly #target: TrustedSyntheticTarget;
  readonly #accountReference: OpaqueAccountReference;
  readonly #timeoutMs: number;

  constructor(
    configuration: BrokeredSyntheticCheckConfiguration,
    accountReference: OpaqueAccountReference,
    target: TrustedSyntheticTarget,
    timeoutMs: number,
  ) {
    this.#configuration = configuration;
    this.#accountReference = accountReference;
    this.#target = target;
    this.#timeoutMs = timeoutMs;
  }

  async #persistFailure(
    error: unknown,
    checkedAt: string,
  ): Promise<boolean> {
    const persisted = persistenceOutcome(error);
    try {
      await this.#configuration.persistence.recordFailedCheck({
        providerId: this.#target.providerId,
        providerName: this.#target.providerName,
        accountReference: this.#accountReference,
        checkedAt,
        outcome: persisted.outcome,
        failureCode: persisted.failureCode,
      });
      return true;
    } catch {
      return false;
    }
  }

  async execute(
    context: TrustedSubscriptionCheckContext,
  ): Promise<TrustedSubscriptionCheckResult> {
    const now = this.#configuration.now?.() ?? new Date();
    const checkedAt = now.toISOString();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.#timeoutMs);
    timeout.unref();

    try {
      const result = await runControlledSyntheticBrowserCheck({
        context,
        target: this.#target,
        sessionVault: this.#configuration.sessionVault,
        launchBrowser: this.#configuration.launchBrowser,
        now,
        signal: controller.signal,
      });
      if (controller.signal.aborted) {
        throw new ControlledBrowserFailure("CHECK_FAILED");
      }

      try {
        await this.#configuration.persistence.recordSuccessfulCheck({
          accountReference: this.#accountReference,
          subscription: result.subscription,
        });
      } catch {
        return { outcome: "failed", failureCode: "PERSISTENCE_FAILED" };
      }

      return {
        outcome: "completed",
        subscription: result.subscription,
      };
    } catch (error) {
      const persisted = await this.#persistFailure(error, checkedAt);
      if (!persisted) {
        return { outcome: "failed", failureCode: "PERSISTENCE_FAILED" };
      }
      if (error instanceof CredentialBackendFailure) {
        throw error;
      }
      return { outcome: "failed", failureCode: publicFailure(error) };
    } finally {
      clearTimeout(timeout);
      controller.abort();
    }
  }
}

export function createBrokeredSyntheticSubscriptionCheck(
  configuration: BrokeredSyntheticCheckConfiguration,
): CredentialBroker {
  const validated = validateConfiguration(configuration);
  const executor = new SyntheticSubscriptionCheckExecutor(
    configuration,
    validated.binding.accountReference,
    validated.target,
    validated.timeoutMs,
  );
  return createCredentialBroker({
    bindings: [validated.binding],
    backends: [configuration.backend],
    executor,
  });
}
