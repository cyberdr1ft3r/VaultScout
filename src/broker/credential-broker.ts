import { z } from "zod";
import type { OpaqueAccountReference } from "../persistence/subscription-history.js";
import type { Subscription } from "../core/subscription.js";
import type {
  CredentialBackend,
  EphemeralPasswordConsumer,
} from "./credential-backend.js";
import { CredentialBackendFailure } from "./credential-backend.js";
import {
  type CredentialBinding,
  type CredentialBackendKind,
  originMatchesBinding,
  validateCredentialBindings,
} from "./credential-binding.js";

export const CHECK_SUBSCRIPTION_CAPABILITY = "check_subscription" as const;

export type BrokerFailureCode =
  | "REQUEST_DENIED"
  | "BINDING_NOT_FOUND"
  | "BACKEND_UNAVAILABLE"
  | "AUTHORIZATION_DENIED"
  | "CREDENTIAL_UNAVAILABLE"
  | "ORIGIN_MISMATCH"
  | "REQUEST_CANCELLED"
  | "SESSION_MISSING"
  | "SESSION_EXPIRED"
  | "SESSION_CORRUPT"
  | "REAUTHENTICATION_REQUIRED"
  | "INTERACTIVE_REQUIRED"
  | "LOGIN_FAILED"
  | "EXTRACTION_FAILED"
  | "PERSISTENCE_FAILED"
  | "CHECK_FAILED";

export interface CheckSubscriptionRequest {
  accountReference: OpaqueAccountReference;
  capability: typeof CHECK_SUBSCRIPTION_CAPABILITY;
}

export type CheckSubscriptionResponse =
  | {
      outcome: "completed";
      accountReference: OpaqueAccountReference;
      capability: typeof CHECK_SUBSCRIPTION_CAPABILITY;
      subscription?: Subscription;
    }
  | { outcome: "failed"; failureCode: BrokerFailureCode };

/**
 * The entire agent-facing surface. No origin, credential item, backend, or
 * secret value can be supplied in a request or returned in a response.
 */
export interface CredentialBroker {
  checkSubscription(
    request: CheckSubscriptionRequest,
  ): Promise<CheckSubscriptionResponse>;
}

export interface TrustedSubscriptionCheckContext {
  readonly accountReference: OpaqueAccountReference;
  readonly allowedOrigin: string;
  usePasswordForObservedUrl(
    observedUrl: string,
    consume: EphemeralPasswordConsumer,
    signal?: AbortSignal,
  ): Promise<void>;
}

export type TrustedSubscriptionCheckResult =
  | { outcome: "completed"; subscription?: unknown }
  | {
      outcome: "failed";
      failureCode:
        | "SESSION_MISSING"
        | "SESSION_EXPIRED"
        | "SESSION_CORRUPT"
        | "REAUTHENTICATION_REQUIRED"
        | "INTERACTIVE_REQUIRED"
        | "LOGIN_FAILED"
        | "ORIGIN_MISMATCH"
        | "EXTRACTION_FAILED"
        | "PERSISTENCE_FAILED"
        | "CHECK_FAILED";
    };

/**
 * Trusted local integration point for the controlled browser/check flow.
 * This interface is not part of the agent-facing broker surface.
 */
export interface TrustedSubscriptionCheckExecutor {
  execute(
    context: TrustedSubscriptionCheckContext,
  ): Promise<TrustedSubscriptionCheckResult>;
}

export interface CredentialBrokerConfiguration {
  bindings: unknown;
  backends: readonly CredentialBackend[];
  executor: TrustedSubscriptionCheckExecutor;
}

export class CredentialBrokerConfigurationError extends Error {
  readonly code = "INVALID_BROKER_CONFIGURATION";

  constructor() {
    super("The credential broker configuration is invalid.");
    this.name = "CredentialBrokerConfigurationError";
  }
}

const accountReferenceSchema = z
  .string()
  .regex(/^acct_[a-f0-9]{32}$/u);
const requestSchema = z
  .object({
    accountReference: accountReferenceSchema,
    capability: z.literal(CHECK_SUBSCRIPTION_CAPABILITY),
  })
  .strict();
const normalizedSubscriptionSchema = z
  .object({
    providerId: z.string().min(1).max(64),
    providerName: z.string().min(1).max(100),
    planName: z.string().min(1).max(200),
    renewalDate: z.iso.date(),
    amountMinor: z.number().int().nonnegative().safe(),
    currency: z.string().regex(/^[A-Z]{3}$/u),
    billingCycle: z.enum(["monthly", "quarterly", "yearly", "unknown"]),
    status: z.enum(["active", "trial", "past_due", "cancelled", "unknown"]),
    checkedAt: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u),
  })
  .strict();
const executorFailureCodes = [
  "SESSION_MISSING",
  "SESSION_EXPIRED",
  "SESSION_CORRUPT",
  "REAUTHENTICATION_REQUIRED",
  "INTERACTIVE_REQUIRED",
  "LOGIN_FAILED",
  "ORIGIN_MISMATCH",
  "EXTRACTION_FAILED",
  "PERSISTENCE_FAILED",
  "CHECK_FAILED",
] as const;
const executorResultSchema = z.union([
  z
    .object({
      outcome: z.literal("completed"),
      subscription: normalizedSubscriptionSchema,
    })
    .strict(),
  z.object({ outcome: z.literal("completed") }).strict(),
  z
    .object({
      outcome: z.literal("failed"),
      failureCode: z.enum(executorFailureCodes),
    })
    .strict(),
]);

function failure(failureCode: BrokerFailureCode): CheckSubscriptionResponse {
  return Object.freeze({ outcome: "failed", failureCode });
}

function mapBackendFailure(error: CredentialBackendFailure): BrokerFailureCode {
  switch (error.code) {
    case "AUTHORIZATION_DENIED":
      return "AUTHORIZATION_DENIED";
    case "BACKEND_LOCKED":
      return "INTERACTIVE_REQUIRED";
    case "ORIGIN_MISMATCH":
      return "ORIGIN_MISMATCH";
    case "BACKEND_UNAVAILABLE":
      return "BACKEND_UNAVAILABLE";
    case "ITEM_NOT_FOUND":
    case "VAULT_NOT_FOUND":
    case "FIELD_NOT_FOUND":
    case "MALFORMED_OUTPUT":
      return "CREDENTIAL_UNAVAILABLE";
    case "PROCESS_TIMEOUT":
    case "OUTPUT_LIMIT_EXCEEDED":
    case "PROCESS_FAILED":
      return "BACKEND_UNAVAILABLE";
    case "CANCELLED":
      return "REQUEST_CANCELLED";
    case "CONSUMER_FAILED":
      return "LOGIN_FAILED";
  }
}

class BoundSubscriptionCheckContext
  implements TrustedSubscriptionCheckContext
{
  readonly accountReference: OpaqueAccountReference;
  readonly allowedOrigin: string;
  readonly #binding: CredentialBinding;
  readonly #backend: CredentialBackend;
  #credentialFailure: BrokerFailureCode | undefined;

  constructor(binding: CredentialBinding, backend: CredentialBackend) {
    this.#binding = binding;
    this.#backend = backend;
    this.accountReference = binding.accountReference;
    this.allowedOrigin = binding.allowedOrigin;
  }

  get credentialFailure(): BrokerFailureCode | undefined {
    return this.#credentialFailure;
  }

  async usePasswordForObservedUrl(
    observedUrl: string,
    consume: EphemeralPasswordConsumer,
    signal?: AbortSignal,
  ): Promise<void> {
    if (!originMatchesBinding(observedUrl, this.#binding.allowedOrigin)) {
      this.#credentialFailure = "ORIGIN_MISMATCH";
      throw new CredentialBackendFailure("ORIGIN_MISMATCH");
    }

    try {
      const request = signal
        ? Object.freeze({
            itemReference: this.#binding.itemReference,
            allowedOrigin: this.#binding.allowedOrigin,
            signal,
          })
        : Object.freeze({
            itemReference: this.#binding.itemReference,
            allowedOrigin: this.#binding.allowedOrigin,
          });
      await this.#backend.usePassword(
        request,
        async (password) => {
          await consume(password);
        },
      );
    } catch (error) {
      const failureCode =
        error instanceof CredentialBackendFailure
          ? mapBackendFailure(error)
          : "BACKEND_UNAVAILABLE";
      this.#credentialFailure = failureCode;
      throw new CredentialBackendFailure(
        error instanceof CredentialBackendFailure
          ? error.code
          : "BACKEND_UNAVAILABLE",
      );
    }
  }
}

class DomainBoundCredentialBroker implements CredentialBroker {
  readonly #bindings: ReadonlyMap<string, CredentialBinding>;
  readonly #backends: ReadonlyMap<CredentialBackendKind, CredentialBackend>;
  readonly #executor: TrustedSubscriptionCheckExecutor;

  constructor(
    bindings: readonly CredentialBinding[],
    backends: readonly CredentialBackend[],
    executor: TrustedSubscriptionCheckExecutor,
  ) {
    this.#bindings = new Map(
      bindings.map((binding) => [binding.accountReference, binding]),
    );
    this.#backends = new Map(
      backends.map((backend) => [backend.kind, backend]),
    );
    this.#executor = executor;
  }

  async checkSubscription(
    request: CheckSubscriptionRequest,
  ): Promise<CheckSubscriptionResponse> {
    let parsedRequest: ReturnType<typeof requestSchema.safeParse>;
    try {
      parsedRequest = requestSchema.safeParse(request);
    } catch {
      return failure("REQUEST_DENIED");
    }
    if (!parsedRequest.success) {
      return failure("REQUEST_DENIED");
    }

    const binding = this.#bindings.get(parsedRequest.data.accountReference);
    if (!binding) {
      return failure("BINDING_NOT_FOUND");
    }
    const backend = this.#backends.get(binding.backendKind);
    if (!backend) {
      return failure("BACKEND_UNAVAILABLE");
    }

    const context = new BoundSubscriptionCheckContext(binding, backend);
    try {
      const untrustedResult = await this.#executor.execute(context);
      if (context.credentialFailure) {
        return failure(context.credentialFailure);
      }

      const result = executorResultSchema.safeParse(untrustedResult);
      if (!result.success) {
        return failure("CHECK_FAILED");
      }
      if (result.data.outcome === "failed") {
        return failure(result.data.failureCode);
      }

      const completed = {
        outcome: "completed",
        accountReference: binding.accountReference,
        capability: CHECK_SUBSCRIPTION_CAPABILITY,
      } as const;
      return "subscription" in result.data
        ? Object.freeze({
            ...completed,
            subscription: result.data.subscription,
          })
        : Object.freeze(completed);
    } catch {
      return failure(context.credentialFailure ?? "CHECK_FAILED");
    }
  }
}

function validateBackends(
  value: readonly CredentialBackend[],
): readonly CredentialBackend[] {
  if (!Array.isArray(value)) {
    throw new CredentialBrokerConfigurationError();
  }

  const kinds = new Set<CredentialBackendKind>();
  for (const backend of value) {
    if (
      !backend ||
      (backend.kind !== "one_password" &&
        backend.kind !== "synthetic_fake") ||
      typeof backend.usePassword !== "function" ||
      kinds.has(backend.kind)
    ) {
      throw new CredentialBrokerConfigurationError();
    }
    kinds.add(backend.kind);
  }
  return Object.freeze([...value]);
}

export function createCredentialBroker(
  configuration: CredentialBrokerConfiguration,
): CredentialBroker {
  try {
    const bindings = validateCredentialBindings(configuration.bindings);
    const backends = validateBackends(configuration.backends);
    if (
      !configuration.executor ||
      typeof configuration.executor.execute !== "function"
    ) {
      throw new CredentialBrokerConfigurationError();
    }
    return new DomainBoundCredentialBroker(
      bindings,
      backends,
      configuration.executor,
    );
  } catch {
    throw new CredentialBrokerConfigurationError();
  }
}
