import { z } from "zod";
import type { OpaqueAccountReference } from "../persistence/subscription-history.js";
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
  ): Promise<void>;
}

export type TrustedSubscriptionCheckResult =
  | { outcome: "completed" }
  | { outcome: "failed"; failureCode: "CHECK_FAILED" };

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
const executorResultSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("completed") }).strict(),
  z
    .object({
      outcome: z.literal("failed"),
      failureCode: z.literal("CHECK_FAILED"),
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
    case "ORIGIN_MISMATCH":
      return "ORIGIN_MISMATCH";
    case "BACKEND_UNAVAILABLE":
      return "BACKEND_UNAVAILABLE";
    case "ITEM_NOT_FOUND":
      return "CREDENTIAL_UNAVAILABLE";
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
  ): Promise<void> {
    if (!originMatchesBinding(observedUrl, this.#binding.allowedOrigin)) {
      this.#credentialFailure = "ORIGIN_MISMATCH";
      throw new CredentialBackendFailure("ORIGIN_MISMATCH");
    }

    try {
      await this.#backend.usePassword(
        Object.freeze({
          itemReference: this.#binding.itemReference,
          allowedOrigin: this.#binding.allowedOrigin,
        }),
        async (password) => {
          await consume(password);
        },
      );
    } catch (error) {
      const failureCode =
        error instanceof CredentialBackendFailure
          ? mapBackendFailure(error)
          : "CREDENTIAL_UNAVAILABLE";
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
      if (!result.success || result.data.outcome === "failed") {
        return failure("CHECK_FAILED");
      }

      return Object.freeze({
        outcome: "completed",
        accountReference: binding.accountReference,
        capability: CHECK_SUBSCRIPTION_CAPABILITY,
      });
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
