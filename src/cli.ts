#!/usr/bin/env node
import { Command } from "commander";
import { demoConnector } from "./connectors/demo.js";
import { prepareDataDirectory } from "./core/data-directory.js";
import { formatSubscription } from "./core/subscription.js";

const connectors = new Map([[demoConnector.id, demoConnector]]);
const program = new Command();

program.name("subwatch").description("Check subscription renewal details locally.");

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

await program.parseAsync();
