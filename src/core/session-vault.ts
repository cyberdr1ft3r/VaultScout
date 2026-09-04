import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from "node:crypto";
import {
  lstat,
  open,
  readFile,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import type { BrowserContext } from "playwright";
import { z } from "zod";
import { secureDirectory, secureFile } from "./secure-filesystem.js";
import {
  systemSessionKeyProvider,
  type SessionKeyProvider,
} from "./session-key-provider.js";

const FORMAT_VERSION = 1;
const ALGORITHM = "aes-256-gcm";
const MAX_SESSION_BYTES = 16 * 1024 * 1024;
const SESSION_FILE = "session.v1.enc";

const envelopeSchema = z
  .object({
    version: z.literal(FORMAT_VERSION),
    algorithm: z.literal(ALGORITHM),
    iv: z.base64(),
    authenticationTag: z.base64(),
    ciphertext: z.base64(),
  })
  .strict();

type PlaywrightStorageState = Awaited<
  ReturnType<BrowserContext["storageState"]>
>;

interface StoredPayload {
  version: 1;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  reauthenticationRequired: boolean;
  storageState: PlaywrightStorageState;
}

export interface SessionReference {
  providerId: string;
  accountId: string;
}

export interface SessionMetadata {
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
}

export type SessionState =
  | { state: "missing" }
  | {
      state: "valid";
      metadata: SessionMetadata;
      storageState: PlaywrightStorageState;
    }
  | { state: "expired"; metadata: SessionMetadata }
  | { state: "reauthentication_required"; metadata: SessionMetadata };

export type SessionVaultErrorCode =
  | "INVALID_REFERENCE"
  | "KEY_UNAVAILABLE"
  | "SESSION_CORRUPT"
  | "SESSION_READ_FAILED"
  | "SESSION_WRITE_FAILED";

export class SessionVaultError extends Error {
  constructor(readonly code: SessionVaultErrorCode, message: string) {
    super(message);
    this.name = "SessionVaultError";
  }
}

export interface SaveSessionInput {
  storageState: PlaywrightStorageState;
  expiresAt: Date;
}

export interface SessionVaultOptions {
  keyProvider?: SessionKeyProvider;
  now?: () => Date;
}

function opaquePathSegment(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function validateReference(reference: SessionReference): void {
  for (const value of [reference.providerId, reference.accountId]) {
    if (
      typeof value !== "string" ||
      value.trim().length === 0 ||
      value.length > 256
    ) {
      throw new SessionVaultError(
        "INVALID_REFERENCE",
        "The session reference is invalid.",
      );
    }
  }
}

function isFileSystemError(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}

async function assertNotSymbolicLink(path: string): Promise<void> {
  const entry = await lstat(path);
  if (entry.isSymbolicLink()) {
    throw new Error("Unsafe session path.");
  }
}

async function ensureManagedDirectory(path: string): Promise<void> {
  try {
    await assertNotSymbolicLink(path);
  } catch (error) {
    if (!isFileSystemError(error, "ENOENT")) {
      throw error;
    }
  }

  await secureDirectory(path);
  const entry = await lstat(path);
  if (!entry.isDirectory() || entry.isSymbolicLink()) {
    throw new Error("Unsafe session path.");
  }
}

function metadata(payload: StoredPayload): SessionMetadata {
  return {
    createdAt: payload.createdAt,
    updatedAt: payload.updatedAt,
    expiresAt: payload.expiresAt,
  };
}

function isStorageState(value: unknown): value is PlaywrightStorageState {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return Array.isArray(candidate.cookies) && Array.isArray(candidate.origins);
}

function parsePayload(value: unknown): StoredPayload {
  if (!value || typeof value !== "object") {
    throw new Error("Invalid session.");
  }

  const candidate = value as Record<string, unknown>;
  const timestamps = [
    candidate.createdAt,
    candidate.updatedAt,
    candidate.expiresAt,
  ];

  if (
    candidate.version !== FORMAT_VERSION ||
    timestamps.some(
      (timestamp) =>
        typeof timestamp !== "string" || !Number.isFinite(Date.parse(timestamp)),
    ) ||
    typeof candidate.reauthenticationRequired !== "boolean" ||
    !isStorageState(candidate.storageState)
  ) {
    throw new Error("Invalid session.");
  }

  return candidate as unknown as StoredPayload;
}

function authenticatedData(reference: SessionReference): Buffer {
  return Buffer.from(
    JSON.stringify([
      FORMAT_VERSION,
      reference.providerId,
      reference.accountId,
    ]),
  );
}

function encrypt(
  payload: StoredPayload,
  key: Buffer,
  reference: SessionReference,
): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  cipher.setAAD(authenticatedData(reference));
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(payload), "utf8"),
    cipher.final(),
  ]);

  return JSON.stringify({
    version: FORMAT_VERSION,
    algorithm: ALGORITHM,
    iv: iv.toString("base64"),
    authenticationTag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  });
}

function decrypt(
  serialized: string,
  key: Buffer,
  reference: SessionReference,
): StoredPayload {
  const envelope = envelopeSchema.parse(JSON.parse(serialized));
  const decipher = createDecipheriv(
    ALGORITHM,
    key,
    Buffer.from(envelope.iv, "base64"),
  );
  decipher.setAAD(authenticatedData(reference));
  decipher.setAuthTag(Buffer.from(envelope.authenticationTag, "base64"));

  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, "base64")),
    decipher.final(),
  ]);

  return parsePayload(JSON.parse(plaintext.toString("utf8")));
}

async function atomicWrite(path: string, contents: string): Promise<void> {
  const directory = resolve(path, "..");
  const temporaryPath = join(directory, `.${SESSION_FILE}.${randomUUID()}.tmp`);
  let temporaryCreated = false;

  try {
    const handle = await open(temporaryPath, "wx", 0o600);
    temporaryCreated = true;
    try {
      await handle.writeFile(contents, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }

    await secureFile(temporaryPath);
    await rename(temporaryPath, path);
    temporaryCreated = false;
    await secureFile(path);

    if (process.platform !== "win32") {
      const directoryHandle = await open(directory, "r");
      try {
        await directoryHandle.sync();
      } finally {
        await directoryHandle.close();
      }
    }
  } finally {
    if (temporaryCreated) {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
    }
  }
}

export class SessionVault {
  readonly #dataDirectory: string;
  readonly #keyProvider: SessionKeyProvider;
  readonly #now: () => Date;

  constructor(dataDirectory: string, options: SessionVaultOptions = {}) {
    this.#dataDirectory = resolve(dataDirectory);
    this.#keyProvider = options.keyProvider ?? systemSessionKeyProvider;
    this.#now = options.now ?? (() => new Date());
  }

  #sessionDirectory(reference: SessionReference): string {
    return join(
      this.#dataDirectory,
      "sessions",
      opaquePathSegment(reference.providerId),
      opaquePathSegment(reference.accountId),
    );
  }

  async #hasSafeSessionDirectory(
    reference: SessionReference,
  ): Promise<boolean> {
    const sessions = join(this.#dataDirectory, "sessions");
    const provider = join(sessions, opaquePathSegment(reference.providerId));
    const account = this.#sessionDirectory(reference);

    for (const directory of [
      this.#dataDirectory,
      sessions,
      provider,
      account,
    ]) {
      try {
        const entry = await lstat(directory);
        if (!entry.isDirectory() || entry.isSymbolicLink()) {
          throw new Error("Unsafe session path.");
        }
      } catch (error) {
        if (isFileSystemError(error, "ENOENT")) {
          return false;
        }
        throw error;
      }
    }

    return true;
  }

  async #prepareSessionDirectory(
    reference: SessionReference,
  ): Promise<string> {
    validateReference(reference);
    const sessions = join(this.#dataDirectory, "sessions");
    const provider = join(sessions, opaquePathSegment(reference.providerId));
    const account = this.#sessionDirectory(reference);

    for (const directory of [
      this.#dataDirectory,
      sessions,
      provider,
      account,
    ]) {
      await ensureManagedDirectory(directory);
    }

    return account;
  }

  async #key(): Promise<Buffer> {
    try {
      const key = await this.#keyProvider.getKey(this.#dataDirectory);
      if (key.length !== 32) {
        throw new Error("Invalid key.");
      }
      return key;
    } catch {
      throw new SessionVaultError(
        "KEY_UNAVAILABLE",
        "The session encryption key is unavailable.",
      );
    }
  }

  async #readPayload(
    reference: SessionReference,
  ): Promise<StoredPayload | undefined> {
    validateReference(reference);
    const path = join(this.#sessionDirectory(reference), SESSION_FILE);

    try {
      if (!(await this.#hasSafeSessionDirectory(reference))) {
        return undefined;
      }
      await assertNotSymbolicLink(path);
      const file = await stat(path);
      if (!file.isFile() || file.size > MAX_SESSION_BYTES) {
        throw new SessionVaultError(
          "SESSION_CORRUPT",
          "The encrypted session is invalid.",
        );
      }
      const [serialized, key] = await Promise.all([
        readFile(path, "utf8"),
        this.#key(),
      ]);

      try {
        return decrypt(serialized, key, reference);
      } catch {
        throw new SessionVaultError(
          "SESSION_CORRUPT",
          "The encrypted session is invalid.",
        );
      }
    } catch (error) {
      if (isFileSystemError(error, "ENOENT")) {
        return undefined;
      }
      if (error instanceof SessionVaultError) {
        throw error;
      }
      throw new SessionVaultError(
        "SESSION_READ_FAILED",
        "The encrypted session could not be read.",
      );
    }
  }

  async load(reference: SessionReference): Promise<SessionState> {
    const payload = await this.#readPayload(reference);
    if (!payload) {
      return { state: "missing" };
    }

    if (payload.reauthenticationRequired) {
      return {
        state: "reauthentication_required",
        metadata: metadata(payload),
      };
    }

    if (Date.parse(payload.expiresAt) <= this.#now().getTime()) {
      return { state: "expired", metadata: metadata(payload) };
    }

    return {
      state: "valid",
      metadata: metadata(payload),
      storageState: payload.storageState,
    };
  }

  async save(
    reference: SessionReference,
    input: SaveSessionInput,
  ): Promise<SessionMetadata> {
    validateReference(reference);
    if (
      !(input.expiresAt instanceof Date) ||
      !Number.isFinite(input.expiresAt.getTime()) ||
      !isStorageState(input.storageState)
    ) {
      throw new SessionVaultError(
        "SESSION_WRITE_FAILED",
        "The session could not be saved.",
      );
    }

    try {
      const directory = await this.#prepareSessionDirectory(reference);
      const existing = await this.#readPayload(reference);
      const now = this.#now().toISOString();
      const payload: StoredPayload = {
        version: FORMAT_VERSION,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
        expiresAt: input.expiresAt.toISOString(),
        reauthenticationRequired: false,
        storageState: input.storageState,
      };
      const key = await this.#key();
      await atomicWrite(
        join(directory, SESSION_FILE),
        encrypt(payload, key, reference),
      );
      return metadata(payload);
    } catch (error) {
      if (error instanceof SessionVaultError) {
        throw error;
      }
      throw new SessionVaultError(
        "SESSION_WRITE_FAILED",
        "The session could not be saved.",
      );
    }
  }

  async requireReauthentication(
    reference: SessionReference,
  ): Promise<SessionState> {
    const payload = await this.#readPayload(reference);
    if (!payload) {
      return { state: "missing" };
    }

    try {
      payload.reauthenticationRequired = true;
      payload.updatedAt = this.#now().toISOString();
      const directory = await this.#prepareSessionDirectory(reference);
      const key = await this.#key();
      await atomicWrite(
        join(directory, SESSION_FILE),
        encrypt(payload, key, reference),
      );
      return {
        state: "reauthentication_required",
        metadata: metadata(payload),
      };
    } catch (error) {
      if (error instanceof SessionVaultError) {
        throw error;
      }
      throw new SessionVaultError(
        "SESSION_WRITE_FAILED",
        "The session could not be updated.",
      );
    }
  }
}
