import { z } from "zod";
import type { OpaqueAccountReference } from "../persistence/subscription-history.js";

const accountReferenceSchema = z
  .string()
  .regex(/^acct_[a-f0-9]{32}$/u);
const itemReferenceSchema = z
  .string()
  .regex(/^item_[A-Za-z0-9_-]{16,128}$/u);
const backendKindSchema = z.enum(["one_password", "synthetic_fake"]);

declare const credentialItemReferenceBrand: unique symbol;
export type CredentialItemReference = string & {
  readonly [credentialItemReferenceBrand]: true;
};

export type CredentialBackendKind = z.infer<typeof backendKindSchema>;

export interface CredentialBinding {
  accountReference: OpaqueAccountReference;
  backendKind: CredentialBackendKind;
  itemReference: CredentialItemReference;
  allowedOrigin: string;
}

export class CredentialBindingError extends Error {
  readonly code = "INVALID_CREDENTIAL_BINDING";

  constructor() {
    super("The credential binding is invalid.");
    this.name = "CredentialBindingError";
  }
}

function normalizedHostname(hostname: string): string {
  const lower = hostname.toLowerCase();
  return lower.startsWith("[") && lower.endsWith("]")
    ? lower.slice(1, -1)
    : lower;
}

function exactAllowedOrigin(value: string): string | undefined {
  try {
    const url = new URL(value);
    const hostname = normalizedHostname(url.hostname);
    const loopbackHttp =
      url.protocol === "http:" &&
      (hostname === "localhost" ||
        hostname === "127.0.0.1" ||
        hostname === "::1");

    if (
      (url.protocol !== "https:" && !loopbackHttp) ||
      url.username ||
      url.password ||
      hostname.includes("*") ||
      url.pathname !== "/" ||
      url.search ||
      url.hash ||
      value !== url.origin
    ) {
      return undefined;
    }

    return url.origin;
  } catch {
    return undefined;
  }
}

const credentialBindingSchema = z
  .object({
    accountReference: accountReferenceSchema,
    backendKind: backendKindSchema,
    itemReference: itemReferenceSchema,
    allowedOrigin: z.string(),
  })
  .strict();

export function validateCredentialBinding(value: unknown): CredentialBinding {
  const parsed = credentialBindingSchema.safeParse(value);
  if (!parsed.success) {
    throw new CredentialBindingError();
  }

  const allowedOrigin = exactAllowedOrigin(parsed.data.allowedOrigin);
  if (!allowedOrigin) {
    throw new CredentialBindingError();
  }

  return Object.freeze({
    accountReference:
      parsed.data.accountReference as OpaqueAccountReference,
    backendKind: parsed.data.backendKind,
    itemReference:
      parsed.data.itemReference as CredentialItemReference,
    allowedOrigin,
  });
}

export function validateCredentialBindings(
  value: unknown,
): readonly CredentialBinding[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new CredentialBindingError();
  }

  const bindings = value.map(validateCredentialBinding);
  if (
    new Set(bindings.map((binding) => binding.accountReference)).size !==
    bindings.length
  ) {
    throw new CredentialBindingError();
  }

  return Object.freeze(bindings);
}

export function originMatchesBinding(
  observedUrl: string,
  allowedOrigin: string,
): boolean {
  try {
    const observed = new URL(observedUrl);
    if (
      observed.username ||
      observed.password ||
      observed.hostname.includes("*")
    ) {
      return false;
    }
    return observed.origin === allowedOrigin;
  } catch {
    return false;
  }
}
