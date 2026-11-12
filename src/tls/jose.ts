/**
 * TLS-1 · The JOSE pieces ACME (RFC 8555) is built on: base64url, the account
 * key as a JWK, its RFC 7638 thumbprint, flattened JWS with ES256, and the
 * DNS-01 key authorization and TXT value (RFC 8555 §8.1, §8.4).
 */

import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, type KeyObject } from "node:crypto";

export function b64url(data: Uint8Array | string): string {
  return Buffer.from(data).toString("base64url");
}

/** A fresh ECDSA P-256 key, as PKCS#8 PEM. Used for the account and for each certificate. */
export function generateEcKeyPem(): string {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  return privateKey.export({ type: "pkcs8", format: "pem" }) as string;
}

export function loadPrivateKey(pem: string): KeyObject {
  const key = createPrivateKey(pem);
  if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1") {
    throw new Error("the ACME account key must be ECDSA P-256");
  }
  return key;
}

export type Jwk = Record<string, string>;

/** The public JWK of an EC P-256 key, with only the members RFC 7518 §6.2.1 requires. */
export function publicJwk(key: KeyObject): Jwk {
  const jwk = createPublicKey(key).export({ format: "jwk" }) as Jwk;
  return { kty: jwk.kty!, crv: jwk.crv!, x: jwk.x!, y: jwk.y! };
}

/**
 * RFC 7638: SHA-256 over the required members in lexicographic order, no
 * whitespace. The required members per key type are listed in §3.2.
 */
export function jwkThumbprint(jwk: Jwk): string {
  const required: Record<string, string[]> = {
    EC: ["crv", "kty", "x", "y"],
    RSA: ["e", "kty", "n"],
    OKP: ["crv", "kty", "x"],
    oct: ["k", "kty"],
  };
  const members = required[jwk.kty ?? ""];
  if (!members) throw new Error(`unsupported JWK key type: ${jwk.kty}`);
  const canonical = `{${members.map((m) => `${JSON.stringify(m)}:${JSON.stringify(jwk[m])}`).join(",")}}`;
  return b64url(createHash("sha256").update(canonical).digest());
}

export type JwsHeader = { alg: "ES256"; nonce: string; url: string; jwk?: Jwk; kid?: string };

export type FlattenedJws = { protected: string; payload: string; signature: string };

/**
 * A flattened JWS (RFC 7515 §7.2.2) signed with ES256. `payload` undefined is
 * POST-as-GET (RFC 8555 §6.3): an empty string, not "{}".
 */
export function signJws(key: KeyObject, header: JwsHeader, payload: unknown): FlattenedJws {
  const protectedB64 = b64url(JSON.stringify(header));
  const payloadB64 = payload === undefined ? "" : b64url(JSON.stringify(payload));
  // ES256 is the raw r||s pair (RFC 7518 §3.4), not the DER node signs by default.
  const signature = sign("sha256", Buffer.from(`${protectedB64}.${payloadB64}`), { key, dsaEncoding: "ieee-p1363" });
  return { protected: protectedB64, payload: payloadB64, signature: b64url(signature) };
}

/** RFC 8555 §8.1: token "." base64url(thumbprint). */
export function keyAuthorization(token: string, thumbprint: string): string {
  return `${token}.${thumbprint}`;
}

/** RFC 8555 §8.4: the TXT record holds base64url(SHA-256(key authorization)). */
export function dns01TxtValue(keyAuth: string): string {
  return b64url(createHash("sha256").update(keyAuth).digest());
}

/** Where a DNS-01 record goes for an identifier; a wildcard's goes on its base name. */
export function dns01RecordName(identifier: string): string {
  return `_acme-challenge.${identifier.replace(/^\*\./, "")}`;
}
