import type {
  CredentialBackendKind,
  CredentialItemReference,
} from "./credential-binding.js";

export interface CredentialUseRequest {
  itemReference: CredentialItemReference;
  allowedOrigin: string;
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
  | "AUTHORIZATION_DENIED"
  | "ITEM_NOT_FOUND"
  | "ORIGIN_MISMATCH";

export class CredentialBackendFailure extends Error {
  constructor(readonly code: CredentialBackendFailureCode) {
    super("Credential use failed.");
    this.name = "CredentialBackendFailure";
  }
}
