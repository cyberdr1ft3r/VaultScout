import { chmod, mkdir } from "node:fs/promises";
import { resolve } from "node:path";

export async function prepareDataDirectory(configuredPath = ".subwatch"): Promise<string> {
  const directory = resolve(configuredPath);
  await mkdir(directory, { recursive: true, mode: 0o700 });

  if (process.platform !== "win32") {
    await chmod(directory, 0o700);
  }

  return directory;
}
