/**
 * The PDF standard security handler.
 *
 * A CDSL CAS arrives password-protected — the password is the holder's PAN,
 * or a date of birth, or whatever the registrar was told to use. `04` PR5 is
 * absolute about what happens to it: used in memory for a single import, never
 * persisted. Nothing in this file writes anything anywhere.
 *
 * Revisions handled:
 *   R2, R3, R4 — RC4 with a 40- to 128-bit key, and AESV2 (AES-128-CBC)
 *   R5, R6     — AESV3 (AES-256-CBC), the SHA-2 based scheme
 *
 * The password we compute against is the **user** password. If that fails we
 * try the owner password path, and then the empty password — some generators
 * encrypt with an owner password only, which means the file opens with no
 * password at all despite appearing protected.
 *
 * ## On the hashes in this file
 *
 * Code scanning flags the MD5 and SHA-256 calls below as "password hash with
 * insufficient computational effort". They are not password hashes. Nothing
 * here stores or verifies a credential — these are the key-derivation steps
 * that ISO 32000 specifies for decrypting a file somebody else encrypted, and
 * the algorithm is a property of the file, not a choice. An MD5 swapped for
 * scrypt would not be a stronger version of this code; it would be a program
 * that cannot open the statement.
 *
 * Where this project *does* store a password — a member signing in — it uses
 * scrypt with the parameters written into the hash. See `src/auth/passwords.ts`.
 */

import { createHash, createDecipheriv, createCipheriv } from "node:crypto";
import { rc4 } from "./rc4.ts";
import {
  isBytes, isDict, isName, isStream, isRef, latin1,
  resolve, dictGet,
  type PdfDocument, type PdfDict, type PdfValue,
} from "./objects.ts";
import { Refusal } from "../core/refusal.ts";

/** The 32-byte string every standard-security PDF pads short passwords with. */
const PAD = new Uint8Array([
  0x28, 0xbf, 0x4e, 0x5e, 0x4e, 0x75, 0x8a, 0x41, 0x64, 0x00, 0x4e, 0x56,
  0xff, 0xfa, 0x01, 0x08, 0x2e, 0x2e, 0x00, 0xb6, 0xd0, 0x68, 0x3e, 0x80,
  0x2f, 0x0c, 0xa9, 0xfe, 0x64, 0x53, 0x69, 0x7a,
]);

export class WrongPassword extends Error {
  constructor() {
    super("That password did not open the statement.");
  }
}

interface Encryption {
  key: Uint8Array;
  /** AES needs the per-object key salted differently, and has an IV. */
  aes: boolean;
  /** R5/R6 use the file key directly, with no per-object derivation. */
  perObjectKey: boolean;
}

function bytes(value: PdfValue): Uint8Array {
  return isBytes(value) ? value : new Uint8Array(0);
}

function pad(password: Uint8Array): Uint8Array {
  const out = new Uint8Array(32);
  const n = Math.min(password.length, 32);
  out.set(password.subarray(0, n));
  out.set(PAD.subarray(0, 32 - n), n);
  return out;
}

/** Algorithm 2 — the file key, for revisions 2 to 4. */
function legacyFileKey(
  password: Uint8Array, o: Uint8Array, p: number, id: Uint8Array,
  revision: number, lengthBytes: number, encryptMetadata: boolean,
): Uint8Array {
  // MD5 is what Algorithm 2 specifies. See the note in the module header.
  // codeql[js/insufficient-password-hash]
  const hash = createHash("md5");
  hash.update(pad(password));
  hash.update(o.subarray(0, 32));

  const pBytes = new Uint8Array(4);
  new DataView(pBytes.buffer).setInt32(0, p | 0, true);
  hash.update(pBytes);
  hash.update(id);

  // R4 with metadata left in the clear appends four 0xFF bytes.
  if (revision >= 4 && !encryptMetadata) hash.update(new Uint8Array([255, 255, 255, 255]));

  let key = new Uint8Array(hash.digest()).subarray(0, revision === 2 ? 5 : lengthBytes);

  // R3+ iterates the hash 50 times over the key itself. This is the step that
  // makes a wrong password expensive rather than instant.
  if (revision >= 3) {
    for (let i = 0; i < 50; i++) {
      key = new Uint8Array(createHash("md5").update(key).digest()).subarray(0, lengthBytes);
    }
  }
  return key;
}

/**
 * Algorithm 7 — recover the **user** password from the owner password.
 *
 * This exists because Indian bank statements need it. qpdf's verdict on a real
 * Union Bank statement was, in its own words, that the supplied password was
 * the **owner** password and that the user password was a customer number. The bank sets the friendly derived string —
 * `RAVI0101`, exactly as their email describes — as the **owner** password,
 * and leaves the user password as an internal customer number nobody is told.
 *
 * A decryptor that only tries the user password (Algorithm 6) therefore
 * rejects the very password the bank told the customer to use. Six of this
 * household's institutions behaved that way.
 *
 * The owner key decrypts /O to reveal the user password, which then goes
 * through Algorithm 2 as normal.
 */
function userPasswordFromOwner(
  owner: Uint8Array, o: Uint8Array, revision: number, lengthBytes: number,
): Uint8Array {
  // Algorithm 3 step (a), MD5 as specified — not a stored credential.
  // codeql[js/insufficient-password-hash]
  let key = new Uint8Array(createHash("md5").update(pad(owner)).digest());

  if (revision >= 3) {
    for (let i = 0; i < 50; i++) {
      key = new Uint8Array(createHash("md5").update(key.subarray(0, lengthBytes)).digest());
    }
  }

  const rc4Key = key.subarray(0, revision === 2 ? 5 : lengthBytes);

  if (revision === 2) return rc4(rc4Key, o.subarray(0, 32));

  // R3+ applies twenty RC4 passes, counting *down*, each with the key XORed by
  // the round number — the reverse of how /O was built.
  let value = o.subarray(0, 32);
  for (let i = 19; i >= 0; i--) {
    const round = new Uint8Array(rc4Key.length);
    for (let j = 0; j < rc4Key.length; j++) round[j] = rc4Key[j]! ^ i;
    value = rc4(round, value);
  }
  return value;
}

/** Algorithm 6 — does this key actually open the file? */
function legacyKeyIsRight(
  key: Uint8Array, u: Uint8Array, id: Uint8Array, revision: number,
): boolean {
  if (revision === 2) {
    return sameBytes(rc4(key, PAD), u.subarray(0, 32));
  }

  const hash = createHash("md5");
  hash.update(PAD);
  hash.update(id);
  let check = rc4(key, new Uint8Array(hash.digest()));

  // 19 further rounds with the key XORed by the round number.
  for (let i = 1; i <= 19; i++) {
    const roundKey = new Uint8Array(key.length);
    for (let j = 0; j < key.length; j++) roundKey[j] = key[j]! ^ i;
    check = rc4(roundKey, check);
  }

  // Only the first 16 bytes are meaningful; the rest is arbitrary padding.
  return sameBytes(check.subarray(0, 16), u.subarray(0, 16));
}

/**
 * Algorithm 2.B — revision 6's SHA-2 hash, with its hardening loop.
 *
 * Revision 5 was Adobe's short-lived extension and is the same hash without
 * the loop, so it shares the entry point.
 */
function hash2B(
  password: Uint8Array, salt: Uint8Array, udata: Uint8Array, revision: number,
): Uint8Array {
  /*
   * The seed for Algorithm 2.B. On R6 this is only the first round — the
   * hardening loop below runs at least 64 more, each over 64 repetitions of
   * the password, so the work here is far from a bare SHA-256. The scanner
   * sees this line alone.
   */
  // codeql[js/insufficient-password-hash]
  let k = new Uint8Array(
    createHash("sha256").update(password).update(salt).update(udata).digest(),
  );
  if (revision === 5) return k;

  // Rounds are numbered from 1. The loop runs at least 64 of them, and then
  // continues until the last byte of E falls to the round number minus 32.
  for (let round = 1; ; round++) {
    const k1Parts: Uint8Array[] = [];
    for (let i = 0; i < 64; i++) k1Parts.push(password, k, udata);
    const k1 = concat(k1Parts);

    const e = aes128CbcEncrypt(k.subarray(0, 16), k.subarray(16, 32), k1);

    let sum = 0;
    for (let i = 0; i < 16; i++) sum += e[i]!;
    const which = sum % 3;
    k = new Uint8Array(
      createHash(which === 0 ? "sha256" : which === 1 ? "sha384" : "sha512").update(e).digest(),
    );

    if (round >= 64 && e[e.length - 1]! <= round - 32) break;
  }

  return k.subarray(0, 32);
}

function aes128CbcEncrypt(key: Uint8Array, iv: Uint8Array, data: Uint8Array): Uint8Array {
  // Algorithm 2.A calls for AES-128-CBC encryption with no padding. There is
  // no raw block primitive in node:crypto, but this is exactly it.
  const c = createCipheriv("aes-128-cbc", key, iv);
  c.setAutoPadding(false);
  return new Uint8Array(Buffer.concat([c.update(Buffer.from(data)), c.final()]));
}

function aesDecrypt(key: Uint8Array, data: Uint8Array): Uint8Array {
  // The first 16 bytes are the initialisation vector, per the AESV2/V3 spec.
  if (data.length <= 16) return new Uint8Array(0);
  const iv = data.subarray(0, 16);
  const body = data.subarray(16, 16 + Math.floor((data.length - 16) / 16) * 16);
  if (body.length === 0) return new Uint8Array(0);

  try {
    const d = createDecipheriv(key.length === 32 ? "aes-256-cbc" : "aes-128-cbc", key, iv);
    d.setAutoPadding(false);
    const out = new Uint8Array(Buffer.concat([d.update(Buffer.from(body)), d.final()]));
    // Strip PKCS#7 padding, tolerating a malformed final block.
    const padLength = out[out.length - 1] ?? 0;
    return padLength >= 1 && padLength <= 16 ? out.subarray(0, out.length - padLength) : out;
  } catch {
    return new Uint8Array(0);
  }
}

function concat(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Work out the file key from the /Encrypt dictionary and the supplied
 * password, or throw. Tries the given password, then the empty one — a file
 * with only an owner password set opens without any password at all.
 */
function fileKey(doc: PdfDocument, encrypt: PdfDict, password: string): Encryption {
  const filter = dictGet(doc, encrypt, "Filter");
  if (isName(filter) && filter.name !== "Standard") {
    throw new Refusal(
      `This statement uses the ${filter.name} security handler, which this app cannot open. ` +
      `Save it as an unprotected PDF from your viewer and import that.`,
    );
  }

  const v = numberOr(dictGet(doc, encrypt, "V"), 0);
  const r = numberOr(dictGet(doc, encrypt, "R"), 2);
  const lengthBits = numberOr(dictGet(doc, encrypt, "Length"), 40);
  const p = numberOr(dictGet(doc, encrypt, "P"), -1);
  const o = bytes(dictGet(doc, encrypt, "O"));
  const u = bytes(dictGet(doc, encrypt, "U"));
  const encryptMetadata = dictGet(doc, encrypt, "EncryptMetadata") !== false;

  const idArray = dictGet(doc, doc.trailer, "ID");
  const id = Array.isArray(idArray) ? bytes(resolve(doc, idArray[0] ?? null)) : new Uint8Array(0);

  const { aes, keyBits } = cryptFilter(doc, encrypt, v, lengthBits);
  const candidates = [utf8(password), new Uint8Array(0)];

  if (r >= 5) {
    // R5/R6: validation salt is bytes 32–40 of /U, key salt is 40–48.
    for (const candidate of candidates) {
      const validation = hash2B(candidate, u.subarray(32, 40), new Uint8Array(0), r);
      if (!sameBytes(validation, u.subarray(0, 32))) continue;

      const intermediate = hash2B(candidate, u.subarray(40, 48), new Uint8Array(0), r);
      const ue = bytes(dictGet(doc, encrypt, "UE"));
      const d = createDecipheriv("aes-256-cbc", intermediate, new Uint8Array(16));
      d.setAutoPadding(false);
      const key = new Uint8Array(Buffer.concat([d.update(Buffer.from(ue)), d.final()]));
      return { key: key.subarray(0, 32), aes: true, perObjectKey: false };
    }
    throw new WrongPassword();
  }

  const lengthBytes = Math.max(5, Math.min(16, Math.floor(keyBits / 8)));

  for (const candidate of candidates) {
    // As the user password.
    const key = legacyFileKey(candidate, o, p, id, r, lengthBytes, encryptMetadata);
    if (legacyKeyIsRight(key, u, id, r)) {
      return { key, aes, perObjectKey: true };
    }

    // As the owner password — which is what a bank statement usually is.
    const recovered = userPasswordFromOwner(candidate, o, r, lengthBytes);
    const ownerKey = legacyFileKey(recovered, o, p, id, r, lengthBytes, encryptMetadata);
    if (legacyKeyIsRight(ownerKey, u, id, r)) {
      return { key: ownerKey, aes, perObjectKey: true };
    }
  }
  throw new WrongPassword();
}

/** V4/V5 put the real algorithm in a named crypt filter, not in /V. */
function cryptFilter(
  doc: PdfDocument, encrypt: PdfDict, v: number, lengthBits: number,
): { aes: boolean; keyBits: number } {
  if (v < 4) return { aes: false, keyBits: lengthBits };

  const cf = dictGet(doc, encrypt, "CF");
  const stmF = dictGet(doc, encrypt, "StmF");
  const name = isName(stmF) ? stmF.name : "StdCF";
  if (name === "Identity" || !isDict(cf)) return { aes: false, keyBits: lengthBits };

  const filter = dictGet(doc, cf, name);
  if (!isDict(filter)) return { aes: false, keyBits: lengthBits };

  const cfm = dictGet(doc, filter, "CFM");
  const method = isName(cfm) ? cfm.name : "V2";
  const filterLength = numberOr(dictGet(doc, filter, "Length"), 0);

  // /Length in a crypt filter is bytes in some producers and bits in others.
  const keyBits = filterLength === 0 ? lengthBits : filterLength <= 40 ? filterLength * 8 : filterLength;

  return { aes: method === "AESV2" || method === "AESV3", keyBits };
}

function numberOr(value: PdfValue, fallback: number): number {
  return typeof value === "number" ? value : fallback;
}

function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

/** Algorithm 1 — the per-object key, for revisions up to 4. */
function objectKey(enc: Encryption, num: number, gen: number): Uint8Array {
  if (!enc.perObjectKey) return enc.key;

  const extra = enc.aes ? new Uint8Array([0x73, 0x41, 0x6c, 0x54]) : new Uint8Array(0);
  const input = concat([
    enc.key,
    new Uint8Array([num & 0xff, (num >> 8) & 0xff, (num >> 16) & 0xff, gen & 0xff, (gen >> 8) & 0xff]),
    extra,
  ]);
  const digest = new Uint8Array(createHash("md5").update(input).digest());
  return digest.subarray(0, Math.min(enc.key.length + 5, 16));
}

/**
 * Decrypt every string and stream in the document, in place.
 *
 * Returns silently when the document is not encrypted, so callers can always
 * call it. Throws `WrongPassword` when the password is wrong — the one
 * outcome the user needs stated plainly rather than as an empty statement.
 */
export function decryptDocument(doc: PdfDocument, password: string): void {
  const encryptRef = doc.trailer.get("Encrypt");
  const encrypt = resolve(doc, encryptRef ?? null);
  if (!isDict(encrypt)) return;

  const enc = fileKey(doc, encrypt, password);

  // The /Encrypt dictionary itself is never encrypted. Neither is the file
  // identifier. Everything else is.
  const encryptNum = isRef(encryptRef ?? null) ? (encryptRef as { num: number }).num : -1;

  for (const [num, value] of doc.objects) {
    if (num === encryptNum) continue;
    doc.objects.set(num, decryptValue(doc, enc, value, num, 0));
  }
}

function decryptValue(
  doc: PdfDocument, enc: Encryption, value: PdfValue, num: number, gen: number,
): PdfValue {
  if (isBytes(value)) {
    const key = objectKey(enc, num, gen);
    return enc.aes ? aesDecrypt(key, value) : rc4(key, value);
  }
  if (Array.isArray(value)) {
    return value.map((v) => decryptValue(doc, enc, v, num, gen));
  }
  if (isStream(value)) {
    const type = value.dict.get("Type");
    // An XRef stream is written before encryption is applied and is never
    // encrypted; decrypting it would turn a readable table into noise.
    if (isName(type) && type.name === "XRef") return value;

    const dict = decryptValue(doc, enc, value.dict, num, gen);
    const key = objectKey(enc, num, gen);
    return {
      dict: isDict(dict) ? dict : value.dict,
      raw: enc.aes ? aesDecrypt(key, value.raw) : rc4(key, value.raw),
    };
  }
  if (isDict(value)) {
    const out: PdfDict = new Map();
    for (const [k, v] of value) out.set(k, decryptValue(doc, enc, v, num, gen));
    return out;
  }
  return value;
}

/** Whether a document declares encryption at all, for a clearer prompt. */
export function isEncrypted(doc: PdfDocument): boolean {
  return isDict(resolve(doc, doc.trailer.get("Encrypt") ?? null));
}

export { latin1 };
