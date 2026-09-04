#!/usr/bin/env node
import { Command, InvalidArgumentError } from "commander";
import { demoConnector } from "./connectors/demo.js";
import { prepareDataDirectory } from "./core/data-directory.js";
import { formatSubscription } from "./core/subscription.js";
import {
  isLoopbackHost,
  startDashboardServer,
} from "./dashboard/server.js";
import { openSubscriptionHistory } from "./persistence/subscription-history.js";

const connectors = new Map([[demoConnector.id, demoConnector]]);
const program = new Command();

program.name("subwatch").description("Check subscription renewal details locally.");

function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new InvalidArgumentError("Port must be an integer from 0 to 65535.");
  }
  return port;
}

program
  .command("check")
  .argument("<provider>", "connector identifier")
  .action(async (provider: string) => {
    const connector = connectors.get(provider);
    if (!connector) {
      throw new Error(`Unknown connector: ${provider}`);
    }

    const dataDirectory = await prepareDataDirectory(process.env.SUBWATCH_DATA_DIR);
    const result = await connector.check({
      dataDirectory,
      headless: process.env.SUBWATCH_HEADLESS !== "false",
    });

    console.log(formatSubscription(result));
  });

program
  .command("dashboard")
  .description("Start the read-only local renewal dashboard.")
  .option("--host <host>", "address to bind", "127.0.0.1")
  .option("--port <port>", "port to bind", parsePort, 4173)
  .option(
    "--allow-non-loopback",
    "explicitly allow exposure beyond this machine",
    false,
  )
  .action(
    async (options: {
      host: string;
      port: number;
      allowNonLoopback: boolean;
    }) => {
      const dataDirectory = await prepareDataDirectory(
        process.env.SUBWATCH_DATA_DIR,
      );
      const repository = await openSubscriptionHistory(dataDirectory);
      let dashboard;

      try {
        dashboard = await startDashboardServer({
          repository,
          host: options.host,
          port: options.port,
          allowNonLoopback: options.allowNonLoopback,
        });
      } catch (error) {
        await repository.close().catch(() => undefined);
        throw error;
      }

      if (!isLoopbackHost(options.host)) {
        console.warn(
          "Warning: the dashboard is exposed beyond this machine. Use a trusted network only.",
        );
      }
      console.log(`SubWatch dashboard: ${dashboard.origin}`);

      let closing = false;
      const close = (): void => {
        if (closing) {
          return;
        }
        closing = true;
        void dashboard
          .close()
          .then(() => repository.close())
          .catch(() => {
            process.exitCode = 1;
          });
      };
      process.once("SIGINT", close);
      process.once("SIGTERM", close);
    },
  );

await program.parseAsync();
