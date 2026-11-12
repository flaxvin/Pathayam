/**
 * TLS-1 · A PKCS#10 certificate signing request (RFC 2986) for an ECDSA P-256
 * key: subject CN is the first name, every name goes in subjectAltName (which
 * is what Let's Encrypt reads), signed ecdsa-with-SHA256.
 */

import { createPublicKey, sign, type KeyObject } from "node:crypto";
import {
  OID, bitString, explicit, implicitPrimitive, integer, octetString, oid, sequence, set, utf8String,
} from "./der.ts";

export function createCsr(domains: string[], key: KeyObject): Buffer {
  if (domains.length === 0) throw new Error("a CSR needs at least one name");
  const spki = createPublicKey(key).export({ type: "spki", format: "der" });
  const subject = sequence(set(sequence(oid(OID.commonName), utf8String(domains[0]!))));
  const san = sequence(...domains.map((d) => implicitPrimitive(2, Buffer.from(d, "ascii"))));
  const extensions = sequence(sequence(oid(OID.subjectAltName), octetString(san)));
  const attributes = explicit(0, sequence(oid(OID.extensionRequest), set(extensions)));
  const info = sequence(integer(0), subject, spki, attributes);
  const signature = sign("sha256", info, key); // DER-encoded ECDSA-Sig-Value, as X.509 wants
  return sequence(info, sequence(oid(OID.ecdsaWithSha256)), bitString(signature));
}
