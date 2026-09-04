import { chmod, lstat, mkdtemp, readFile, readdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SessionKeyProvider } from "./session-key-provider.js";
import { SessionVault, SessionVaultError } from "./session-vault.js";

const syntheticKey = Buffer.alloc(32, 7);
const keyProvider: SessionKeyProvider = {
  async getKey() {
    return syntheticKey;
  },
};
const reference = {
  providerId: "synthetic-provider",
  accountId: "synthetic-account@example.invalid",
};
const storageState = {
  cookies: [
    {
      name: "synthetic_session",
      value: "not-a-real-token",
      domain: "example.invalid",
      path: "/",
      expires: 2_000_000_000,
      httpOnly: true,
      secure: true,
      sameSite: "Lax" as const,
    },
  ],
  origins: [
    {
      origin: "https://example.invalid",
      localStorage: [{ name: "synthetic-state", value: "signed-in" }],
    },
  ],
};

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "vaultscout-vault-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("SessionVault", () => {
  it("isolates opaque account paths beneath the configured data directory", async () => {
    const directory = await temporaryDirectory();
    const vault = new SessionVault(directory, { keyProvider });
    const unsafeLookingReference = {
      providerId: "../synthetic-provider",
      accountId: "../../synthetic-account@example.invalid",
    };

    await vault.save(unsafeLookingReference, {
      storageState,
      expiresAt: new Date("2030-01-01T00:00:00.000Z"),
    });

    const entries = await readdir(directory, { recursive: true });
    const paths = entries.map(String);
    expect(paths).toHaveLength(4);
    expect(paths.every((path) => !path.includes(".."))).toBe(true);
    expect(paths.every((path) => !path.includes("synthetic"))).toBe(true);

    const encryptedPath = join(directory, paths.find((path) => path.endsWith(".enc"))!);
    const encrypted = await readFile(encryptedPath, "utf8");
    expect(encrypted).not.toContain("not-a-real-token");
    expect(encrypted).not.toContain(unsafeLookingReference.accountId);
  });

  it("reports missing, valid, expired, and reauthentication-required states", async () => {
    const directory = await temporaryDirectory();
    let now = new Date("2026-09-04T10:00:00.000Z");
    const vault = new SessionVault(directory, {
      keyProvider,
      now: () => now,
    });

    await expect(vault.load(reference)).resolves.toEqual({ state: "missing" });

    const saved = await vault.save(reference, {
      storageState,
      expiresAt: new Date("2026-09-04T11:00:00.000Z"),
    });
    expect(saved).toEqual({
      createdAt: "2026-09-04T10:00:00.000Z",
      updatedAt: "2026-09-04T10:00:00.000Z",
      expiresAt: "2026-09-04T11:00:00.000Z",
    });

    const valid = await vault.load(reference);
    expect(valid.state).toBe("valid");
    if (valid.state === "valid") {
      expect(valid.storageState).toEqual(storageState);
    }

    now = new Date("2026-09-04T11:00:00.000Z");
    const expired = await vault.load(reference);
    expect(expired.state).toBe("expired");
    expect(expired).not.toHaveProperty("storageState");

    await vault.requireReauthentication(reference);
    const reauthenticationRequired = await vault.load(reference);
    expect(reauthenticationRequired.state).toBe(
      "reauthentication_required",
    );
    expect(reauthenticationRequired).not.toHaveProperty("storageState");
  });

  it("atomically replaces owner-only session files", async () => {
    const directory = await temporaryDirectory();
    const vault = new SessionVault(directory, { keyProvider });

    await vault.save(reference, {
      storageState,
      expiresAt: new Date("2030-01-01T00:00:00.000Z"),
    });
    await vault.save(reference, {
      storageState: { cookies: [], origins: [] },
      expiresAt: new Date("2031-01-01T00:00:00.000Z"),
    });

    const paths = (await readdir(directory, { recursive: true })).map(String);
    expect(paths.filter((path) => path.endsWith(".enc"))).toHaveLength(1);
    expect(paths.some((path) => path.endsWith(".tmp"))).toBe(false);

    if (process.platform !== "win32") {
      for (const path of paths) {
        const mode = (await lstat(join(directory, path))).mode & 0o777;
        expect(mode).toBe(path.endsWith(".enc") ? 0o600 : 0o700);
      }
    }
  });

  it("returns only a generic error for tampered encrypted data", async () => {
    const directory = await temporaryDirectory();
    const vault = new SessionVault(directory, { keyProvider });
    await vault.save(reference, {
      storageState,
      expiresAt: new Date("2030-01-01T00:00:00.000Z"),
    });

    const encryptedPath = join(
      directory,
      (await readdir(directory, { recursive: true }))
        .map(String)
        .find((path) => path.endsWith(".enc"))!,
    );
    await chmod(encryptedPath, 0o600);
    const envelope = JSON.parse(await readFile(encryptedPath, "utf8")) as {
      ciphertext: string;
    };
    envelope.ciphertext = `${envelope.ciphertext.slice(0, -4)}AAAA`;
    const { writeFile } = await import("node:fs/promises");
    await writeFile(encryptedPath, JSON.stringify(envelope), { mode: 0o600 });

    const failure = await vault.load(reference).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(SessionVaultError);
    expect(failure).toMatchObject({ code: "SESSION_CORRUPT" });
    expect(String(failure)).not.toContain("not-a-real-token");
    expect(String(failure)).not.toContain(reference.accountId);
  });

  it("rejects symbolic links in the managed session hierarchy", async () => {
    const directory = await temporaryDirectory();
    const outside = await temporaryDirectory();
    await symlink(outside, join(directory, "sessions"));
    const vault = new SessionVault(directory, { keyProvider });

    const failure = await vault
      .save(reference, {
        storageState,
        expiresAt: new Date("2030-01-01T00:00:00.000Z"),
      })
      .catch((error: unknown) => error);

    expect(failure).toMatchObject({ code: "SESSION_WRITE_FAILED" });
    await expect(readdir(outside)).resolves.toEqual([]);
  });
});
