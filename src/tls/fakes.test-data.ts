/**
 * TLS-1 · In-process stand-ins for Let's Encrypt and the Cloudflare API, on
 * node:http at 127.0.0.1, so the whole order flow runs in tests with no
 * network. The fake CA checks what the real one checks that matters here:
 * every JWS signature, single-use nonces, the DNS-01 TXT value (read from the
 * fake Cloudflare's records), and the CSR's signature and names.
 */

import { createPublicKey, createHash, generateKeyPairSync, sign, verify, X509Certificate, type KeyObject } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import {
  OID, bitString, bool, decode, explicit, implicitPrimitive, integer, octetString, oid, sequence, set, time,
  utf8String, type Node,
} from "./der.ts";
import { dns01RecordName, dns01TxtValue, jwkThumbprint, keyAuthorization, type Jwk } from "./jose.ts";

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function close(server: Server): Promise<void> {
  return new Promise((r) => {
    server.close(() => r());
    server.closeAllConnections();
  });
}

const pem = (label: string, der: Buffer) =>
  `-----BEGIN ${label}-----\n${der.toString("base64").replace(/(.{64})/g, "$1\n").replace(/\n$/, "")}\n-----END ${label}-----\n`;

const name = (cn: string) => sequence(set(sequence(oid(OID.commonName), utf8String(cn))));

/** A certificate, DER, signed by `issuerKey`. */
function buildCertificate(opts: {
  serial: number; issuer: string; subject: string; spki: Buffer; notBefore: Date; notAfter: Date;
  dnsNames?: string[]; ca?: boolean; issuerKey: KeyObject;
}): Buffer {
  const extensions: Buffer[] = [];
  if (opts.ca) extensions.push(sequence(oid(OID.basicConstraints), bool(true), octetString(sequence(bool(true)))));
  if (opts.dnsNames) {
    const san = sequence(...opts.dnsNames.map((d) => implicitPrimitive(2, Buffer.from(d))));
    extensions.push(sequence(oid(OID.subjectAltName), octetString(san)));
  }
  const tbs = sequence(
    explicit(0, integer(2)),
    integer(opts.serial),
    sequence(oid(OID.ecdsaWithSha256)),
    name(opts.issuer),
    sequence(time(opts.notBefore), time(opts.notAfter)),
    name(opts.subject),
    opts.spki,
    explicit(3, sequence(...extensions)),
  );
  return sequence(tbs, sequence(oid(OID.ecdsaWithSha256)), bitString(sign("sha256", tbs, opts.issuerKey)));
}

/** A test CA: its certificate, and a signer for leaves. */
export function createTestCa(now: () => number = Date.now) {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const spki = publicKey.export({ type: "spki", format: "der" });
  const caDer = buildCertificate({
    serial: 1, issuer: "Pathayam Test CA", subject: "Pathayam Test CA", spki,
    notBefore: new Date(now() - 86_400_000), notAfter: new Date(now() + 3650 * 86_400_000), ca: true, issuerKey: privateKey,
  });
  let serial = 100;
  return {
    certPem: pem("CERTIFICATE", caDer),
    issue(spkiDer: Buffer, dnsNames: string[], validForMs: number): string {
      const der = buildCertificate({
        serial: serial++, issuer: "Pathayam Test CA", subject: dnsNames[0]!, spki: spkiDer, dnsNames,
        notBefore: new Date(now() - 60_000), notAfter: new Date(now() + validForMs), issuerKey: privateKey,
      });
      return pem("CERTIFICATE", der);
    },
  };
}

/** Reads a CSR made by createCsr back: its public key, names, and whether its signature holds. */
export function parseCsr(der: Buffer): { spki: Buffer; names: string[]; cn: string; signatureValid: boolean } {
  const csr = decode(der);
  const [info, , sig] = csr.children!;
  const [, subject, spki, attrs] = info!.children!;
  const cn = subject!.children![0]!.children![0]!.children![1]!.content.toString("utf8");
  const extensions = attrs!.children![0]!.children![1]!.children![0]!;
  const san = extensions.children!.find((ext: Node) => ext.children![0]!.content.equals(oid(OID.subjectAltName).subarray(2)))!;
  const names = decode(san.children![1]!.content).children!.map((n) => n.content.toString("ascii"));
  const signatureValid = verify(
    "sha256", info!.raw, createPublicKey({ key: spki!.raw, format: "der", type: "spki" }), sig!.content.subarray(1),
  );
  return { spki: Buffer.from(spki!.raw), names, cn, signatureValid };
}

// ---------------------------------------------------------------------------
// Fake Cloudflare
// ---------------------------------------------------------------------------

export type FakeRecord = { id: string; type: string; name: string; content: string };

export async function startFakeCloudflare(opts: { token: string; zoneName: string; zoneId?: string }) {
  const zoneId = opts.zoneId ?? "zone123";
  const records = new Map<string, FakeRecord>();
  const calls: string[] = [];
  let nextId = 1;
  let failCreate = false;
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://x");
    calls.push(`${req.method} ${url.pathname}${url.search}`);
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.headers.authorization !== `Bearer ${opts.token}`) {
      return send(403, { success: false, errors: [{ code: 9109, message: "Invalid access token" }], result: null });
    }
    const body = await readBody(req);
    if (req.method === "GET" && url.pathname === "/zones") {
      const wanted = url.searchParams.get("name");
      return send(200, { success: true, result: wanted === opts.zoneName ? [{ id: zoneId, name: opts.zoneName }] : [] });
    }
    const m = url.pathname.match(/^\/zones\/([^/]+)\/dns_records(?:\/([^/]+))?$/);
    if (!m || m[1] !== zoneId) return send(404, { success: false, errors: [{ code: 7003, message: "Could not route" }], result: null });
    if (req.method === "POST" && !m[2]) {
      if (failCreate) return send(400, { success: false, errors: [{ code: 81057, message: "Record already exists" }], result: null });
      const input = JSON.parse(body.toString()) as { type: string; name: string; content: string };
      const record = { id: `rec${nextId++}`, type: input.type, name: input.name, content: input.content.replace(/^"|"$/g, "") };
      records.set(record.id, record);
      return send(200, { success: true, result: record });
    }
    if (req.method === "DELETE" && m[2]) {
      if (!records.delete(m[2])) return send(404, { success: false, errors: [{ code: 81044, message: "Record does not exist" }], result: null });
      return send(200, { success: true, result: { id: m[2] } });
    }
    send(405, { success: false, errors: [{ code: 10000, message: "method" }], result: null });
  });
  const url = await listen(server);
  return {
    apiBase: url,
    zoneId,
    records,
    calls,
    set failCreate(v: boolean) { failCreate = v; },
    txt(recordName: string): string[] {
      return [...records.values()].filter((r) => r.type === "TXT" && r.name === recordName).map((r) => r.content);
    },
    close: () => close(server),
  };
}

// ---------------------------------------------------------------------------
// Fake ACME CA
// ---------------------------------------------------------------------------

type Authz = { id: number; identifier: string; wildcard: boolean; status: string; token: string; challengeStatus: string; error?: unknown; account: string };
type Order = { id: number; status: string; identifiers: string[]; authz: number[]; account: string; certificate?: string };

export async function startFakeAcme(opts: {
  /** How the CA "looks up" a TXT record: the fake Cloudflare's records. */
  txt(name: string): string[];
  now?: () => number;
  validForMs?: number;
}) {
  const now = opts.now ?? Date.now;
  const ca = createTestCa(now);
  const nonces = new Set<string>();
  const accounts = new Map<string, Jwk>();
  const orders = new Map<number, Order>();
  const authzs = new Map<number, Authz>();
  const certs = new Map<number, string>();
  const log: string[] = [];
  let seq = 1;
  let badNonceNext = 0;
  let validForMs = opts.validForMs ?? 90 * 86_400_000;
  let base = "";

  const newNonce = () => {
    const n = createHash("sha256").update(String(Math.random())).digest("base64url").slice(0, 22);
    nonces.add(n);
    return n;
  };

  const authzJson = (a: Authz) => ({
    status: a.status,
    identifier: { type: "dns", value: a.identifier },
    ...(a.wildcard ? { wildcard: true } : {}),
    challenges: [
      { type: "http-01", url: `${base}/chall/${a.id}/http`, token: a.token, status: "pending" },
      { type: "dns-01", url: `${base}/chall/${a.id}`, token: a.token, status: a.challengeStatus, ...(a.error ? { error: a.error } : {}) },
    ],
  });

  const orderJson = (o: Order) => {
    if (o.status === "pending" && o.authz.every((id) => authzs.get(id)!.status === "valid")) o.status = "ready";
    if (o.status === "pending" && o.authz.some((id) => authzs.get(id)!.status === "invalid")) o.status = "invalid";
    return {
      status: o.status,
      identifiers: o.identifiers.map((value) => ({ type: "dns", value })),
      authorizations: o.authz.map((id) => `${base}/authz/${id}`),
      finalize: `${base}/finalize/${o.id}`,
      ...(o.certificate ? { certificate: o.certificate } : {}),
    };
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", base);
    const path = url.pathname;
    const reply = (status: number, body: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { "Content-Type": "application/json", "Replay-Nonce": newNonce(), ...headers });
      res.end(typeof body === "string" ? body : JSON.stringify(body));
    };
    const problem = (status: number, type: string, detail: string) =>
      reply(status, { type: `urn:ietf:params:acme:error:${type}`, detail }, { "Content-Type": "application/problem+json" });

    if (req.method === "GET" && path === "/directory") {
      return reply(200, { newNonce: `${base}/new-nonce`, newAccount: `${base}/new-account`, newOrder: `${base}/new-order` });
    }
    if (path === "/new-nonce") {
      res.writeHead(200, { "Replay-Nonce": newNonce(), "Cache-Control": "no-store" });
      return res.end();
    }
    if (req.method !== "POST") return problem(405, "malformed", "POST only");
    if (req.headers["content-type"] !== "application/jose+json") return problem(415, "malformed", "content type");

    const jws = JSON.parse((await readBody(req)).toString()) as { protected: string; payload: string; signature: string };
    const header = JSON.parse(Buffer.from(jws.protected, "base64url").toString()) as {
      alg: string; nonce: string; url: string; jwk?: Jwk; kid?: string;
    };
    log.push(path);
    if (header.alg !== "ES256") return problem(400, "badSignatureAlgorithm", header.alg);
    if (!nonces.delete(header.nonce)) return problem(400, "badNonce", "unknown nonce");
    if (badNonceNext > 0) {
      badNonceNext--;
      return problem(400, "badNonce", "test: try again");
    }
    if (header.url !== `${base}${path}`) return problem(401, "unauthorized", "url mismatch");
    if (Boolean(header.jwk) === Boolean(header.kid)) return problem(400, "malformed", "exactly one of jwk and kid");
    let jwk: Jwk | undefined = header.jwk;
    if (header.kid) jwk = accounts.get(header.kid);
    if (!jwk) return problem(400, "accountDoesNotExist", "no such account");
    const ok = verify(
      "sha256", Buffer.from(`${jws.protected}.${jws.payload}`),
      { key: createPublicKey({ key: jwk, format: "jwk" }), dsaEncoding: "ieee-p1363" },
      Buffer.from(jws.signature, "base64url"),
    );
    if (!ok) return problem(400, "malformed", "bad signature");
    const payload = jws.payload === "" ? undefined : JSON.parse(Buffer.from(jws.payload, "base64url").toString());

    if (path === "/new-account") {
      if (!header.jwk) return problem(400, "malformed", "newAccount needs jwk");
      const thumb = jwkThumbprint(header.jwk);
      const accountUrl = `${base}/acct/${thumb}`;
      const existed = accounts.has(accountUrl);
      if (!existed && payload?.termsOfServiceAgreed !== true) return problem(403, "userActionRequired", "agree to the terms");
      accounts.set(accountUrl, header.jwk);
      return reply(existed ? 200 : 201, { status: "valid", contact: payload?.contact ?? [] }, { Location: accountUrl });
    }
    const account = header.kid!;
    const thumbprint = jwkThumbprint(jwk);

    if (path === "/new-order") {
      const identifiers = (payload.identifiers as { value: string }[]).map((i) => i.value);
      const order: Order = { id: seq++, status: "pending", identifiers, authz: [], account };
      for (const value of identifiers) {
        const a: Authz = {
          id: seq++, identifier: value.replace(/^\*\./, ""), wildcard: value.startsWith("*."), status: "pending",
          token: createHash("sha256").update(`${value}${seq}${Math.random()}`).digest("base64url"), challengeStatus: "pending", account,
        };
        authzs.set(a.id, a);
        order.authz.push(a.id);
      }
      orders.set(order.id, order);
      return reply(201, orderJson(order), { Location: `${base}/order/${order.id}` });
    }
    let m = path.match(/^\/authz\/(\d+)$/);
    if (m) {
      const a = authzs.get(Number(m[1]));
      if (!a || a.account !== account) return problem(404, "malformed", "no such authz");
      return reply(200, authzJson(a));
    }
    m = path.match(/^\/chall\/(\d+)$/);
    if (m) {
      const a = authzs.get(Number(m[1]));
      if (!a || a.account !== account) return problem(404, "malformed", "no such challenge");
      const recordName = dns01RecordName(a.wildcard ? `*.${a.identifier}` : a.identifier);
      const expected = dns01TxtValue(keyAuthorization(a.token, thumbprint));
      const found = opts.txt(recordName);
      if (found.includes(expected)) {
        a.status = "valid";
        a.challengeStatus = "valid";
      } else {
        a.status = "invalid";
        a.challengeStatus = "invalid";
        a.error = { type: "urn:ietf:params:acme:error:unauthorized", detail: `No TXT record found at ${recordName}` };
      }
      return reply(200, { type: "dns-01", url: `${base}/chall/${a.id}`, token: a.token, status: "processing" });
    }
    m = path.match(/^\/order\/(\d+)$/);
    if (m) {
      const o = orders.get(Number(m[1]));
      if (!o || o.account !== account) return problem(404, "malformed", "no such order");
      return reply(200, orderJson(o), { "Retry-After": "1" });
    }
    m = path.match(/^\/finalize\/(\d+)$/);
    if (m) {
      const o = orders.get(Number(m[1]));
      if (!o || o.account !== account) return problem(404, "malformed", "no such order");
      orderJson(o);
      if (o.status !== "ready") return problem(403, "orderNotReady", `order is ${o.status}`);
      const csr = parseCsr(Buffer.from(payload.csr as string, "base64url"));
      if (!csr.signatureValid) return problem(400, "badCSR", "signature");
      if ([...csr.names].sort().join() !== [...o.identifiers].sort().join()) return problem(400, "badCSR", "names differ from the order");
      const leaf = ca.issue(csr.spki, csr.names, validForMs);
      certs.set(o.id, leaf + ca.certPem);
      o.status = "valid";
      o.certificate = `${base}/cert/${o.id}`;
      return reply(200, orderJson(o), { Location: `${base}/order/${o.id}` });
    }
    m = path.match(/^\/cert\/(\d+)$/);
    if (m) {
      const chain = certs.get(Number(m[1]));
      if (!chain) return problem(404, "malformed", "no such certificate");
      return reply(200, chain, { "Content-Type": "application/pem-certificate-chain" });
    }
    problem(404, "malformed", `no route ${path}`);
  });
  base = await listen(server);
  return {
    directoryUrl: `${base}/directory`,
    caPem: ca.certPem,
    accounts,
    log,
    /** The next n signed requests are answered badNonce, as a real CA may. */
    set badNonceNext(n: number) { badNonceNext = n; },
    set validForMs(ms: number) { validForMs = ms; },
    close: () => close(server),
  };
}

export function leafNotAfter(chainPem: string): Date {
  return new Date(new X509Certificate(chainPem).validTo);
}
