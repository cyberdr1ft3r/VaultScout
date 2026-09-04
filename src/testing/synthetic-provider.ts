import type { Page } from "playwright";
import { subscriptionSchema, type Subscription } from "../core/subscription.js";
import { FixtureHarnessError } from "./connector-fixture.js";

async function fieldText(page: Page, field: string): Promise<string> {
  const locator = page.locator(`[data-field="${field}"]`);
  if ((await locator.count()) !== 1) {
    throw new Error("Missing synthetic field.");
  }
  const value = await locator.textContent();
  if (!value?.trim()) {
    throw new Error("Missing synthetic field.");
  }
  return value.trim();
}

function amountInMinorUnits(value: string): number {
  const match = /^([A-Z]{3}) ([0-9]+)\.([0-9]{2})$/u.exec(value);
  if (!match) {
    throw new Error("Invalid synthetic amount.");
  }
  const major = match[2];
  const minor = match[3];
  if (!major || !minor) {
    throw new Error("Invalid synthetic amount.");
  }
  return Number.parseInt(major, 10) * 100 + Number.parseInt(minor, 10);
}

export async function extractSyntheticSubscription(
  page: Page,
  checkedAt: string,
): Promise<Subscription> {
  try {
    const amount = await fieldText(page, "amount");
    const currency = amount.slice(0, 3);

    return subscriptionSchema.parse({
      providerId: await fieldText(page, "provider-id"),
      providerName: await fieldText(page, "provider-name"),
      planName: await fieldText(page, "plan-name"),
      renewalDate: await fieldText(page, "renewal-date"),
      amountMinor: amountInMinorUnits(amount),
      currency,
      billingCycle: await fieldText(page, "billing-cycle"),
      status: await fieldText(page, "status"),
      checkedAt,
    });
  } catch {
    throw new FixtureHarnessError(
      "CONNECTOR_EXTRACTION_FAILED",
      "The connector could not extract subscription details.",
    );
  }
}
