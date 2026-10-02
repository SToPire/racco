import type { FastifyInstance } from "fastify";
import type { IncomingHttpHeaders } from "node:http";

export const DEFAULT_ALLOWED_HOSTS = ["127.0.0.1", "localhost", "[::1]"];

function authorityUrl(
  host: string | undefined,
  protocol = "http:",
): URL | undefined {
  if (host === undefined || /[\s/\\?#@,]/.test(host)) return undefined;
  try {
    const url = new URL(`${protocol}//${host}`);
    return url.hostname ? url : undefined;
  } catch {
    return undefined;
  }
}

/** Config entries are exact hostnames/IPs, without a scheme, path or port. */
export function allowedHostname(value: string): string | undefined {
  if (!/^(?:[a-z0-9.-]+|\[[0-9a-f:]+\])$/i.test(value)) return undefined;
  const url = authorityUrl(value);
  if (url === undefined || url.hostname !== value.toLowerCase())
    return undefined;
  return url.hostname;
}

export function hasTrustedSource(
  headers: IncomingHttpHeaders,
  allowedHosts: ReadonlySet<string>,
): boolean {
  const requestHost = authorityUrl(headers.host);
  if (requestHost === undefined || !allowedHosts.has(requestHost.hostname))
    return false;
  if (headers["sec-fetch-site"] === "cross-site") return false;
  // Native clients and address-bar navigation may omit Origin. Host remains
  // mandatory; forwarded headers never broaden this independently trusted set.
  if (headers.origin === undefined) return true;
  try {
    const origin = new URL(headers.origin);
    if (
      !["http:", "https:"].includes(origin.protocol) ||
      origin.origin !== headers.origin
    )
      return false;
    return origin.host === authorityUrl(headers.host, origin.protocol)?.host;
  } catch {
    return false;
  }
}

/** Installed before every route/plugin, including static assets and upgrades. */
export function registerRequestBoundary(
  app: FastifyInstance,
  hosts: readonly string[],
): void {
  const allowedHosts = new Set(
    hosts.map((host) => {
      const normalized = allowedHostname(host);
      if (normalized === undefined)
        throw new Error(`Invalid allowed host: ${host}`);
      return normalized;
    }),
  );
  app.addHook("onRequest", async (request, reply) => {
    if (!hasTrustedSource(request.headers, allowedHosts)) {
      // This hook precedes the WebSocket plugin's own upgrade marker. Rejected
      // upgrades therefore cannot rely on that plugin's onResponse cleanup.
      if (request.headers.upgrade !== undefined)
        reply.raw.once("finish", () => request.raw.socket.destroy());
      return reply
        .code(403)
        .send({ message: "Request host or origin is not allowed" });
    }
  });
}
