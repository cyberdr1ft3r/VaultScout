import type { Browser, BrowserContext, Page } from "playwright";
import { z } from "zod";
import type { Subscription } from "../core/subscription.js";
import {
  SessionVault,
  type SessionReference,
  type SessionState,
} from "../core/session-vault.js";
import type { TrustedSubscriptionCheckContext } from "./credential-broker.js";
import { CredentialBackendFailure } from "./credential-backend.js";

export type ControlledBrowserFailureCode =
  | "SESSION_CORRUPT"
  | "ORIGIN_MISMATCH"
  | "INTERACTIVE_REQUIRED"
  | "LOGIN_FAILED"
  | "EXTRACTION_FAILED"
  | "CHECK_FAILED";

export class ControlledBrowserFailure extends Error {
  constructor(readonly code: ControlledBrowserFailureCode) {
    super("The controlled browser check failed.");
    this.name = "ControlledBrowserFailure";
  }
}

export interface TrustedSyntheticPageConnector {
  readonly id: string;
  readonly name: string;
  extract(page: Page, checkedAt: string): Promise<unknown>;
}

export interface TrustedSyntheticTarget {
  providerId: string;
  providerName: string;
  trustedUsername: string;
  sessionLifetimeMs: number;
  connector: TrustedSyntheticPageConnector;
}

export interface ControlledSyntheticBrowserOptions {
  context: TrustedSubscriptionCheckContext;
  target: TrustedSyntheticTarget;
  sessionVault: SessionVault;
  launchBrowser(): Promise<Browser>;
  now: Date;
  signal: AbortSignal;
}

export interface ControlledSyntheticBrowserResult {
  subscription: Subscription;
  sessionDisposition:
    | "reused"
    | "missing"
    | "expired"
    | "reauthentication_required";
}

const strictSubscriptionSchema = z
  .object({
    providerId: z.string().min(1).max(64),
    providerName: z.string().min(1).max(100),
    planName: z.string().min(1).max(200),
    renewalDate: z.iso.date(),
    amountMinor: z.number().int().nonnegative().safe(),
    currency: z.string().regex(/^[A-Z]{3}$/u),
    billingCycle: z.enum(["monthly", "quarterly", "yearly", "unknown"]),
    status: z.enum(["active", "trial", "past_due", "cancelled", "unknown"]),
    checkedAt: z.iso.datetime(),
  })
  .strict();

function assertExactOrigin(url: string, allowedOrigin: string): URL {
  try {
    const parsed = new URL(url);
    if (
      parsed.username ||
      parsed.password ||
      parsed.origin !== allowedOrigin ||
      (parsed.protocol !== "https:" &&
        !(
          parsed.protocol === "http:" &&
          (parsed.hostname === "localhost" ||
            parsed.hostname === "127.0.0.1" ||
            parsed.hostname === "[::1]")
        ))
    ) {
      throw new Error("Origin mismatch.");
    }
    return parsed;
  } catch {
    throw new ControlledBrowserFailure("ORIGIN_MISMATCH");
  }
}

function sessionReference(
  context: TrustedSubscriptionCheckContext,
  target: TrustedSyntheticTarget,
): SessionReference {
  return {
    providerId: target.providerId,
    accountId: context.accountReference,
  };
}

function sessionDisposition(
  session: SessionState,
): ControlledSyntheticBrowserResult["sessionDisposition"] {
  switch (session.state) {
    case "valid":
      return "reused";
    case "missing":
      return "missing";
    case "expired":
      return "expired";
    case "reauthentication_required":
      return "reauthentication_required";
  }
}

async function detectInteractiveBoundary(page: Page): Promise<void> {
  if (
    (await page.locator('[data-vaultscout-interactive="mfa"]').count()) > 0 ||
    (await page.locator('[data-vaultscout-interactive="captcha"]').count()) >
      0 ||
    (await page
      .locator('[data-vaultscout-interactive="confirmation"]')
      .count()) > 0
  ) {
    throw new ControlledBrowserFailure("INTERACTIVE_REQUIRED");
  }
}

class ExactOriginBrowserBoundary {
  readonly #context: BrowserContext;
  readonly #allowedOrigin: string;
  #page: Page | undefined;
  #violation = false;
  #loginSubmissionUrl: string | undefined;

  constructor(context: BrowserContext, allowedOrigin: string) {
    this.#context = context;
    this.#allowedOrigin = allowedOrigin;
  }

  async install(): Promise<void> {
    await this.#context.route("**/*", async (route) => {
      const request = route.request();
      let allowed = false;
      try {
        const parsed = assertExactOrigin(request.url(), this.#allowedOrigin);
        allowed =
          request.method() === "GET" ||
          request.method() === "HEAD" ||
          (request.method() === "POST" &&
            this.#loginSubmissionUrl === parsed.href);
      } catch {
        allowed = false;
      }

      if (!allowed) {
        this.#violation = true;
        await route.abort("blockedbyclient");
        return;
      }
      await route.continue();
    });
    await this.#context.routeWebSocket(/.*/u, () => {
      this.#violation = true;
    });
    this.#context.on("serviceworker", () => {
      this.#violation = true;
    });
    this.#context.on("page", (page) => {
      if (this.#page && page !== this.#page) {
        this.#violation = true;
        void page.close().catch(() => undefined);
      }
    });
  }

  attach(page: Page): void {
    this.#page = page;
    page.on("frameattached", () => {
      this.#violation = true;
    });
    page.on("framenavigated", (frame) => {
      const url = frame.url();
      if (url !== "about:blank") {
        try {
          assertExactOrigin(url, this.#allowedOrigin);
        } catch {
          this.#violation = true;
        }
      }
      if (frame !== page.mainFrame()) {
        this.#violation = true;
      }
    });
  }

  assertSafe(page: Page): void {
    if (
      this.#violation ||
      page.isClosed() ||
      page.frames().length !== 1 ||
      page.mainFrame() !== page.frames()[0]
    ) {
      throw new ControlledBrowserFailure("ORIGIN_MISMATCH");
    }
    assertExactOrigin(page.url(), this.#allowedOrigin);
  }

  async formAction(page: Page): Promise<{
    form: ReturnType<Page["locator"]>;
    action: string;
  }> {
    this.assertSafe(page);
    const form = page.locator('form[data-vaultscout-login="true"]');
    if ((await form.count()) !== 1) {
      throw new ControlledBrowserFailure("LOGIN_FAILED");
    }
    const action = await form.evaluate((node) => {
      if (!(node instanceof HTMLFormElement) || node.target) return "";
      return node.action;
    });
    const parsed = assertExactOrigin(action, this.#allowedOrigin);
    return { form, action: parsed.href };
  }

  async navigate(page: Page, url: string): Promise<void> {
    try {
      await page.goto(url, { waitUntil: "domcontentloaded" });
    } catch {
      this.assertSafe(page);
      throw new ControlledBrowserFailure("LOGIN_FAILED");
    }
    this.assertSafe(page);
  }

  async submit(
    page: Page,
    form: ReturnType<Page["locator"]>,
    action: string,
  ): Promise<void> {
    this.assertSafe(page);
    this.#loginSubmissionUrl = action;
    let submitFailed = false;
    try {
      await Promise.all([
        page.waitForNavigation({ waitUntil: "domcontentloaded" }),
        form.evaluate((node, expectedAction) => {
          if (
            !(node instanceof HTMLFormElement) ||
            node.action !== expectedAction ||
            node.target
          ) {
            throw new Error("Unsafe form.");
          }
          node.submit();
        }, action),
      ]);
    } catch {
      submitFailed = true;
    } finally {
      this.#loginSubmissionUrl = undefined;
    }
    if (submitFailed) {
      this.assertSafe(page);
      throw new ControlledBrowserFailure("LOGIN_FAILED");
    }
    this.assertSafe(page);
  }
}

async function loadSession(
  sessionVault: SessionVault,
  reference: SessionReference,
): Promise<SessionState> {
  try {
    return await sessionVault.load(reference);
  } catch {
    throw new ControlledBrowserFailure("SESSION_CORRUPT");
  }
}

function reconstructSubscription(
  value: unknown,
  target: TrustedSyntheticTarget,
  checkedAt: string,
): Subscription {
  const parsed = strictSubscriptionSchema.safeParse(value);
  if (
    !parsed.success ||
    parsed.data.providerId !== target.providerId ||
    parsed.data.providerName !== target.providerName ||
    parsed.data.checkedAt !== checkedAt
  ) {
    throw new ControlledBrowserFailure("EXTRACTION_FAILED");
  }

  return {
    providerId: parsed.data.providerId,
    providerName: parsed.data.providerName,
    planName: parsed.data.planName,
    renewalDate: parsed.data.renewalDate,
    amountMinor: parsed.data.amountMinor,
    currency: parsed.data.currency,
    billingCycle: parsed.data.billingCycle,
    status: parsed.data.status,
    checkedAt: parsed.data.checkedAt,
  };
}

export async function runControlledSyntheticBrowserCheck(
  options: ControlledSyntheticBrowserOptions,
): Promise<ControlledSyntheticBrowserResult> {
  const allowedOrigin = options.context.allowedOrigin;
  const loginUrl = `${allowedOrigin}/login`;
  const billingUrl = `${allowedOrigin}/billing`;
  assertExactOrigin(loginUrl, allowedOrigin);
  assertExactOrigin(billingUrl, allowedOrigin);

  const reference = sessionReference(options.context, options.target);
  const session = await loadSession(options.sessionVault, reference);
  const disposition = sessionDisposition(session);
  let browser: Browser | undefined;
  let browserContext: BrowserContext | undefined;

  try {
    if (options.signal.aborted) {
      throw new ControlledBrowserFailure("CHECK_FAILED");
    }
    browser = await options.launchBrowser();
    const contextOptions =
      session.state === "valid"
        ? {
            storageState: session.storageState,
            serviceWorkers: "block" as const,
          }
        : { serviceWorkers: "block" as const };
    browserContext = await browser.newContext(contextOptions);
    const boundary = new ExactOriginBrowserBoundary(
      browserContext,
      allowedOrigin,
    );
    await boundary.install();
    const page = await browserContext.newPage();
    boundary.attach(page);

    const abort = (): void => {
      void browser?.close().catch(() => undefined);
    };
    options.signal.addEventListener("abort", abort, { once: true });
    try {
      if (session.state === "valid") {
        try {
          await boundary.navigate(page, billingUrl);
          if (
            (await page
              .locator('[data-vaultscout-fixture="synthetic"]')
              .count()) === 1
          ) {
            const checkedAt = options.now.toISOString();
            boundary.assertSafe(page);
            const raw = await options.target.connector.extract(page, checkedAt);
            return {
              subscription: reconstructSubscription(
                raw,
                options.target,
                checkedAt,
              ),
              sessionDisposition: disposition,
            };
          }
        } catch (error) {
          if (error instanceof ControlledBrowserFailure) throw error;
          if (options.signal.aborted) {
            throw new ControlledBrowserFailure("CHECK_FAILED");
          }
          boundary.assertSafe(page);
        }
      }

      await boundary.navigate(page, loginUrl);
      await detectInteractiveBoundary(page);
      const { form, action } = await boundary.formAction(page);

      await options.context.usePasswordForObservedUrl(
        page.url(),
        async (password) => {
          try {
            boundary.assertSafe(page);
            const currentForm = await boundary.formAction(page);
            if (currentForm.action !== action) {
              throw new ControlledBrowserFailure("ORIGIN_MISMATCH");
            }
            const username = page.locator('input[name="username"]');
            const passwordInput = page.locator('input[name="password"]');
            if (
              (await username.count()) !== 1 ||
              (await passwordInput.count()) !== 1
            ) {
              throw new ControlledBrowserFailure("LOGIN_FAILED");
            }
            await username.fill(options.target.trustedUsername);
            boundary.assertSafe(page);
            await passwordInput.fill(password);
            boundary.assertSafe(page);
            const verifiedForm = await boundary.formAction(page);
            if (verifiedForm.action !== action) {
              throw new ControlledBrowserFailure("ORIGIN_MISMATCH");
            }
            await boundary.submit(page, verifiedForm.form, action);
          } catch (error) {
            throw new CredentialBackendFailure(
              options.signal.aborted
                ? "CANCELLED"
                : error instanceof ControlledBrowserFailure &&
                    error.code === "ORIGIN_MISMATCH"
                ? "ORIGIN_MISMATCH"
                : "CONSUMER_FAILED",
            );
          }
        },
        options.signal,
      );

      boundary.assertSafe(page);
      await detectInteractiveBoundary(page);
      if (
        new URL(page.url()).pathname !== "/billing" ||
        (await page
          .locator('[data-vaultscout-fixture="synthetic"]')
          .count()) !== 1
      ) {
        throw new ControlledBrowserFailure("LOGIN_FAILED");
      }

      boundary.assertSafe(page);
      const storageState = await browserContext.storageState({
        indexedDB: true,
      });
      boundary.assertSafe(page);
      await options.sessionVault.save(reference, {
        storageState,
        expiresAt: new Date(
          options.now.getTime() + options.target.sessionLifetimeMs,
        ),
      });

      boundary.assertSafe(page);
      const checkedAt = options.now.toISOString();
      let raw: unknown;
      try {
        raw = await options.target.connector.extract(page, checkedAt);
      } catch {
        throw new ControlledBrowserFailure("EXTRACTION_FAILED");
      }
      return {
        subscription: reconstructSubscription(
          raw,
          options.target,
          checkedAt,
        ),
        sessionDisposition: disposition,
      };
    } finally {
      options.signal.removeEventListener("abort", abort);
    }
  } catch (error) {
    if (error instanceof ControlledBrowserFailure) throw error;
    if (options.signal.aborted) {
      throw new ControlledBrowserFailure("CHECK_FAILED");
    }
    throw error;
  } finally {
    await browserContext?.close().catch(() => undefined);
    await browser?.close().catch(() => undefined);
  }
}
