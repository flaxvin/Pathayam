/**
 * FWD-1 · The signature on a forwarded message's hand-off from the mail
 * receiver (`src/mx`) to a household's app.
 *
 * The receiver is a separate process, and on the hosted service a separate
 * machine, so the app cannot take its word on the network alone: anybody who
 * can reach `/inbound/email` could otherwise post a "bank alert" into Review.
 * Each hand-off is signed with the household's `INBOUND_SECRET`:
 *
 *     X-Pathayam-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256>
 *
 * over `<t>.<recipient>.` followed by the raw message bytes. The recipient is
 * in the signed text so a message signed for one address cannot be replayed at
 * another; the time bounds a replay of the same one to five minutes, and the
 * import's own content-hash dedupe makes a replay inside that window a no-op.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

/** How far a signature's time may be from the app's clock, either way. */
export const SIGNATURE_TOLERANCE_SECONDS = 300;

export const SIGNATURE_HEADER = "x-pathayam-signature";
export const RECIPIENT_HEADER = "x-pathayam-recipient";

/** A message as one piece, or as the pieces the receiver holds it in (MAIL-8). */
export type MessageBytes = Uint8Array | readonly Uint8Array[];

function mac(secret: string, t: number, recipient: string, body: MessageBytes): Buffer {
  const h = createHmac("sha256", secret).update(`${t}.${recipient.toLowerCase()}.`);
  if (body instanceof Uint8Array) h.update(body);
  else for (const part of body) h.update(part);
  return h.digest();
}

/** The header value for a hand-off of `body` to `recipient`. */
export function signInbound(
  secret: string, recipient: string, body: MessageBytes, now: Date = new Date(),
): string {
  const t = Math.floor(now.getTime() / 1000);
  return `t=${t},v1=${mac(secret, t, recipient, body).toString("hex")}`;
}

/** The header's time and MAC when it has the right shape; null otherwise. */
function parse(header: string | null | undefined): { t: number; given: string } | null {
  if (!header || header.length > 200) return null;
  const parts = new Map(
    header.split(",").map((p) => {
      const i = p.indexOf("=");
      return [p.slice(0, i).trim(), p.slice(i + 1).trim()] as const;
    }),
  );
  const t = Number(parts.get("t"));
  const given = parts.get("v1") ?? "";
  if (!Number.isInteger(t) || !/^[0-9a-f]{64}$/.test(given)) return null;
  return { t, given };
}

function fresh(t: number, now: Date): boolean {
  return Math.abs(now.getTime() / 1000 - t) <= SIGNATURE_TOLERANCE_SECONDS;
}

/**
 * MAIL-7 · Whether `header` could be a valid signature at all: present, well
 * formed and inside the time window. It needs neither the secret nor the body,
 * so the app can turn away a hand-off that cannot pass before reading it.
 */
export function signatureLooksFresh(header: string | null | undefined, now: Date = new Date()): boolean {
  const parsed = parse(header);
  return parsed !== null && fresh(parsed.t, now);
}

/** Whether `header` is a fresh, valid signature for this hand-off. Never throws. */
export function verifyInbound(
  secret: string, header: string | null | undefined, recipient: string, body: MessageBytes,
  now: Date = new Date(),
): boolean {
  if (!secret) return false;
  const parsed = parse(header);
  if (!parsed || !fresh(parsed.t, now)) return false;
  return timingSafeEqual(mac(secret, parsed.t, recipient, body), Buffer.from(parsed.given, "hex"));
}

/*
 * MAIL-9 · The receiver's question at RCPT time: is this address in use?
 * Signed with the same secret over `check.<t>.<recipient>.` and no body. A
 * hand-off's signed text starts with the time's digits, so neither signature
 * can stand in for the other.
 */
function checkMac(secret: string, t: number, recipient: string): Buffer {
  return createHmac("sha256", secret).update(`check.${t}.${recipient.toLowerCase()}.`).digest();
}

/** The header value for asking whether `recipient` is in use. */
export function signInboundCheck(secret: string, recipient: string, now: Date = new Date()): string {
  const t = Math.floor(now.getTime() / 1000);
  return `t=${t},v1=${checkMac(secret, t, recipient).toString("hex")}`;
}

/** Whether `header` is a fresh, valid signature for asking about `recipient`. Never throws. */
export function verifyInboundCheck(
  secret: string, header: string | null | undefined, recipient: string, now: Date = new Date(),
): boolean {
  if (!secret) return false;
  const parsed = parse(header);
  if (!parsed || !fresh(parsed.t, now)) return false;
  return timingSafeEqual(checkMac(secret, parsed.t, recipient), Buffer.from(parsed.given, "hex"));
}
