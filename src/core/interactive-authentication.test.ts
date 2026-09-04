import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  authenticateInteractively,
  InteractiveAuthenticationError,
  isPermittedInteractiveLoginUrl,
} from "./interactive-authentication.js";
import type { SessionKeyProvider } from "./session-key-provider.js";
import { SessionVault } from "./session-vault.js";

const html = `<!doctype html>
<button id="authenticate">Authenticate synthetic session</button>
<script>
  document.querySelector("#authenticate").addEventListener("click", () => {
    document.cookie = "synthetic_session=local-test; Path=/; SameSite=Lax";
    localStorage.setItem("synthetic-authenticated", "true");
    document.body.dataset.authenticated = "true";
  });
</script>`;

describe("interactive authentication URL policy", () => {
  it("allows HTTPS provider URLs", () => {
    expect(
      isPermittedInteractiveLoginUrl(
        "https://accounts.example.invalid/login",
      ),
    ).toBe(true);
  });

  it.each([
    "http://localhost:3000/login",
    "http://127.0.0.1:3000/login",
    "http://[::1]:3000/login",
  ])("allows synthetic loopback HTTP URL %s", (loginUrl) => {
    expect(isPermittedInteractiveLoginUrl(loginUrl)).toBe(true);
  });

  it("rejects remote HTTP before launching a browser with a redacted error", async () => {
    let browserLaunchAttempted = false;
    const vault = new SessionVault("/unused", {
      keyProvider: {
        async getKey() {
          return Buffer.alloc(32, 9);
        },
      },
    });

    const failure = await authenticateInteractively({
      browserType: chromium,
      loginUrl: "http://accounts.example.invalid/login",
      session: {
        providerId: "synthetic-provider",
        accountId: "synthetic-account",
      },
      expiresAt: new Date("2030-01-01T00:00:00.000Z"),
      vault,
      async launchBrowser() {
        browserLaunchAttempted = true;
        throw new Error("Browser should not launch.");
      },
      async waitForAuthenticated() {},
    }).catch((error: unknown) => error);

    expect(browserLaunchAttempted).toBe(false);
    expect(failure).toBeInstanceOf(InteractiveAuthenticationError);
    expect(failure).toMatchObject({
      code: "INTERACTIVE_AUTHENTICATION_FAILED",
      message: "Interactive authentication did not complete.",
    });
    expect(String(failure)).not.toContain("accounts.example.invalid");
  });
});

describe("authenticateInteractively", () => {
  const server = createServer((_request, response) => {
    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    });
    response.end(html);
  });
  let loginUrl = "";

  beforeAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Synthetic server did not start.");
    }
    loginUrl = `http://127.0.0.1:${address.port}/login`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });

  it(
    "captures a synthetic local-page login without accepting credentials",
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "subwatch-auth-test-"));
      const keyProvider: SessionKeyProvider = {
        async getKey() {
          return Buffer.alloc(32, 9);
        },
      };
      const vault = new SessionVault(directory, { keyProvider });
      const session = {
        providerId: "synthetic-local-provider",
        accountId: "synthetic-local-account",
      };

      try {
        await authenticateInteractively({
          browserType: chromium,
          loginUrl,
          session,
          expiresAt: new Date("2030-01-01T00:00:00.000Z"),
          vault,
          launchBrowser: () => chromium.launch({ headless: true }),
          async waitForAuthenticated(page) {
            await page.getByRole("button").click();
            await page.locator("body[data-authenticated=true]").waitFor();
          },
        });

        const saved = await vault.load(session);
        expect(saved.state).toBe("valid");
        if (saved.state === "valid") {
          expect(saved.storageState.cookies).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                name: "synthetic_session",
                value: "local-test",
              }),
            ]),
          );
          expect(saved.storageState.origins).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                localStorage: expect.arrayContaining([
                  {
                    name: "synthetic-authenticated",
                    value: "true",
                  },
                ]),
              }),
            ]),
          );
        }
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
    20_000,
  );
});
