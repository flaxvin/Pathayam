/**
 * GMAIL-BYO · Gmail on every plan, with the household's own Google keys.
 *
 * Three layers, each tested on its own and then together over HTTP:
 *
 *   · sealing (secrets.ts): a secret round-trips under its key, and nothing
 *     else opens it — not another key, not another row, not an edit;
 *   · storing (clients.ts, connection.ts): a pasted client secret and a refresh
 *     token are never in the file in the clear, the export, or the event log;
 *   · choosing: every plan × deployment client yes/no × your keys / the
 *     household's / both / none, and the client a fetch renews under is the
 *     one the connection was made with.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { loadConfig, InvalidConfiguration, type Config } from "../config.ts";
import { PLANS, PLAN_PRESETS, type Plan } from "../features.ts";
import { seal, open, deriveSecretsKey, SecretUnreadable } from "./secrets.ts";
import {
  saveClient, clearClient, clientForConnect, clientForConnection, clientView, HOUSEHOLD,
} from "./clients.ts";
import { saveConnection, getConnection, refreshTokenOf } from "./connection.ts";
import { exportEverything } from "../ops/backup.ts";
import { historyFor } from "../core/events.ts";
import { Refusal } from "../core/refusal.ts";
import { freshDb, seedMember, startTestApp, testConfig } from "../web/harness.test-data.ts";

const KEY = deriveSecretsKey("k".repeat(40));
const OTHER_KEY = deriveSecretsKey("o".repeat(40));

const MINE = { clientId: "111-mine.apps.googleusercontent.com", clientSecret: "GOCSPX-mine-secret-value" };
const HOME = { clientId: "222-home.apps.googleusercontent.com", clientSecret: "GOCSPX-home-secret-value" };
const DEPLOY = { clientId: "333-deploy.apps.googleusercontent.com", clientSecret: "GOCSPX-deploy-secret" };

const RAVI = "m-ravi";
const PRIYA = "m-priya";
const ravi = { memberId: RAVI, source: "ui" as const };
const priya = { memberId: PRIYA, source: "ui" as const };

function cfg(plan: Plan, opts: { deployment?: boolean; key?: boolean; byo?: boolean } = {}): Config {
  const preset = PLAN_PRESETS[plan];
  return testConfig({
    plan,
    features: { ...preset.features, ...(opts.byo === undefined ? {} : { gmailByo: opts.byo }) },
    limits: { ...preset.limits, maxMembers: null },
    google: opts.deployment ? { ...DEPLOY } : { clientId: null, clientSecret: null },
    secretsKey: opts.key === false ? null : KEY,
  });
}

function household() {
  const db = freshDb();
  seedMember(db, RAVI, "Ravi");
  seedMember(db, PRIYA, "Priya");
  return db;
}

describe("GMAIL-BYO · sealing", () => {
  test("a secret round-trips under its key and its label", () => {
    const sealed = seal(KEY, "s3cret", "a");
    assert.notEqual(sealed, "s3cret");
    assert.ok(!sealed.includes("s3cret"));
    assert.equal(open(KEY, sealed, "a"), "s3cret");
  });

  test("two seals of one secret differ (a fresh IV each time)", () => {
    assert.notEqual(seal(KEY, "x", "a"), seal(KEY, "x", "a"));
  });

  test("another key, another label, or an edit does not open it", () => {
    const sealed = seal(KEY, "s3cret", "a");
    assert.throws(() => open(OTHER_KEY, sealed, "a"), SecretUnreadable);
    assert.throws(() => open(KEY, sealed, "b"), SecretUnreadable);
    const parts = sealed.split(":");
    const ct = Buffer.from(parts[3]!, "base64url");
    ct[0] = ct[0]! ^ 1;
    parts[3] = ct.toString("base64url");
    assert.throws(() => open(KEY, parts.join(":"), "a"), SecretUnreadable);
    assert.throws(() => open(KEY, "plain", "a"), SecretUnreadable);
    assert.throws(() => open(KEY, "v1:a:b", "a"), SecretUnreadable);
  });

  test("SECRETS_KEY: unset is null, short is refused at startup, long is used", () => {
    const base = { BASE_URL: "http://localhost:8080" };
    assert.equal(loadConfig(base).secretsKey, null);
    assert.equal(loadConfig({ ...base, SECRETS_KEY: "  " }).secretsKey, null);
    assert.throws(() => loadConfig({ ...base, SECRETS_KEY: "short" }),
      (e: unknown) => e instanceof InvalidConfiguration && /SECRETS_KEY is 5 characters/.test(e.message));
    const key = loadConfig({ ...base, SECRETS_KEY: "k".repeat(40) }).secretsKey;
    assert.ok(key && key.equals(KEY));
  });
});

describe("GMAIL-BYO · storing a client", () => {
  test("the secret is sealed in the row, and absent from the export and the event log", () => {
    const db = household();
    const config = cfg("solo");
    saveClient(db, config, ravi, { scope: "member", ...MINE });
    saveClient(db, config, ravi, { scope: "household", ...HOME });
    const raw = JSON.stringify(db.prepare("SELECT * FROM gmail_clients").all());
    assert.ok(!raw.includes(MINE.clientSecret) && !raw.includes(HOME.clientSecret), "sealed in the file");
    const exported = JSON.stringify(exportEverything(db));
    assert.ok(!exported.includes(MINE.clientSecret) && !exported.includes("gmail_clients"));
    const events = JSON.stringify([...historyFor(db, "gmail", RAVI), ...historyFor(db, "gmail", HOUSEHOLD)]);
    assert.ok(!events.includes(MINE.clientSecret) && !events.includes(HOME.clientSecret));
    assert.match(events, /household's own Google keys/);
    assert.deepEqual(clientView(db, HOUSEHOLD)?.setBy, "Ravi");
    assert.ok(!JSON.stringify(clientView(db, RAVI)).includes(MINE.clientSecret));
  });

  test("refused without SECRETS_KEY, with the switch off, or with something that is not a client", () => {
    const db = household();
    const refuses = (config: Config, input: { clientId: string; clientSecret: string }, re: RegExp) =>
      assert.throws(() => saveClient(db, config, ravi, { scope: "member", ...input }),
        (e: unknown) => e instanceof Refusal && re.test(e.message));
    refuses(cfg("solo", { key: false }), MINE, /SECRETS_KEY/);
    refuses(cfg("solo", { byo: false }), MINE, /turned off/);
    refuses(cfg("solo"), { clientId: "12345", clientSecret: MINE.clientSecret }, /not a Google OAuth client ID/);
    refuses(cfg("solo"), { clientId: MINE.clientId, clientSecret: "short" }, /client secret/);
    refuses(cfg("solo"), { clientId: MINE.clientId, clientSecret: "has a space in it" }, /client secret/);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM gmail_clients").get()!.n, 0);
  });

  test("a client sealed under another key is treated as not there", () => {
    const db = household();
    saveClient(db, cfg("solo"), ravi, { scope: "member", ...MINE });
    const rotated = { ...cfg("solo"), secretsKey: OTHER_KEY };
    assert.equal(clientForConnect(db, rotated, RAVI), null);
  });
});

describe("GMAIL-BYO · which client a new connection uses", () => {
  type Saved = "none" | "mine" | "household" | "both";
  const expected = (plan: Plan, deployment: boolean, saved: Saved, who: string): string | null => {
    if (who === RAVI && (saved === "mine" || saved === "both")) return MINE.clientId;
    if (saved === "household" || saved === "both") return HOME.clientId;
    return deployment && PLAN_PRESETS[plan].features.gmail ? DEPLOY.clientId : null;
  };

  for (const plan of PLANS) {
    for (const deployment of [false, true]) {
      for (const saved of ["none", "mine", "household", "both"] as Saved[]) {
        test(`${plan}, deployment client ${deployment ? "set" : "unset"}, saved: ${saved}`, () => {
          const db = household();
          const config = cfg(plan, { deployment });
          if (saved === "mine" || saved === "both") saveClient(db, config, ravi, { scope: "member", ...MINE });
          if (saved === "household" || saved === "both") saveClient(db, config, priya, { scope: "household", ...HOME });
          for (const who of [RAVI, PRIYA]) {
            assert.equal(clientForConnect(db, config, who)?.clientId ?? null, expected(plan, deployment, saved, who), who);
          }
        });
      }
    }
  }

  test("with FEATURE_GMAIL_BYO off, saved keys are ignored and only the deployment's client counts", () => {
    const db = household();
    saveClient(db, cfg("selfhost"), ravi, { scope: "member", ...MINE });
    assert.equal(clientForConnect(db, cfg("selfhost", { deployment: true, byo: false }), RAVI)?.clientId, DEPLOY.clientId);
    assert.equal(clientForConnect(db, cfg("selfhost", { byo: false }), RAVI), null);
  });
});

describe("GMAIL-BYO · a connection renews under the client that made it", () => {
  test("own keys saved after a household connection do not take it over", () => {
    const db = household();
    const config = cfg("household");
    saveClient(db, config, priya, { scope: "household", ...HOME });
    saveConnection(db, ravi, { email: "r@x", refreshToken: "rt", scope: "s", clientId: HOME.clientId }, KEY);
    saveClient(db, config, ravi, { scope: "member", ...MINE });
    assert.equal(clientForConnection(db, config, RAVI, HOME.clientId).clientId, HOME.clientId);
  });

  test("removed keys ask for a reconnect", () => {
    const db = household();
    const config = cfg("solo");
    saveClient(db, config, ravi, { scope: "member", ...MINE });
    clearClient(db, ravi, "member");
    assert.throws(() => clientForConnection(db, config, RAVI, MINE.clientId),
      (e: unknown) => e instanceof Refusal && /connect Gmail again/.test(e.message));
  });

  test("a connection from before GMAIL-BYO (no client id) is the deployment's", () => {
    const db = household();
    assert.equal(clientForConnection(db, cfg("selfhost", { deployment: true }), RAVI, null).source, "deployment");
    assert.throws(() => clientForConnection(db, cfg("solo", { deployment: true }), RAVI, null), Refusal);
  });

  test("the refresh token is sealed with a key, readable without one when saved without one", () => {
    const db = household();
    saveConnection(db, ravi, { email: "r@x", refreshToken: "1//SECRET-rt", scope: "s" }, KEY);
    const sealed = getConnection(db, RAVI)!;
    assert.ok(!sealed.refresh_token.includes("SECRET"));
    assert.equal(refreshTokenOf(sealed, KEY), "1//SECRET-rt");
    assert.throws(() => refreshTokenOf(sealed, null), Refusal);
    assert.throws(() => refreshTokenOf(sealed, OTHER_KEY), Refusal);
    saveConnection(db, priya, { email: "p@x", refreshToken: "legacy", scope: "s" });
    assert.equal(refreshTokenOf(getConnection(db, PRIYA)!, KEY), "legacy");
  });
});

describe("GMAIL-BYO · over HTTP", () => {
  /** Records which client id each call to Google carried. */
  function google() {
    const seen: string[] = [];
    const impl = (async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("oauth2.googleapis.com/token")) {
        seen.push(new URLSearchParams(String(init?.body)).get("client_id") ?? "");
        return Response.json({ access_token: "at", refresh_token: "1//rt", expires_in: 3600, scope: "s" });
      }
      if (u.includes("/messages")) return Response.json({ messages: [], resultSizeEstimate: 0 });
      if (u.includes("/profile")) return Response.json({ historyId: "1" });
      return Response.json({});
    }) as typeof fetch;
    return { seen, impl };
  }

  for (const plan of PLANS) {
    test(`${plan}: no keys anywhere → Settings offers the form and connect says to add keys`, async () => {
      const db = household();
      const app = await startTestApp(db, { memberId: RAVI, config: cfg(plan) });
      try {
        const settings = await (await app.get("/settings")).text();
        assert.match(settings, /action="\/gmail\/keys"/);
        assert.match(settings, /http:\/\/127\.0\.0\.1\/gmail\/callback/);
        assert.doesNotMatch(settings, /href="\/gmail\/connect"/);
        const res = await app.get("/gmail/connect");
        assert.equal(res.status, 503);
        assert.match(await res.text(), /add your own Google keys/);
        assert.deepEqual(app.failures, []);
      } finally { await app.close(); }
    });

    test(`${plan}: household keys saved over HTTP → connect, callback, fetch all use them`, async () => {
      const db = household();
      const g = google();
      const app = await startTestApp(db, { memberId: RAVI, config: cfg(plan, { deployment: true }), fetchImpl: g.impl });
      try {
        const saved = await app.post("/gmail/keys", { scope: "household", client_id: HOME.clientId, client_secret: HOME.clientSecret });
        assert.ok(saved.status < 400, `saved ${saved.status}`);
        const start = await app.get("/gmail/connect");
        const location = new URL(start.headers.get("location")!);
        assert.equal(location.searchParams.get("client_id"), HOME.clientId);
        const state = location.searchParams.get("state")!;
        const cb = await app.get(`/gmail/callback?state=${state}&code=c`);
        assert.ok(cb.status < 400, `callback ${cb.status}`);
        assert.equal(getConnection(db, RAVI)!.client_id, HOME.clientId);
        assert.ok(!getConnection(db, RAVI)!.refresh_token.includes("1//rt"), "the token is sealed");
        const fetched = await app.post("/gmail/fetch", {});
        assert.ok(fetched.status < 400, `fetch ${fetched.status}`);
        assert.deepEqual(g.seen, [HOME.clientId, HOME.clientId]);
        assert.deepEqual(app.failures, []);
      } finally { await app.close(); }
    });
  }

  test("selfhost with only the deployment's client works as before, and stores no client id", async () => {
    const db = household();
    const g = google();
    const app = await startTestApp(db, { memberId: RAVI, config: cfg("selfhost", { deployment: true, key: false }), fetchImpl: g.impl });
    try {
      const start = await app.get("/gmail/connect");
      const location = new URL(start.headers.get("location")!);
      assert.equal(location.searchParams.get("client_id"), DEPLOY.clientId);
      await app.get(`/gmail/callback?state=${location.searchParams.get("state")}&code=c`);
      assert.equal(getConnection(db, RAVI)!.client_id, null);
      assert.equal(getConnection(db, RAVI)!.refresh_token, "1//rt", "no key: stored as it always was");
      await app.post("/gmail/fetch", {});
      assert.deepEqual(g.seen, [DEPLOY.clientId, DEPLOY.clientId]);
      const settings = await (await app.get("/settings")).text();
      assert.match(settings, /no <code>SECRETS_KEY<\/code> set/);
    } finally { await app.close(); }
  });

  test("keys changed between connect and callback: start again, nothing saved", async () => {
    const db = household();
    const g = google();
    const config = cfg("solo");
    saveClient(db, config, ravi, { scope: "household", ...HOME });
    const app = await startTestApp(db, { memberId: RAVI, config, fetchImpl: g.impl });
    try {
      const start = await app.get("/gmail/connect");
      const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
      saveClient(db, config, ravi, { scope: "member", ...MINE });
      const cb = await app.get(`/gmail/callback?state=${state}&code=c`);
      assert.equal(cb.status, 400);
      assert.equal(getConnection(db, RAVI), null);
      assert.deepEqual(g.seen, []);
    } finally { await app.close(); }
  });

  test("saving keys without SECRETS_KEY is refused and stores nothing", async () => {
    const db = household();
    const app = await startTestApp(db, { memberId: RAVI, config: cfg("solo", { key: false }) });
    try {
      const res = await app.post("/gmail/keys", { scope: "member", client_id: MINE.clientId, client_secret: MINE.clientSecret });
      assert.ok(res.status < 500);
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM gmail_clients").get()!.n, 0);
      assert.deepEqual(app.failures, []);
    } finally { await app.close(); }
  });

  test("both switches off: every Gmail page is gone, and Settings has no Gmail section", async () => {
    const db = household();
    const app = await startTestApp(db, { memberId: RAVI, config: cfg("solo", { byo: false }) });
    try {
      for (const path of ["/gmail/connect"]) assert.equal((await app.get(path)).status, 404, path);
      for (const path of ["/gmail/keys", "/gmail/fetch"]) assert.equal((await app.post(path, {})).status, 404, path);
      assert.doesNotMatch(await (await app.get("/settings")).text(), /id="gmail"/);
    } finally { await app.close(); }
  });
});
