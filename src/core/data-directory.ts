import { resolve } from "node:path";
import { secureDirectory } from "./secure-filesystem.js";

export async function prepareDataDirectory(configuredPath = ".vaultscout"): Promise<string> {
  const directory = resolve(configuredPath);
  await secureDirectory(directory);

  return directory;
}
