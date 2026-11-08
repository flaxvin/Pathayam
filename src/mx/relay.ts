/**
 * FWD-2 · From an SMTP recipient to a household's app: which app an address
 * belongs to, and the signed HTTPS hand-off of the message to it.
 *
 * Addresses are `<route>.<token>@<MX_DOMAIN>`. The route names an app (one per
 * hosted household, or the empty route for a self-hosted one whose addresses
 * are just `<token>`); the token is the app's business, so whether it is valid
 * is only known from the app's answer to the hand-off.
 */

import { signInbound, SIGNATURE_HEADER, RECIPIENT_HEADER } from "../mail/signature.ts";
import type { SmtpReply } from "./smtp.ts";

export type Route = { url: string; secret: string };

/** How long the app has to answer a hand-off before the sender is told to retry. */
export const RELAY_TIMEOUT_MS = 30_000;

const NAME = /^[a-z0-9]+$/;

/**
 * Hosts that may be reached over plain http: this machine, or a docker compose
 * service name (no dots), where the hop never leaves the host's own network.
 */
function plainHttpAllowed(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]"
    || (hostname.length > 0 && !hostname.includes(".") && !hostname.includes(":") && !hostname.startsWith("["));
}

/** Parses `MX_ROUTES`. Throws an Error that says what is wrong, without echoing secrets. */
export function parseRoutes(json: string | undefined): Map<string, Route> {
  if (!json || !json.trim()) throw new Error('MX_ROUTES is not set; expected JSON like {"": {"url": "https://…", "secret": "…"}}');
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch (err) {
    throw new Error(`MX_ROUTES is not valid JSON: ${(err as Error).message}`);
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new Error("MX_ROUTES must be a JSON object mapping route names to {url, secret}");
  }
  const routes = new Map<string, Route>();
  for (const [rawName, value] of Object.entries(data)) {
    const name = rawName.toLowerCase();
    const label = rawName === "" ? 'MX_ROUTES[""]' : `MX_ROUTES["${rawName}"]`;
    if (name !== "" && !NAME.test(name)) throw new Error(`${label}: a route name must be letters and digits only`);
    if (routes.has(name)) throw new Error(`${label}: route is listed twice (names are case-insensitive)`);
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error(`${label} must be an object with url and secret`);
    }
    const { url, secret } = value as Record<string, unknown>;
    if (typeof secret !== "string" || secret.trim() === "") throw new Error(`${label}.secret must be a non-empty string`);
    if (typeof url !== "string") throw new Error(`${label}.url must be a string`);
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error(`${label}.url is not a valid URL`);
    }
    if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && plainHttpAllowed(parsed.hostname))) {
      throw new Error(`${label}.url must use https (plain http only for localhost or a compose service name)`);
    }
    if (parsed.username || parsed.password || parsed.search || parsed.hash) {
      throw new Error(`${label}.url must not carry credentials, a query or a fragment`);
    }
    routes.set(name, { url: `${parsed.origin}${parsed.pathname.replace(/\/+$/, "")}`, secret });
  }
  if (routes.size === 0) throw new Error("MX_ROUTES has no routes");
  return routes;
}

/**
 * Maps an RCPT TO address to its route and the canonical recipient the app is
 * told about: lowercased, with any `+tag` dropped. Anything else is an SMTP
 * refusal to give at RCPT time.
 */
export function resolveRecipient(
  address: string, domain: string, routes: Map<string, Route>,
): { recipient: string; route: Route } | SmtpReply {
  const at = address.lastIndexOf("@");
  if (at <= 0) return { code: 550, message: "5.1.3 Bad recipient address syntax" };
  const host = address.slice(at + 1).toLowerCase().replace(/\.$/, "");
  if (host !== domain.toLowerCase()) return { code: 550, message: "5.7.1 Relay access denied" };
  const local = address.slice(0, at).toLowerCase().split("+")[0] ?? "";
  const dot = local.indexOf(".");
  const routeName = dot < 0 ? "" : local.slice(0, dot);
  const token = dot < 0 ? local : local.slice(dot + 1);
  const route = routes.get(routeName);
  if (!NAME.test(token) || (routeName !== "" && !NAME.test(routeName)) || !route) {
    return { code: 550, message: "5.1.1 No such user here" };
  }
  return { recipient: `${local}@${domain.toLowerCase()}`, route };
}

/**
 * POSTs one message to its app and turns the answer into the SMTP reply for
 * that recipient. Never throws: a failure the sender can retry is a 451.
 */
export async function relayMessage(
  route: Route, recipient: string, raw: Uint8Array,
  fetchImpl: typeof fetch = fetch, now: Date = new Date(),
): Promise<SmtpReply> {
  let status: number;
  try {
    const res = await fetchImpl(`${route.url}/inbound/email`, {
      method: "POST",
      headers: {
        "content-type": "message/rfc822",
        [RECIPIENT_HEADER]: recipient,
        [SIGNATURE_HEADER]: signInbound(route.secret, recipient, raw, now),
      },
      body: raw,
      // A redirect would re-send the message somewhere unsigned-for; treat it as an answer.
      redirect: "manual",
      signal: AbortSignal.timeout(RELAY_TIMEOUT_MS),
    });
    status = res.status;
    try {
      await res.body?.cancel();
    } catch {
      // Nothing to read; the status is the answer.
    }
  } catch (err) {
    const reason = (err as Error)?.name === "TimeoutError" ? "timed out" : "unreachable";
    return { code: 451, message: `4.3.0 Mailbox service ${reason}, try again later` };
  }
  if (status === 202) return { code: 250, message: "2.0.0 OK" };
  if (status === 404) return { code: 550, message: "5.1.1 No such user here" };
  if (status === 413) return { code: 552, message: "5.3.4 Message too big for this mailbox" };
  // The app refused our request itself: a configuration error (wrong secret, clock, URL).
  if (status === 400 || status === 401 || status === 403) {
    return { code: 554, message: `5.3.0 Mailbox service refused the message (HTTP ${status})` };
  }
  // 429, 5xx and anything unexpected: the sender keeps the message and retries.
  return { code: 451, message: `4.3.0 Mailbox service unavailable (HTTP ${status}), try again later` };
}
