/**
 * GMAIL-BYO · Sealing a secret before it is written to the database.
 *
 * A Google OAuth client secret that a member pasted in, and the refresh token
 * Google hands back, are both credentials: with them, anyone holding a copy of
 * the database file could read the mailbox. They were already kept out of every
 * export; this keeps them unreadable in the file itself, for a copy taken any
 * other way (a stolen volume snapshot, a stray `cp`).
 *
 * AES-256-GCM from `node:crypto` — the project adds no runtime dependency. The
 * key is `SECRETS_KEY`, set by the operator (a Fly secret on a hosted
 * instance) and never stored beside the data. Each sealed value carries its
 * own random IV, and is bound to what it is (`aad`): a sealed secret copied
 * from one member's row onto another's will not open there.
 *
 * Format: `v1:<iv>:<tag>:<ciphertext>`, each part base64url.
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const PREFIX = "v1:";

/** The smallest SECRETS_KEY accepted: 32 characters, about 190 bits of base64. */
export const SECRETS_KEY_MIN_LENGTH = 32;

/**
 * A 256-bit key from the operator's SECRETS_KEY. Hashed rather than decoded so
 * any long random string works (`openssl rand -base64 32` is what the docs
 * suggest); the length floor is what keeps a short password out.
 */
export function deriveSecretsKey(raw: string): Buffer {
  return createHash("sha256").update(`pathayam-secrets-v1:${raw}`).digest();
}

export class SecretUnreadable extends Error {
  constructor() {
    super("A stored secret could not be opened. It was sealed with a different SECRETS_KEY, or altered.");
    this.name = "SecretUnreadable";
  }
}

export function isSealed(value: string): boolean {
  return value.startsWith(PREFIX);
}

export function seal(key: Buffer, plaintext: string, aad: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + [iv, tag, ct].map((b) => b.toString("base64url")).join(":");
}

export function open(key: Buffer, sealed: string, aad: string): string {
  if (!isSealed(sealed)) throw new SecretUnreadable();
  const parts = sealed.slice(PREFIX.length).split(":");
  if (parts.length !== 3) throw new SecretUnreadable();
  const [iv, tag, ct] = parts.map((p) => Buffer.from(p, "base64url")) as [Buffer, Buffer, Buffer];
  if (iv.length !== 12 || tag.length !== 16) throw new SecretUnreadable();
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAAD(Buffer.from(aad, "utf8"));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
  } catch {
    // A wrong key and a tampered value are the same failure: the tag does not verify.
    throw new SecretUnreadable();
  }
}
