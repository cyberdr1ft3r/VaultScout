import type {
  CredentialBackendKind,
  CredentialItemReference,
} from "./credential-binding.js";

export interface CredentialUseRequest {
  itemReference: CredentialItemReference;
  allowedOrigin: string;
  signal?: AbortSignal;
}

export type EphemeralPasswordConsumer = (
  password: string,
) => Promise<void>;

/**
 * Trusted-process interface only. It deliberately has no list, search, or
 * secret-returning method. Implementations scope a password to one callback
 * and return no credential material.
 */
export interface CredentialBackend {
  readonly kind: CredentialBackendKind;
  usePassword(
    request: Readonly<CredentialUseRequest>,
    consume: EphemeralPasswordConsumer,
  ): Promise<void>;
}

export type CredentialBackendFailureCode =
  | "BACKEND_UNAVAILABLE"
  | "BACKEND_LOCKED"
  | "AUTHORIZATION_DENIED"
  | "ITEM_NOT_FOUND"
  | "VAULT_NOT_FOUND"
  | "FIELD_NOT_FOUND"
  | "ORIGIN_MISMATCH"
  | "MALFORMED_OUTPUT"
  | "PROCESS_TIMEOUT"
  | "OUTPUT_LIMIT_EXCEEDED"
  | "PROCESS_FAILED"
  | "CANCELLED"
  | "CONSUMER_FAILED";

export class CredentialBackendFailure extends Error {
  constructor(readonly code: CredentialBackendFailureCode) {
    super("Credential use failed.");
    this.name = "CredentialBackendFailure";
  }
}
