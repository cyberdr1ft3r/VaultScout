import { execFile } from "node:child_process";
import { chmod, mkdir } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
let windowsUserSid: Promise<string> | undefined;

async function getWindowsUserSid(): Promise<string> {
  windowsUserSid ??= execFileAsync("whoami", ["/user", "/fo", "csv", "/nh"], {
    windowsHide: true,
  }).then(({ stdout }) => {
    const sid = stdout.match(/S-\d(?:-\d+)+/u)?.[0];
    if (!sid) {
      throw new Error("Unable to secure local data.");
    }
    return sid;
  });

  return windowsUserSid;
}

async function restrictWindowsAcl(path: string, directory: boolean): Promise<void> {
  const sid = await getWindowsUserSid();
  const permission = directory ? `*${sid}:(OI)(CI)F` : `*${sid}:F`;

  await execFileAsync("icacls", [path, "/inheritance:r", "/grant:r", permission], {
    windowsHide: true,
  });
}

export async function secureDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });

  if (process.platform === "win32") {
    await restrictWindowsAcl(path, true);
    return;
  }

  await chmod(path, 0o700);
}

export async function secureFile(path: string): Promise<void> {
  if (process.platform === "win32") {
    await restrictWindowsAcl(path, false);
    return;
  }

  await chmod(path, 0o600);
}
