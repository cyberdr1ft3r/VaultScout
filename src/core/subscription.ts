import { z } from "zod";

export const subscriptionSchema = z.object({
  providerId: z.string().min(1),
  providerName: z.string().min(1),
  planName: z.string().min(1),
  renewalDate: z.iso.date(),
  amountMinor: z.number().int().nonnegative(),
  currency: z.string().length(3).transform((value) => value.toUpperCase()),
  billingCycle: z.enum(["monthly", "quarterly", "yearly", "unknown"]),
  status: z.enum(["active", "trial", "past_due", "cancelled", "unknown"]),
  checkedAt: z.iso.datetime(),
});

export type Subscription = z.infer<typeof subscriptionSchema>;

export function formatSubscription(subscription: Subscription): string {
  const amount = new Intl.NumberFormat("en", {
    style: "currency",
    currency: subscription.currency,
  }).format(subscription.amountMinor / 100);

  return `${subscription.providerName}: renews ${subscription.renewalDate} — ${amount} (${subscription.status})`;
}
