/**
 * Test helper: a DKIM signer, so the verifier's tests sign fictional bank mail
 * with keys generated at test time. Not used by the app.
 *
 * It reuses dkim.ts's canonicalisation and header selection (both exercised
 * against fixed vectors in dkim.test.ts) but builds, folds and signs the
 * DKIM-Signature field itself, so the verifier's tag parsing, b= emptying and
 * signature check are tested against independently produced input.
 */

import { createHash, createPublicKey, sign, type KeyObject } from "node:crypto";
import { canonBody, canonHeader, splitMessage, selectHeaders, type Canon } from "./dkim.ts";

export type DkimAlgorithm = "rsa-sha256" | "ed25519-sha256";

const DEFAULT_HEADERS = ["from", "to", "subject", "date", "message-id", "mime-version", "content-type"];

export function signDkim(
  raw: string | Uint8Array,
  opts: {
    domain: string;
    selector: string;
    privateKey: KeyObject;
    algorithm?: DkimAlgorithm;
    canon?: "simple/simple" | "relaxed/relaxed" | "relaxed/simple";
    headers?: string[];
    /** Extra tags (e.g. `{ x: "1700000000", l: "10" }`) placed before bh=. */
    extraTags?: Record<string, string>;
  },
): Uint8Array {
  const algorithm = opts.algorithm ?? "rsa-sha256";
  const canon = opts.canon ?? "relaxed/relaxed";
  const [hc, bc] = canon.split("/") as [Canon, Canon];
  const { fields, body } = splitMessage(raw);
  const headerNames = opts.headers ?? DEFAULT_HEADERS.filter((n) => fields.some((f) => f.name.toLowerCase() === n));

  let cbody = canonBody(body, bc);
  if (opts.extraTags?.l !== undefined) cbody = cbody.slice(0, Number(opts.extraTags.l));
  const bh = createHash("sha256").update(cbody, "latin1").digest("base64");

  const extra = Object.entries(opts.extraTags ?? {}).map(([k, v]) => `${k}=${v}; `).join("");
  // Folded across lines on purpose: the verifier must cope with FWS in the tag list.
  const head =
    `DKIM-Signature: v=1; a=${algorithm}; c=${canon}; d=${opts.domain};\r\n` +
    `\ts=${opts.selector}; t=${Math.floor(Date.now() / 1000)}; ${extra}\r\n` +
    `\th=${headerNames.join(":")};\r\n` +
    `\tbh=${bh};\r\n\tb=`;

  let data = "";
  for (const f of selectHeaders(fields, headerNames)) data += canonHeader(f, hc);
  data += canonHeader({ name: "DKIM-Signature", raw: head }, hc).replace(/\r\n$/, "");
  const bytes = Buffer.from(data, "latin1");

  const sig = algorithm === "rsa-sha256"
    ? sign("sha256", bytes, opts.privateKey)
    : sign(null, createHash("sha256").update(bytes).digest(), opts.privateKey);
  const b = sig.toString("base64").replace(/.{1,64}/g, "$&\r\n\t ").replace(/\r\n\t $/, "");

  const message = fields.map((f) => f.raw + "\r\n").join("") + "\r\n" + body;
  return Buffer.from(head + b + "\r\n" + message, "latin1");
}

/** The TXT record text a domain would publish at `<selector>._domainkey.<domain>`. */
export function keyRecord(publicKey: KeyObject, algorithm: DkimAlgorithm = "rsa-sha256"): string {
  const pub = publicKey.type === "private" ? createPublicKey(publicKey) : publicKey;
  const spki = pub.export({ format: "der", type: "spki" });
  if (algorithm === "ed25519-sha256") {
    // RFC 8463 §4.2: only the raw 32-byte key, not the SPKI wrapper.
    return `v=DKIM1; k=ed25519; p=${spki.subarray(spki.length - 32).toString("base64")}`;
  }
  return `v=DKIM1; k=rsa; p=${spki.toString("base64")}`;
}
