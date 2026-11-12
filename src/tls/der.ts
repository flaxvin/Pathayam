/**
 * TLS-1 · Just enough ASN.1 DER to write a certificate signing request (and,
 * in tests, to read one back and to sign a stand-in certificate). node:crypto
 * signs and parses certificates but cannot build a CSR, and the repo takes no
 * npm dependencies, so the dozen encodings PKCS#10 needs live here.
 */

function length(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  const bytes: number[] = [];
  while (n > 0) {
    bytes.unshift(n & 0xff);
    n = Math.floor(n / 256);
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

/** One TLV: a tag byte, a DER length, the content. */
export function tlv(tag: number, content: Uint8Array): Buffer {
  return Buffer.concat([Buffer.from([tag]), length(content.length), content]);
}

export const sequence = (...items: Uint8Array[]): Buffer => tlv(0x30, Buffer.concat(items));
export const set = (...items: Uint8Array[]): Buffer => tlv(0x31, Buffer.concat(items));
export const nullValue = (): Buffer => Buffer.from([0x05, 0x00]);
export const utf8String = (s: string): Buffer => tlv(0x0c, Buffer.from(s, "utf8"));
export const octetString = (b: Uint8Array): Buffer => tlv(0x04, b);
export const bool = (v: boolean): Buffer => tlv(0x01, Buffer.from([v ? 0xff : 0]));
/** A BIT STRING with no unused bits, which is every one a CSR holds. */
export const bitString = (b: Uint8Array): Buffer => tlv(0x03, Buffer.concat([Buffer.from([0]), b]));
/** [n] EXPLICIT, constructed context-specific. */
export const explicit = (n: number, content: Uint8Array): Buffer => tlv(0xa0 | n, content);
/** [n] IMPLICIT, primitive context-specific (dNSName is [2]). */
export const implicitPrimitive = (n: number, content: Uint8Array): Buffer => tlv(0x80 | n, content);

/** A non-negative INTEGER from a number or big-endian bytes. */
export function integer(value: number | Uint8Array): Buffer {
  let bytes: Buffer;
  if (typeof value === "number") {
    const out: number[] = [];
    let n = value;
    do {
      out.unshift(n & 0xff);
      n = Math.floor(n / 256);
    } while (n > 0);
    bytes = Buffer.from(out);
  } else {
    bytes = Buffer.from(value);
  }
  let i = 0;
  while (i < bytes.length - 1 && bytes[i] === 0) i++;
  bytes = bytes.subarray(i);
  if (bytes.length === 0) bytes = Buffer.from([0]);
  if (bytes[0]! & 0x80) bytes = Buffer.concat([Buffer.from([0]), bytes]);
  return tlv(0x02, bytes);
}

export function oid(dotted: string): Buffer {
  const parts = dotted.split(".").map(Number);
  if (parts.length < 2 || parts.some((p) => !Number.isInteger(p) || p < 0)) {
    throw new Error(`not an OID: ${dotted}`);
  }
  const out: number[] = [parts[0]! * 40 + parts[1]!];
  for (const part of parts.slice(2)) {
    const chunk: number[] = [part & 0x7f];
    let n = Math.floor(part / 128);
    while (n > 0) {
      chunk.unshift((n & 0x7f) | 0x80);
      n = Math.floor(n / 128);
    }
    out.push(...chunk);
  }
  return tlv(0x06, Buffer.from(out));
}

/** UTCTime for years before 2050, GeneralizedTime after (RFC 5280 §4.1.2.5). */
export function time(date: Date): Buffer {
  const iso = date.toISOString().replace(/[-:T]/g, "").slice(0, 14);
  const year = date.getUTCFullYear();
  return year < 2050 ? tlv(0x17, Buffer.from(`${iso.slice(2)}Z`)) : tlv(0x18, Buffer.from(`${iso}Z`));
}

export const OID = {
  commonName: "2.5.4.3",
  ecPublicKey: "1.2.840.10045.2.1",
  prime256v1: "1.2.840.10045.3.1.7",
  ecdsaWithSha256: "1.2.840.10045.4.3.2",
  extensionRequest: "1.2.840.113549.1.9.14",
  subjectAltName: "2.5.29.17",
  basicConstraints: "2.5.29.19",
} as const;

/** A decoded TLV, for reading DER back (tests, and a CSR self-check). */
export type Node = { tag: number; header: number; content: Buffer; raw: Buffer; children?: Node[] };

/** Parses one DER value at the start of `buf`. Constructed values get `children`. */
export function decode(buf: Buffer): Node {
  const tag = buf[0]!;
  let len = buf[1]!;
  let header = 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + buf[2 + i]!;
    header = 2 + n;
  }
  const content = buf.subarray(header, header + len);
  const raw = buf.subarray(0, header + len);
  const node: Node = { tag, header, content, raw };
  if (tag & 0x20) {
    node.children = [];
    let rest = content;
    while (rest.length > 0) {
      const child = decode(rest);
      node.children.push(child);
      rest = rest.subarray(child.raw.length);
    }
  }
  return node;
}

export function decodeOid(content: Buffer): string {
  const parts = [Math.floor(content[0]! / 40), content[0]! % 40];
  let n = 0;
  for (const byte of content.subarray(1)) {
    n = n * 128 + (byte & 0x7f);
    if (!(byte & 0x80)) {
      parts.push(n);
      n = 0;
    }
  }
  return parts.join(".");
}
