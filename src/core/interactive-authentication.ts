import type { Browser, BrowserType, Page } from "playwright";
import {
  SessionVault,
  type SessionMetadata,
  type SessionReference,
  SessionVaultError,
} from "./session-vault.js";

export class InteractiveAuthenticationError extends Error {
  readonly code = "INTERACTIVE_AUTHENTICATION_FAILED";

  constructor() {
    super("Interactive authentication did not complete.");
    this.name = "InteractiveAuthenticationError";
  }
}

export interface InteractiveAuthenticationOptions {
  browserType: BrowserType;
  loginUrl: string;
  session: SessionReference;
  expiresAt: Date;
  vault: SessionVault;
  waitForAuthenticated(page: Page): Promise<void>;
  /**
   * Test seam for a synthetic headless browser. Production callers should omit
   * this so the user always receives a headed, interactive browser.
   */
  launchBrowser?: () => Promise<Browser>;
}

export async function authenticateInteractively(
  options: InteractiveAuthenticationOptions,
): Promise<SessionMetadata> {
  let browser: Browser | undefined;

  try {
    const loginUrl = new URL(options.loginUrl);
    if (loginUrl.protocol !== "https:" && loginUrl.protocol !== "http:") {
      throw new Error("Unsupported login URL.");
    }

    browser = options.launchBrowser
      ? await options.launchBrowser()
      : await options.browserType.launch({ headless: false });
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(loginUrl.href);
    await options.waitForAuthenticated(page);
    const storageState = await context.storageState({ indexedDB: true });

    return await options.vault.save(options.session, {
      storageState,
      expiresAt: options.expiresAt,
    });
  } catch (error) {
    if (error instanceof SessionVaultError) {
      throw error;
    }
    throw new InteractiveAuthenticationError();
  } finally {
    await browser?.close().catch(() => undefined);
  }
}
