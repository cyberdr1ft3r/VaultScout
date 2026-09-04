import { createHash, randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { AsyncEntry } from "@napi-rs/keyring";

const KEY_BYTES = 32;
const SERVICE_NAME = "SubWatch Session Vault";
const pendingKeys = new Map<string, Promise<Buffer>>();

export interface SessionKeyProvider {
  getKey(dataDirectory: string): Promise<Buffer>;
}

export class SessionKeyProviderError extends Error {
  readonly code = "SESSION_KEY_UNAVAILABLE";

  constructor() {
    super("The operating-system credential store is unavailable.");
    this.name = "SessionKeyProviderError";
  }
}

function keyAccount(dataDirectory: string): string {
  return createHash("sha256").update(resolve(dataDirectory)).digest("hex");
}

function readOrCreateKey(account: string): Promise<Buffer> {
  const entry = new AsyncEntry(SERVICE_NAME, account);

  return entry.getSecret().then(async (stored) => {
    if (stored) {
      const key = Buffer.from(stored);
      if (key.length !== KEY_BYTES) {
        throw new SessionKeyProviderError();
      }
      return key;
    }

    const generated = randomBytes(KEY_BYTES);
    await entry.setSecret(generated);
    const persisted = await entry.getSecret();
    if (!persisted || persisted.length !== KEY_BYTES) {
      throw new SessionKeyProviderError();
    }
    return Buffer.from(persisted);
  });
}

export const systemSessionKeyProvider: SessionKeyProvider = {
  async getKey(dataDirectory) {
    const account = keyAccount(dataDirectory);
    let pending = pendingKeys.get(account);

    if (!pending) {
      pending = readOrCreateKey(account)
        .catch(() => {
          throw new SessionKeyProviderError();
        })
        .finally(() => {
          pendingKeys.delete(account);
        });
      pendingKeys.set(account, pending);
    }

    return pending;
  },
};
