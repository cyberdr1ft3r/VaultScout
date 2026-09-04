import type {
  PersistedCheck,
  PersistedSubscriptionState,
  ReauthenticationRequirement,
  SubscriptionHistoryRepository,
} from "../persistence/subscription-history.js";

const DAY_MILLISECONDS = 86_400_000;

export interface DashboardSubscription {
  providerId: string;
  providerName: string;
  accountLabel: string;
  planName: string;
  renewalDate: string;
  amountMinor: number;
  currency: string;
  billingCycle: PersistedSubscriptionState["billingCycle"];
  status: PersistedSubscriptionState["status"];
  checkedAt: string;
}

export interface DashboardCheck {
  id: number;
  providerId: string;
  providerName: string;
  accountLabel: string;
  checkedAt: string;
  outcome: PersistedCheck["outcome"];
  failureCode: PersistedCheck["failureCode"];
  subscription: DashboardSubscription | null;
}

export interface DashboardReauthentication {
  providerId: string;
  providerName: string;
  accountLabel: string;
  checkedAt: string;
  failureCode: ReauthenticationRequirement["failureCode"];
}

export interface DashboardSummary {
  asOf: string;
  activeSubscriptions: number;
  renewalsWithin7Days: number;
  renewalsWithin30Days: number;
  reauthenticationRequired: number;
  recentFailedChecks: number;
}

function accountLabel(accountReference: string): string {
  return `Local •${accountReference.slice(-4).toUpperCase()}`;
}

function utcDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function dateAfter(date: Date, days: number): string {
  return utcDate(new Date(date.getTime() + days * DAY_MILLISECONDS));
}

function recentFailureCutoff(date: Date): string {
  return new Date(date.getTime() - 7 * DAY_MILLISECONDS).toISOString();
}

function mapSubscription(
  subscription: PersistedSubscriptionState,
): DashboardSubscription {
  return {
    providerId: subscription.providerId,
    providerName: subscription.providerName,
    accountLabel: accountLabel(subscription.accountReference),
    planName: subscription.planName,
    renewalDate: subscription.renewalDate,
    amountMinor: subscription.amountMinor,
    currency: subscription.currency,
    billingCycle: subscription.billingCycle,
    status: subscription.status,
    checkedAt: subscription.checkedAt,
  };
}

function mapCheck(check: PersistedCheck): DashboardCheck {
  return {
    id: check.id,
    providerId: check.providerId,
    providerName: check.providerName,
    accountLabel: accountLabel(check.accountReference),
    checkedAt: check.checkedAt,
    outcome: check.outcome,
    failureCode: check.failureCode,
    subscription: check.subscription
      ? mapSubscription(check.subscription)
      : null,
  };
}

function mapReauthentication(
  requirement: ReauthenticationRequirement,
): DashboardReauthentication {
  return {
    providerId: requirement.providerId,
    providerName: requirement.providerName,
    accountLabel: accountLabel(requirement.accountReference),
    checkedAt: requirement.checkedAt,
    failureCode: requirement.failureCode,
  };
}

export async function getDashboardSummary(
  repository: SubscriptionHistoryRepository,
  now: Date,
): Promise<DashboardSummary> {
  const fromDate = utcDate(now);
  const [
    latest,
    within7Days,
    within30Days,
    reauthentication,
    recentFailures,
  ] = await Promise.all([
    repository.getLatestSubscriptionStates(),
    repository.getUpcomingRenewals({
      fromDate,
      throughDate: dateAfter(now, 7),
      limit: 1_000,
    }),
    repository.getUpcomingRenewals({
      fromDate,
      throughDate: dateAfter(now, 30),
      limit: 1_000,
    }),
    repository.getConnectorsRequiringReauthentication(),
    repository.getRecentFailedChecks({
      since: recentFailureCutoff(now),
      limit: 1_000,
    }),
  ]);

  return {
    asOf: now.toISOString(),
    activeSubscriptions: latest.filter(
      (subscription) => subscription.status === "active",
    ).length,
    renewalsWithin7Days: within7Days.length,
    renewalsWithin30Days: within30Days.length,
    reauthenticationRequired: reauthentication.length,
    recentFailedChecks: recentFailures.length,
  };
}

export async function getDashboardRenewals(
  repository: SubscriptionHistoryRepository,
  now: Date,
): Promise<{ asOf: string; renewals: DashboardSubscription[] }> {
  const renewals = await repository.getUpcomingRenewals({
    fromDate: utcDate(now),
    limit: 1_000,
  });
  return {
    asOf: now.toISOString(),
    renewals: renewals.map(mapSubscription),
  };
}

export async function getDashboardWarnings(
  repository: SubscriptionHistoryRepository,
  now: Date,
): Promise<{
  asOf: string;
  pastDue: DashboardSubscription[];
  reauthentication: DashboardReauthentication[];
  recentFailures: DashboardCheck[];
}> {
  const [latest, reauthentication, recentFailures] = await Promise.all([
    repository.getLatestSubscriptionStates(),
    repository.getConnectorsRequiringReauthentication(),
    repository.getRecentFailedChecks({
      since: recentFailureCutoff(now),
      limit: 100,
    }),
  ]);

  return {
    asOf: now.toISOString(),
    pastDue: latest
      .filter((subscription) => subscription.status === "past_due")
      .map(mapSubscription),
    reauthentication: reauthentication.map(mapReauthentication),
    recentFailures: recentFailures.map(mapCheck),
  };
}

export async function getDashboardHistory(
  repository: SubscriptionHistoryRepository,
): Promise<{ checks: DashboardCheck[] }> {
  const history = await repository.getCheckHistory({ limit: 200 });
  return { checks: history.map(mapCheck) };
}
