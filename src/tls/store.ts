/**
 * TLS-1 · Where the ACME account key and the certificate live between
 * restarts: one directory, 0700, every file 0600 and written whole (a
 * temporary file renamed over the old one), so a crash mid-write never leaves
 * half a key behind.
 */

import { X509Certificate, createPrivateKey } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type CertBundle = {
  certPem: string;
  keyPem: string;
  domains: string[];
  /** The ACME directory the certificate came from, so staging is never kept as production. */
  directoryUrl: string;
  notAfter: Date;
};

/** Reads the leaf's expiry and checks the key belongs to it. Throws on anything unusable. */
export function inspectCertificate(certPem: string, keyPem: string): { notAfter: Date; names: string[] } {
  const leaf = new X509Certificate(certPem);
  if (!leaf.checkPrivateKey(createPrivateKey(keyPem))) throw new Error("the stored key does not match the certificate");
  const names = (leaf.subjectAltName ?? "")
    .split(/,\s*/)
    .filter((s) => s.startsWith("DNS:"))
    .map((s) => s.slice(4).toLowerCase());
  return { notAfter: new Date(leaf.validTo), names };
}

function safeName(s: string): string {
  return s.toLowerCase().replace(/^\*\./, "wildcard.").replace(/[^a-z0-9.-]/g, "_");
}

export class AcmeStore {
  readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  #ensureDir(): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    try {
      chmodSync(this.dir, 0o700);
    } catch {
      // A mount we do not own: the files are still 0600.
    }
  }

  #write(name: string, text: string): void {
    this.#ensureDir();
    const path = join(this.dir, name);
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, text, { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, path);
  }

  #read(name: string): string | null {
    const path = join(this.dir, name);
    return existsSync(path) ? readFileSync(path, "utf8") : null;
  }

  #accountBase(directoryUrl: string): string {
    return `account-${safeName(new URL(directoryUrl).host)}`;
  }

  /** The account key for this ACME directory, made (and saved) on first use. */
  accountKey(directoryUrl: string, generate: () => string): string {
    const name = `${this.#accountBase(directoryUrl)}.key.pem`;
    const existing = this.#read(name);
    if (existing) return existing;
    const pem = generate();
    this.#write(name, pem);
    return pem;
  }

  accountUrl(directoryUrl: string): string | null {
    const raw = this.#read(`${this.#accountBase(directoryUrl)}.json`);
    if (!raw) return null;
    try {
      return (JSON.parse(raw) as { url?: string }).url ?? null;
    } catch {
      return null;
    }
  }

  saveAccountUrl(directoryUrl: string, url: string): void {
    this.#write(`${this.#accountBase(directoryUrl)}.json`, `${JSON.stringify({ url, directoryUrl })}\n`);
  }

  #certBase(domains: string[]): string {
    return `cert-${safeName(domains[0]!)}`;
  }

  /** The stored certificate for these names, or null when there is none or it cannot be used. */
  loadCertificate(domains: string[]): CertBundle | null {
    const base = this.#certBase(domains);
    const certPem = this.#read(`${base}.pem`);
    const keyPem = this.#read(`${base}.key.pem`);
    const metaRaw = this.#read(`${base}.json`);
    if (!certPem || !keyPem || !metaRaw) return null;
    const meta = JSON.parse(metaRaw) as { directoryUrl: string; domains: string[] };
    const { notAfter } = inspectCertificate(certPem, keyPem);
    return { certPem, keyPem, domains: meta.domains, directoryUrl: meta.directoryUrl, notAfter };
  }

  saveCertificate(bundle: CertBundle): void {
    const base = this.#certBase(bundle.domains);
    // Key first: a certificate on disk without its key is never loaded.
    this.#write(`${base}.key.pem`, bundle.keyPem);
    this.#write(`${base}.pem`, bundle.certPem);
    this.#write(`${base}.json`, `${JSON.stringify({
      domains: bundle.domains, directoryUrl: bundle.directoryUrl, notAfter: bundle.notAfter.toISOString(),
    }, null, 2)}\n`);
  }
}
