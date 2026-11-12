/**
 * TLS-1 · An ACME client (RFC 8555), enough to get a certificate from Let's
 * Encrypt by DNS-01: directory, nonces, account, order, authorizations,
 * finalize with our own CSR, download the chain.
 *
 * Every request is a flattened JWS signed with the account's ECDSA P-256 key
 * (ES256). The first carries the public key (`jwk`), every later one the
 * account URL (`kid`). A `badNonce` is retried with the fresh nonce the error
 * carries, as §6.5 says to.
 */

import type { KeyObject } from "node:crypto";
import { createCsr } from "./csr.ts";
import { waitForTxt, type DnsSolver, type PropagationOptions } from "./dns.ts";
import {
  dns01RecordName, dns01TxtValue, generateEcKeyPem, jwkThumbprint, keyAuthorization, loadPrivateKey,
  publicJwk, signJws, type JwsHeader,
} from "./jose.ts";

export const LETS_ENCRYPT_PRODUCTION = "https://acme-v02.api.letsencrypt.org/directory";
export const LETS_ENCRYPT_STAGING = "https://acme-staging-v02.api.letsencrypt.org/directory";

type Directory = { newNonce: string; newAccount: string; newOrder: string; meta?: { termsOfService?: string } };
type Problem = { type?: string; detail?: string; subproblems?: Problem[] };
type Challenge = { type: string; url: string; token: string; status: string; error?: Problem };
type Authorization = {
  status: string; identifier: { type: string; value: string }; wildcard?: boolean; challenges: Challenge[];
};
type Order = {
  status: string; authorizations: string[]; finalize: string; certificate?: string; error?: Problem;
};

export type Logger = (entry: Record<string, unknown>) => void;

export type AcmeClientOptions = {
  directoryUrl: string;
  /** The account key, PKCS#8 PEM (ECDSA P-256). */
  accountKeyPem: string;
  /** The account URL from an earlier run, so newAccount is not repeated. */
  accountUrl?: string | null;
  email?: string | null;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  log?: Logger;
  /** How long to poll an authorization or an order before giving up. */
  pollTimeoutMs?: number;
  propagation?: PropagationOptions;
};

export type IssuedCertificate = { certPem: string; keyPem: string };

export class AcmeError extends Error {
  readonly problem: Problem | undefined;
  readonly status: number;
  constructor(message: string, status: number, problem?: Problem) {
    super(message);
    this.name = "AcmeError";
    this.status = status;
    this.problem = problem;
  }
}

function describe(problem: Problem | undefined): string {
  if (!problem) return "no detail";
  const sub = problem.subproblems?.map((s) => s.detail).filter(Boolean).join("; ");
  return `${problem.type?.replace("urn:ietf:params:acme:error:", "") ?? "error"}: ${problem.detail ?? ""}${sub ? ` (${sub})` : ""}`;
}

export class AcmeClient {
  readonly #directoryUrl: string;
  readonly #key: KeyObject;
  readonly #fetch: typeof fetch;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #log: Logger;
  readonly #email: string | null;
  readonly #pollTimeoutMs: number;
  readonly #propagation: PropagationOptions;
  #directory: Directory | null = null;
  #nonce: string | null = null;
  accountUrl: string | null;

  constructor(opts: AcmeClientOptions) {
    this.#directoryUrl = opts.directoryUrl;
    this.#key = loadPrivateKey(opts.accountKeyPem);
    this.#fetch = opts.fetchImpl ?? fetch;
    this.#sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.#log = opts.log ?? (() => {});
    this.#email = opts.email ?? null;
    this.accountUrl = opts.accountUrl ?? null;
    this.#pollTimeoutMs = opts.pollTimeoutMs ?? 5 * 60_000;
    this.#propagation = opts.propagation ?? {};
  }

  get thumbprint(): string {
    return jwkThumbprint(publicJwk(this.#key));
  }

  async #getDirectory(): Promise<Directory> {
    if (this.#directory) return this.#directory;
    const res = await this.#fetch(this.#directoryUrl, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new AcmeError(`ACME directory ${this.#directoryUrl} answered ${res.status}`, res.status);
    this.#directory = (await res.json()) as Directory;
    return this.#directory;
  }

  async #freshNonce(): Promise<string> {
    if (this.#nonce) {
      const n = this.#nonce;
      this.#nonce = null;
      return n;
    }
    const dir = await this.#getDirectory();
    const res = await this.#fetch(dir.newNonce, { method: "HEAD", signal: AbortSignal.timeout(30_000) });
    const nonce = res.headers.get("replay-nonce");
    if (!nonce) throw new AcmeError("ACME server gave no Replay-Nonce", res.status);
    return nonce;
  }

  /** One signed POST. `payload` undefined is POST-as-GET. Retries a bad nonce up to three times. */
  async #post(url: string, payload: unknown, opts: { useJwk?: boolean; accept?: string } = {}): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      const nonce = await this.#freshNonce();
      const header: JwsHeader = { alg: "ES256", nonce, url };
      if (opts.useJwk) header.jwk = publicJwk(this.#key);
      else {
        if (!this.accountUrl) throw new Error("no ACME account yet");
        header.kid = this.accountUrl;
      }
      const res = await this.#fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/jose+json", ...(opts.accept ? { Accept: opts.accept } : {}) },
        body: JSON.stringify(signJws(this.#key, header, payload)),
        signal: AbortSignal.timeout(60_000),
      });
      const next = res.headers.get("replay-nonce");
      if (next) this.#nonce = next;
      if (res.ok) return res;
      let problem: Problem | undefined;
      try {
        problem = (await res.json()) as Problem;
      } catch {
        // not a problem document
      }
      if (problem?.type === "urn:ietf:params:acme:error:badNonce" && attempt < 3) continue;
      throw new AcmeError(`ACME ${new URL(url).pathname} answered ${res.status}: ${describe(problem)}`, res.status, problem);
    }
  }

  async #postJson<T>(url: string, payload: unknown, opts: { useJwk?: boolean } = {}): Promise<{ body: T; location: string | null; retryAfter: number | null }> {
    const res = await this.#post(url, payload, opts);
    const retry = res.headers.get("retry-after");
    return {
      body: (await res.json()) as T,
      location: res.headers.get("location"),
      retryAfter: retry && /^\d+$/.test(retry) ? Number(retry) * 1000 : null,
    };
  }

  /** Creates the account, or finds the existing one for this key (RFC 8555 §7.3). */
  async ensureAccount(): Promise<string> {
    if (this.accountUrl) return this.accountUrl;
    const dir = await this.#getDirectory();
    const { location } = await this.#postJson(dir.newAccount, {
      termsOfServiceAgreed: true,
      ...(this.#email ? { contact: [`mailto:${this.#email}`] } : {}),
    }, { useJwk: true });
    if (!location) throw new AcmeError("ACME newAccount gave no account URL", 0);
    this.accountUrl = location;
    this.#log({ msg: "acme account ready", directory: this.#directoryUrl });
    return location;
  }

  async #poll<T extends { status: string }>(url: string, done: (s: string) => boolean, what: string): Promise<T> {
    const started = Date.now();
    let waited = 0;
    for (;;) {
      const { body, retryAfter } = await this.#postJson<T>(url, undefined);
      if (done(body.status)) return body;
      const delay = Math.min(Math.max(retryAfter ?? 2_000, 1_000), 30_000);
      waited += delay;
      if (waited > this.#pollTimeoutMs || Date.now() - started > this.#pollTimeoutMs * 2) {
        throw new AcmeError(`${what} still ${body.status} after ${Math.round(waited / 1000)} s`, 0);
      }
      await this.#sleep(delay);
    }
  }

  /**
   * The whole issuance for `domains`, solving each authorization by DNS-01.
   * Every TXT record this created is removed before it returns or throws.
   */
  async obtainCertificate(domains: string[], solver: DnsSolver): Promise<IssuedCertificate> {
    const dir = await this.#getDirectory();
    await this.ensureAccount();
    const ordered = await this.#postJson<Order>(dir.newOrder, {
      identifiers: domains.map((value) => ({ type: "dns", value })),
    });
    const orderUrl = ordered.location;
    if (!orderUrl) throw new AcmeError("ACME newOrder gave no order URL", 0);
    let order = ordered.body;
    this.#log({ msg: "acme order placed", domains, status: order.status });

    const thumbprint = this.thumbprint;
    const published: unknown[] = [];
    try {
      const pending: { authzUrl: string; challenge: Challenge; identifier: string }[] = [];
      for (const authzUrl of order.authorizations) {
        const { body: authz } = await this.#postJson<Authorization>(authzUrl, undefined);
        if (authz.status === "valid") continue;
        const challenge = authz.challenges.find((c) => c.type === "dns-01");
        if (!challenge) throw new AcmeError(`no dns-01 challenge offered for ${authz.identifier.value}`, 0);
        const identifier = authz.wildcard ? `*.${authz.identifier.value}` : authz.identifier.value;
        const recordName = dns01RecordName(identifier);
        const value = dns01TxtValue(keyAuthorization(challenge.token, thumbprint));
        published.push(await solver.present(recordName, value));
        this.#log({ msg: "acme dns-01 record published", record: recordName, solver: solver.name });
        pending.push({ authzUrl, challenge, identifier });
      }
      for (const { challenge, identifier } of pending) {
        const recordName = dns01RecordName(identifier);
        const value = dns01TxtValue(keyAuthorization(challenge.token, thumbprint));
        const seen = await waitForTxt(recordName, value, this.#propagation);
        if (!seen) {
          this.#log({ level: "warn", msg: "acme dns-01 record not yet visible on public resolvers; asking the CA anyway", record: recordName });
        }
      }
      for (const { authzUrl, challenge, identifier } of pending) {
        await this.#postJson(challenge.url, {});
        const authz = await this.#poll<Authorization>(authzUrl, (s) => s !== "pending" && s !== "processing", `authorization for ${identifier}`);
        if (authz.status !== "valid") {
          const failed = authz.challenges.find((c) => c.type === "dns-01");
          throw new AcmeError(`authorization for ${identifier} is ${authz.status}: ${describe(failed?.error)}`, 0, failed?.error);
        }
      }
    } finally {
      for (const handle of published) {
        try {
          await solver.cleanup(handle);
        } catch (err) {
          this.#log({ level: "warn", msg: "acme dns-01 record could not be removed; remove it by hand", error: (err as Error).message });
        }
      }
    }

    order = await this.#poll<Order>(orderUrl, (s) => s !== "pending", "order");
    if (order.status !== "ready") {
      throw new AcmeError(`order is ${order.status}, not ready to finalize: ${describe(order.error)}`, 0, order.error);
    }
    // A new key for every certificate: nothing about the old one carries over.
    const keyPem = generateEcKeyPem();
    const csr = createCsr(domains, loadPrivateKey(keyPem));
    await this.#postJson(order.finalize, { csr: csr.toString("base64url") });
    order = await this.#poll<Order>(orderUrl, (s) => s !== "processing" && s !== "ready", "order finalization");
    if (order.status !== "valid" || !order.certificate) {
      throw new AcmeError(`order is ${order.status} after finalize: ${describe(order.error)}`, 0, order.error);
    }
    const res = await this.#post(order.certificate, undefined, { accept: "application/pem-certificate-chain" });
    const certPem = await res.text();
    if (!certPem.includes("-----BEGIN CERTIFICATE-----")) throw new AcmeError("certificate download was not PEM", res.status);
    this.#log({ msg: "acme certificate issued", domains });
    return { certPem, keyPem };
  }
}
