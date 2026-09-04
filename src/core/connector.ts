import type { Subscription } from "./subscription.js";

export interface ConnectorContext {
  dataDirectory: string;
  headless: boolean;
}

export interface SubscriptionConnector {
  readonly id: string;
  readonly name: string;
  check(context: ConnectorContext): Promise<Subscription>;
}
