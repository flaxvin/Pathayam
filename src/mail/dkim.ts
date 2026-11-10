/**
 * FWD-3 · DKIM verification (RFC 6376, RFC 8463, RFC 8301) for forwarded
 * bank mail.
 *
 * A forwarded alert is only as trustworthy as the bank's own signature on it.
 * Gmail auto-forwarding keeps the original header block and body byte for
 * byte and adds its own fields (Received, ARC-*, X-Forwarded-To) on top; those
 * are not in the bank's h= list, so the bank's signature still verifies.
 *
 * Canonicalisation works on a latin1 string of the raw bytes (one char per
 * octet), so 8-bit bodies hash exactly as sent. Nothing here throws: every
 * problem becomes a result with a reason.
 */

import { createHash, createPublicKey, verify, type KeyObject } from "node:crypto";
import { promises as dns } from "node:dns";

export type TxtResolver = (name: string) => Promise<string[][]>;
export interface DkimResult {
  domain: string;
  selector: string;
  result: "pass" | "fail" | "temperror" | "permerror";
  reason?: string;
  /**
   * MAIL-1 · The signature's l= stopped short of the body: what follows was
   * not signed, and anybody holding the message may have added it.
   */
  partialBody?: true;
}

export type Canon = "simple" | "relaxed";

/** One header field: its name and its exact text, folding kept, final CRLF dropped. */
export interface HeaderField { name: string; raw: string }

/** Ed25519 SubjectPublicKeyInfo prefix; DKIM key records carry only the raw 32 bytes (RFC 8463 §4.2). */
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

/**
 * Split a message into header fields and body. Bare LF line ends are turned
 * into CRLF first: DKIM is defined over the wire form, and mail that went
 * through a Unix mailbox often lost its CRs.
 */
export function splitMessage(raw: Uint8Array | string): { fields: HeaderField[]; body: string } {
  const s0 = typeof raw === "string" ? raw : Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength).toString("latin1");
  const s = s0.replace(/\r?\n/g, "\r\n");
  const fields: HeaderField[] = [];
  let pos = 0;
  while (pos < s.length) {
    let end = s.indexOf("\r\n", pos);
    if (end === -1) end = s.length;
    const line = s.slice(pos, end);
    const next = Math.min(end + 2, s.length);
    if (line === "") return { fields, body: s.slice(next) };
    const last = fields[fields.length - 1];
    if ((line[0] === " " || line[0] === "\t") && last) {
      last.raw += "\r\n" + line;
    } else {
      const colon = line.indexOf(":");
      if (colon <= 0) return { fields, body: s.slice(pos) }; // header block ended without a blank line
      fields.push({ name: line.slice(0, colon).replace(/[ \t]+$/, ""), raw: line });
    }
    pos = next;
  }
  return { fields, body: "" };
}

/** RFC 6376 §3.4.1 / §3.4.2, with the trailing CRLF added. */
export function canonHeader(field: HeaderField, mode: Canon): string {
  if (mode === "simple") return field.raw + "\r\n";
  const colon = field.raw.indexOf(":");
  const name = field.raw.slice(0, colon).trim().toLowerCase();
  const value = field.raw
    .slice(colon + 1)
    .replace(/\r\n/g, "")
    .replace(/[ \t]+/g, " ")
    .trim();
  return `${name}:${value}\r\n`;
}

/** RFC 6376 §3.4.3 / §3.4.4. A relaxed empty body is empty; a simple one is a lone CRLF. */
export function canonBody(body: string, mode: Canon): string {
  if (mode === "simple") {
    const b = body.replace(/(\r\n)*$/, "");
    return b + "\r\n";
  }
  const lines = body.split("\r\n").map((l) => l.replace(/[ \t]+/g, " ").replace(/ $/, ""));
  let text = lines.join("\r\n").replace(/(\r\n)*$/, "");
  if (text !== "") text += "\r\n";
  return text;
}

/**
 * The fields h= names, picked bottom-up (RFC 6376 §5.4.2): each repeat of a
 * name takes the next instance up. A name with no instance left (over-signing)
 * contributes nothing.
 */
export function selectHeaders(fields: HeaderField[], names: string[]): HeaderField[] {
  const used = new Set<number>();
  const out: HeaderField[] = [];
  for (const n of names) {
    const want = n.trim().toLowerCase();
    for (let i = fields.length - 1; i >= 0; i--) {
      if (!used.has(i) && fields[i]!.name.toLowerCase() === want) {
        used.add(i);
        out.push(fields[i]!);
        break;
      }
    }
  }
  return out;
}

/** The signature field with its b= value (and surrounding whitespace) emptied, per §3.5. */
export function withEmptyB(field: HeaderField): HeaderField {
  const colon = field.raw.indexOf(":");
  const value = field.raw.slice(colon + 1).replace(/(^|;)([ \t\r\n]*b[ \t\r\n]*=)[^;]*/, "$1$2");
  return { name: field.name, raw: field.raw.slice(0, colon + 1) + value };
}

/** The exact bytes a DKIM signature covers: selected headers, then the signature field without CRLF. */
export function signedHeaderData(selected: HeaderField[], sigField: HeaderField, mode: Canon): Buffer {
  let s = "";
  for (const f of selected) s += canonHeader(f, mode);
  s += canonHeader(withEmptyB(sigField), mode).replace(/\r\n$/, "");
  return Buffer.from(s, "latin1");
}

/** RFC 6376 §3.2 tag list. Returns null on a malformed list or a repeated tag. */
export function parseTags(value: string): Map<string, string> | null {
  const tags = new Map<string, string>();
  for (const spec of value.split(";")) {
    if (/^[ \t\r\n]*$/.test(spec)) continue; // a trailing ";" is allowed
    const eq = spec.indexOf("=");
    if (eq === -1) return null;
    const name = spec.slice(0, eq).trim();
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(name) || tags.has(name)) return null;
    tags.set(name, spec.slice(eq + 1).replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, ""));
  }
  return tags;
}

function b64(v: string): Buffer {
  return Buffer.from(v.replace(/[ \t\r\n]/g, ""), "base64");
}

export async function verifyDkim(raw: Uint8Array, resolve?: TxtResolver, now?: Date): Promise<DkimResult[]> {
  try {
    const { fields, body } = splitMessage(raw);
    const lookup = resolve ?? ((name: string) => dns.resolveTxt(name));
    const at = now ?? new Date();
    const results: DkimResult[] = [];
    for (const f of fields) {
      if (f.name.toLowerCase() !== "dkim-signature") continue;
      results.push(await verifyOne(f, fields, body, lookup, at));
    }
    return results;
  } catch {
    return [];
  }
}

async function verifyOne(
  sig: HeaderField, fields: HeaderField[], body: string, resolve: TxtResolver, now: Date,
): Promise<DkimResult> {
  let domain = "";
  let selector = "";
  const res = (result: DkimResult["result"], reason?: string): DkimResult =>
    reason === undefined ? { domain, selector, result } : { domain, selector, result, reason };
  try {
    const tags = parseTags(sig.raw.slice(sig.raw.indexOf(":") + 1));
    if (!tags) return res("permerror", "bad tag list");
    domain = (tags.get("d") ?? "").toLowerCase().replace(/\.$/, "");
    selector = (tags.get("s") ?? "").toLowerCase();
    for (const t of ["v", "a", "b", "bh", "d", "h", "s"]) {
      if (!tags.get(t)) return res("permerror", `missing ${t}=`);
    }
    if (tags.get("v") !== "1") return res("permerror", "unsupported version");

    const alg = tags.get("a")!.toLowerCase();
    if (alg === "rsa-sha1") return res("permerror", "sha1 not accepted"); // RFC 8301 §3.1
    if (alg !== "rsa-sha256" && alg !== "ed25519-sha256") return res("permerror", `unsupported algorithm ${alg}`);

    // c= "relaxed" alone means relaxed headers, simple body (§3.5).
    const [hc = "simple", bc = "simple"] = (tags.get("c") ?? "simple/simple").toLowerCase().split("/");
    if ((hc !== "simple" && hc !== "relaxed") || (bc !== "simple" && bc !== "relaxed")) {
      return res("permerror", "unsupported canonicalization");
    }

    const h = tags.get("h")!.split(":").map((n) => n.replace(/[ \t\r\n]/g, "").toLowerCase());
    if (!h.includes("from")) return res("permerror", "From not signed"); // §5.4

    const i = tags.get("i");
    if (i !== undefined) {
      const idom = i.slice(i.lastIndexOf("@") + 1).toLowerCase();
      if (idom !== domain && !idom.endsWith("." + domain)) return res("permerror", "i= not within d=");
    }

    const t = tags.get("t");
    const x = tags.get("x");
    if (x !== undefined) {
      if (!/^\d+$/.test(x)) return res("permerror", "bad x=");
      if (t !== undefined && /^\d+$/.test(t) && Number(x) < Number(t)) return res("permerror", "x= before t=");
      if (Number(x) * 1000 < now.getTime()) return res("fail", "signature expired");
    }

    // Key record first: a missing key is the more useful reason than a body mismatch.
    const key = await fetchKey(resolve, `${selector}._domainkey.${domain}`, alg);
    if ("error" in key) return res(key.error, key.reason);

    let cbody = canonBody(body, bc);
    let partialBody = false;
    const l = tags.get("l");
    if (l !== undefined) {
      if (!/^\d+$/.test(l)) return res("permerror", "bad l=");
      if (Number(l) > cbody.length) return res("fail", "l= longer than body");
      partialBody = Number(l) < cbody.length;
      cbody = cbody.slice(0, Number(l));
    }
    const bh = createHash("sha256").update(cbody, "latin1").digest();
    if (!bh.equals(b64(tags.get("bh")!))) return res("fail", "body hash mismatch");

    const selected = selectHeaders(fields.filter((f) => f !== sig), h);
    const data = signedHeaderData(selected, sig, hc);
    const signature = b64(tags.get("b")!);
    const ok = alg === "rsa-sha256"
      ? verify("sha256", data, key.key, signature)
      // RFC 8463 §3: Ed25519 signs the SHA-256 hash of the header data, not the data itself.
      : verify(null, createHash("sha256").update(data).digest(), key.key, signature);
    if (!ok) return res("fail", "signature did not verify");
    return partialBody ? { ...res("pass"), partialBody: true } : res("pass");
  } catch (e) {
    return res("permerror", e instanceof Error ? e.message : "verification error");
  }
}

type KeyLookup = { key: KeyObject } | { error: "permerror" | "temperror"; reason: string };

async function fetchKey(resolve: TxtResolver, name: string, alg: string): Promise<KeyLookup> {
  let records: string[][];
  try {
    records = await resolve(name);
  } catch (e) {
    const code = (e as { code?: unknown } | null)?.code;
    if (code === "ENOTFOUND" || code === "ENODATA") return { error: "permerror", reason: "no key" };
    return { error: "temperror", reason: `dns error${typeof code === "string" ? " " + code : ""}` };
  }
  // Several TXT records at the name: use the first that parses as a DKIM key.
  let tags: Map<string, string> | null = null;
  for (const chunks of records) {
    const t = parseTags(chunks.join(""));
    if (t && (t.get("v") ?? "DKIM1") === "DKIM1" && t.has("p")) { tags = t; break; }
  }
  if (!tags) return { error: "permerror", reason: "no key" };

  const k = (tags.get("k") ?? "rsa").toLowerCase();
  const wantK = alg === "rsa-sha256" ? "rsa" : "ed25519";
  if (k !== wantK) return { error: "permerror", reason: `key type ${k} does not match ${alg}` };
  const hashes = tags.get("h");
  if (hashes !== undefined && !hashes.toLowerCase().split(":").map((s) => s.trim()).includes("sha256")) {
    return { error: "permerror", reason: "key does not allow sha256" };
  }
  const p = (tags.get("p") ?? "").replace(/[ \t\r\n]/g, "");
  if (p === "") return { error: "permerror", reason: "key revoked" };
  const der = Buffer.from(p, "base64");

  try {
    if (k === "ed25519") {
      const spki = der.length === 32 ? Buffer.concat([ED25519_SPKI_PREFIX, der]) : der;
      return { key: createPublicKey({ key: spki, format: "der", type: "spki" }) };
    }
    let key: KeyObject;
    try {
      key = createPublicKey({ key: der, format: "der", type: "spki" });
    } catch {
      key = createPublicKey({ key: der, format: "der", type: "pkcs1" }); // some records publish bare RSAPublicKey
    }
    if (key.asymmetricKeyType !== "rsa") return { error: "permerror", reason: "not an rsa key" };
    // RFC 8301 §3.2: keys under 1024 bits are not valid.
    if ((key.asymmetricKeyDetails?.modulusLength ?? 0) < 1024) return { error: "permerror", reason: "rsa key too short" };
    return { key };
  } catch {
    return { error: "permerror", reason: "bad key" };
  }
}

/**
 * DMARC-style relaxed alignment: some passing signature's d= is the From
 * domain or a parent of it (alerts@mail.icicibank.com aligns with d=icicibank.com).
 *
 * MAIL-1 · A pass over part of the body (l= shorter than it) does not count:
 * text appended after the signed part would otherwise be read as the bank's.
 */
export function alignedPass(results: DkimResult[], fromAddress: string): boolean {
  const from = fromAddress.slice(fromAddress.lastIndexOf("@") + 1).trim().toLowerCase().replace(/\.$/, "");
  if (!from) return false;
  return results.some((r) => {
    const d = r.domain.toLowerCase().replace(/\.$/, "");
    return r.result === "pass" && !r.partialBody && d !== "" && (from === d || from.endsWith("." + d));
  });
}
