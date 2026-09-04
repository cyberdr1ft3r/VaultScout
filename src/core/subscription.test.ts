import { describe, expect, it } from "vitest";
import { formatSubscription, subscriptionSchema } from "./subscription.js";

describe("subscription", () => {
  it("normalizes currency and formats the renewal summary", () => {
    const subscription = subscriptionSchema.parse({
      providerId: "demo",
      providerName: "Demo Cloud",
      planName: "Starter",
      renewalDate: "2026-10-01",
      amountMinor: 999,
      currency: "eur",
      billingCycle: "monthly",
      status: "active",
      checkedAt: "2026-09-04T12:00:00.000Z",
    });

    expect(subscription.currency).toBe("EUR");
    expect(formatSubscription(subscription)).toBe(
      "Demo Cloud: renews 2026-10-01 — €9.99 (active)",
    );
  });

  it("rejects negative prices", () => {
    expect(() =>
      subscriptionSchema.parse({
        providerId: "demo",
        providerName: "Demo Cloud",
        planName: "Starter",
        renewalDate: "2026-10-01",
        amountMinor: -1,
        currency: "EUR",
        billingCycle: "monthly",
        status: "active",
        checkedAt: "2026-09-04T12:00:00.000Z",
      }),
    ).toThrow();
  });
});
