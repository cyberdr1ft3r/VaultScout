import type { SubscriptionConnector } from "../core/connector.js";
import { subscriptionSchema } from "../core/subscription.js";

export const demoConnector: SubscriptionConnector = {
  id: "demo",
  name: "Demo Cloud",
  async check() {
    return subscriptionSchema.parse({
      providerId: "demo",
      providerName: "Demo Cloud",
      planName: "Starter",
      renewalDate: "2026-10-01",
      amountMinor: 999,
      currency: "EUR",
      billingCycle: "monthly",
      status: "active",
      checkedAt: new Date().toISOString(),
    });
  },
};
