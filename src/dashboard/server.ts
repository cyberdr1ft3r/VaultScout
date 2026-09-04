import { createServer, type ServerResponse } from "node:http";
import { isIP } from "node:net";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { SubscriptionHistoryRepository } from "../persistence/subscription-history.js";
import {
  getDashboardHistory,
  getDashboardRenewals,
  getDashboardSummary,
  getDashboardWarnings,
} from "./view-model.js";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 4173;
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);
const assetDirectory = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "assets",
);

const assets = new Map([
  ["/", { filename: "index.html", contentType: "text/html; charset=utf-8" }],
  [
    "/styles.css",
    { filename: "styles.css", contentType: "text/css; charset=utf-8" },
  ],
  [
    "/app.js",
    { filename: "app.js", contentType: "text/javascript; charset=utf-8" },
  ],
]);

const securityHeaders = {
  "Cache-Control": "no-store",
  "Content-Security-Policy":
    "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; font-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
} as const;

export type DashboardServerErrorCode =
  | "INVALID_SERVER_OPTIONS"
  | "UNSAFE_BIND_ADDRESS"
  | "SERVER_START_FAILED";

export class DashboardServerError extends Error {
  constructor(readonly code: DashboardServerErrorCode, message: string) {
    super(message);
    this.name = "DashboardServerError";
  }
}

export interface DashboardServerOptions {
  repository: SubscriptionHistoryRepository;
  host?: string;
  port?: number;
  allowNonLoopback?: boolean;
  now?: () => Date;
}

export interface DashboardServer {
  host: string;
  port: number;
  origin: string;
  close(): Promise<void>;
}

function normalizedHostname(hostname: string): string {
  const lower = hostname.toLowerCase();
  return lower.startsWith("[") && lower.endsWith("]")
    ? lower.slice(1, -1)
    : lower;
}

export function isLoopbackHost(hostname: string): boolean {
  const normalized = normalizedHostname(hostname);
  if (LOOPBACK_HOSTS.has(normalized)) {
    return true;
  }
  return isIP(normalized) === 4 && normalized.startsWith("127.");
}

function isValidBindHost(hostname: string): boolean {
  if (hostname.length === 0 || hostname.length > 253) {
    return false;
  }
  if (isIP(hostname) !== 0) {
    return true;
  }
  return /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/iu.test(
    hostname,
  );
}

function allowedRequestHost(
  hostHeader: string | undefined,
  configuredHost: string,
): boolean {
  if (
    !hostHeader ||
    hostHeader.length > 300 ||
    /[\s/@,\\]/u.test(hostHeader)
  ) {
    return false;
  }

  try {
    const parsed = new URL(`http://${hostHeader}`);
    const hostname = normalizedHostname(parsed.hostname);
    return (
      isLoopbackHost(hostname) ||
      hostname === normalizedHostname(configuredHost)
    );
  } catch {
    return false;
  }
}

function setSecurityHeaders(response: ServerResponse): void {
  for (const [name, value] of Object.entries(securityHeaders)) {
    response.setHeader(name, value);
  }
}

function sendJson(
  response: ServerResponse,
  status: number,
  body: unknown,
): void {
  const serialized = JSON.stringify(body);
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Content-Length", Buffer.byteLength(serialized));
  response.end(serialized);
}

function sendApiError(
  response: ServerResponse,
  status: number,
  code: string,
  message: string,
): void {
  sendJson(response, status, { error: { code, message } });
}

async function serveAsset(
  pathname: string,
  response: ServerResponse,
): Promise<boolean> {
  const asset = assets.get(pathname);
  if (!asset) {
    return false;
  }

  const path = resolve(assetDirectory, asset.filename);
  if (dirname(path) !== assetDirectory) {
    throw new Error("Invalid dashboard asset.");
  }
  const contents = await readFile(path);
  response.statusCode = 200;
  response.setHeader("Content-Type", asset.contentType);
  response.setHeader("Content-Length", contents.length);
  response.end(contents);
  return true;
}

async function handleApi(
  pathname: string,
  repository: SubscriptionHistoryRepository,
  now: Date,
  response: ServerResponse,
): Promise<boolean> {
  switch (pathname) {
    case "/api/summary":
      sendJson(response, 200, await getDashboardSummary(repository, now));
      return true;
    case "/api/renewals":
      sendJson(response, 200, await getDashboardRenewals(repository, now));
      return true;
    case "/api/warnings":
      sendJson(response, 200, await getDashboardWarnings(repository, now));
      return true;
    case "/api/history":
      sendJson(response, 200, await getDashboardHistory(repository));
      return true;
    default:
      return false;
  }
}

function formatOrigin(host: string, port: number): string {
  const formattedHost = isIP(host) === 6 ? `[${host}]` : host;
  return `http://${formattedHost}:${port}`;
}

export async function startDashboardServer(
  options: DashboardServerOptions,
): Promise<DashboardServer> {
  const host = options.host ?? DEFAULT_HOST;
  const port = options.port ?? DEFAULT_PORT;

  if (
    !isValidBindHost(host) ||
    !Number.isInteger(port) ||
    port < 0 ||
    port > 65_535
  ) {
    throw new DashboardServerError(
      "INVALID_SERVER_OPTIONS",
      "The dashboard server options are invalid.",
    );
  }
  if (!isLoopbackHost(host) && options.allowNonLoopback !== true) {
    throw new DashboardServerError(
      "UNSAFE_BIND_ADDRESS",
      "Non-loopback dashboard binding requires explicit opt-in.",
    );
  }

  const server = createServer((request, response) => {
    setSecurityHeaders(response);
    void (async () => {
      if (!allowedRequestHost(request.headers.host, host)) {
        sendApiError(
          response,
          421,
          "UNSAFE_HOST",
          "Request host is not allowed.",
        );
        return;
      }
      if (request.method !== "GET") {
        response.setHeader("Allow", "GET");
        sendApiError(
          response,
          405,
          "READ_ONLY_ENDPOINT",
          "Dashboard endpoints are read-only.",
        );
        return;
      }

      const pathname = new URL(
        request.url ?? "/",
        "http://dashboard.local",
      ).pathname;
      const now = options.now?.() ?? new Date();

      try {
        if (
          pathname.startsWith("/api/") &&
          (await handleApi(pathname, options.repository, now, response))
        ) {
          return;
        }
        if (await serveAsset(pathname, response)) {
          return;
        }
        sendApiError(
          response,
          404,
          "NOT_FOUND",
          "The dashboard resource was not found.",
        );
      } catch {
        if (response.headersSent) {
          response.destroy();
          return;
        }
        sendApiError(
          response,
          500,
          pathname.startsWith("/api/")
            ? "DASHBOARD_DATA_UNAVAILABLE"
            : "DASHBOARD_ASSET_UNAVAILABLE",
          pathname.startsWith("/api/")
            ? "Dashboard data is temporarily unavailable."
            : "The dashboard interface is temporarily unavailable.",
        );
      }
    })();
  });

  try {
    await new Promise<void>((resolvePromise, rejectPromise) => {
      server.once("error", rejectPromise);
      server.listen(port, host, () => {
        server.off("error", rejectPromise);
        resolvePromise();
      });
    });
  } catch {
    throw new DashboardServerError(
      "SERVER_START_FAILED",
      "The dashboard server could not be started.",
    );
  }

  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new DashboardServerError(
      "SERVER_START_FAILED",
      "The dashboard server could not be started.",
    );
  }

  return {
    host,
    port: address.port,
    origin: formatOrigin(host, address.port),
    async close() {
      await new Promise<void>((resolvePromise, rejectPromise) => {
        server.close((error) =>
          error ? rejectPromise(error) : resolvePromise(),
        );
      }).catch(() => {
        throw new DashboardServerError(
          "SERVER_START_FAILED",
          "The dashboard server could not be stopped.",
        );
      });
    },
  };
}
