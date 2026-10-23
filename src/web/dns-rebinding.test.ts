/**
 * A write must be addressed to this app by a name it answers to.
 *
 * The same-origin check accepted an Origin equal to the request's own Host.
 * Under DNS rebinding those two agree by construction: a page on
 * evil.example re-points its own name at this machine's LAN address, and
 * posts to evil.example — the Origin is evil.example, and so is the Host. On
 * a fresh LAN install with LOCAL_LOGIN that post reaches /auth/first-run and
 * creates the household's first member with the attacker's password, before
 * the owner has opened the page.
 *
 * The Host is now held to BASE_URL's host and port first. An IP literal or
 * `localhost` is still accepted, because no DNS answer is involved in reaching
 * either, so neither can be rebound — the LAN address the household actually
 * types keeps working.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { freshDb, seedMember, startTestApp, type TestApp } from "./harness.test-data.ts";
import { memberCount } from "../auth/sessions.ts";
import type { Config } from "../config.ts";

/** A raw POST, because `fetch` will not send a Host it did not choose. */
function post(
  app: TestApp, path: string, headers: Record<string, string>, form: Record<string, string> = {},
): Promise<number> {
  const u = new URL(app.baseUrl);
  const body = new URLSearchParams(form).toString();
  return new Promise((ok, fail) => {
    const req = request(
      {
        host: u.hostname, port: u.port, method: "POST", path,
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "Content-Length": String(Buffer.byteLength(body)),
          ...headers,
        },
      },
      (res) => { res.resume(); res.on("end", () => ok(res.statusCode!)); },
    );
    req.on("error", fail);
    req.end(body);
  });
}

const FIRST_RUN = {
  email: "attacker@evil.example", name: "Not the owner", password: "a long enough attacker password",
};

async function freshInstall(config: Partial<Config>) {
  const db = freshDb();
  const app = await startTestApp(db, {
    memberId: null,
    config: { localLogin: true, baseUrl: "http://budget.lan:3000", ...config },
  });
  return { db, app };
}

describe("DNS rebinding against a fresh LAN install", () => {
  test("a rebound name cannot create the first member", async () => {
    const { db, app } = await freshInstall({});
    try {
      const port = new URL(app.baseUrl).port;
      const status = await post(app, "/auth/first-run", {
        Host: `evil.example:${port}`, Origin: `http://evil.example:${port}`,
      }, FIRST_RUN);
      assert.equal(status, 403);
      assert.equal(memberCount(db), 0, "the attacker owns the household");
    } finally {
      await app.close();
    }
  });

  test("nor by naming itself in X-Forwarded-Host behind a trusted proxy", async () => {
    const { db, app } = await freshInstall({ trustProxy: true });
    try {
      const status = await post(app, "/auth/first-run", {
        Host: "budget.lan:3000",
        "X-Forwarded-Host": "evil.example", Origin: "http://evil.example",
      }, FIRST_RUN);
      assert.equal(status, 403);
      assert.equal(memberCount(db), 0);
    } finally {
      await app.close();
    }
  });

  test("the configured name is let through", async () => {
    const { db, app } = await freshInstall({});
    try {
      const status = await post(app, "/auth/first-run", {
        Host: "budget.lan:3000", Origin: "http://budget.lan:3000",
      }, FIRST_RUN);
      assert.equal(status, 303);
      assert.equal(memberCount(db), 1);
    } finally {
      await app.close();
    }
  });

  test("the configured name on another port is not", async () => {
    const { db, app } = await freshInstall({});
    try {
      const status = await post(app, "/auth/first-run", {
        Host: "budget.lan:8443", Origin: "http://budget.lan:8443",
      }, FIRST_RUN);
      assert.equal(status, 403);
      assert.equal(memberCount(db), 0);
    } finally {
      await app.close();
    }
  });

  test("the LAN address the household types is let through", async () => {
    // An IP literal involves no DNS answer, so it cannot be rebound.
    const { db, app } = await freshInstall({});
    try {
      const status = await post(app, "/auth/first-run", {
        Host: "192.168.1.20:3000", Origin: "http://192.168.1.20:3000",
      }, FIRST_RUN);
      assert.equal(status, 303);
      assert.equal(memberCount(db), 1);
    } finally {
      await app.close();
    }
  });

  test("and so is localhost on a dev machine", async () => {
    const { db, app } = await freshInstall({ baseUrl: "http://127.0.0.1:3000" });
    try {
      const status = await post(app, "/auth/first-run", {
        Host: "localhost:3000", Origin: "http://localhost:3000",
      }, FIRST_RUN);
      assert.equal(status, 303);
      assert.equal(memberCount(db), 1);
    } finally {
      await app.close();
    }
  });
});

describe("a signed-in write addressed by a foreign name", () => {
  test("is refused even with an Origin matching BASE_URL", async () => {
    const db = freshDb();
    seedMember(db, "m-ravi", "Ravi");
    const app = await startTestApp(db, { memberId: "m-ravi", config: { baseUrl: "http://budget.lan:3000" } });
    try {
      const status = await post(app, "/settings/theme", {
        Host: "evil.example", Origin: "http://budget.lan:3000",
      }, { theme: "dark" });
      assert.equal(status, 403);
    } finally {
      await app.close();
    }
  });
});
