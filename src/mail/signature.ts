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

function mac(secret: string, t: number, recipient: string, body: Uint8Array): Buffer {
  return createHmac("sha256", secret)
    .update(`${t}.${recipient.toLowerCase()}.`)
    .update(body)
    .digest();
}

/** The header value for a hand-off of `body` to `recipient`. */
export function signInbound(
  secret: string, recipient: string, body: Uint8Array, now: Date = new Date(),
): string {
  const t = Math.floor(now.getTime() / 1000);
  return `t=${t},v1=${mac(secret, t, recipient, body).toString("hex")}`;
}

/** Whether `header` is a fresh, valid signature for this hand-off. Never throws. */
export function verifyInbound(
  secret: string, header: string | null | undefined, recipient: string, body: Uint8Array,
  now: Date = new Date(),
): boolean {
  if (!secret || !header) return false;
  const parts = new Map(
    header.split(",").map((p) => {
      const i = p.indexOf("=");
      return [p.slice(0, i).trim(), p.slice(i + 1).trim()] as const;
    }),
  );
  const t = Number(parts.get("t"));
  const given = parts.get("v1") ?? "";
  if (!Number.isInteger(t) || !/^[0-9a-f]{64}$/.test(given)) return false;
  if (Math.abs(now.getTime() / 1000 - t) > SIGNATURE_TOLERANCE_SECONDS) return false;
  return timingSafeEqual(mac(secret, t, recipient, body), Buffer.from(given, "hex"));
}
