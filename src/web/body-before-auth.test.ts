/**
 * A request body is read for somebody the app has let in, not for anybody.
 *
 * The server buffered every POST body — up to 12 MB — before the middleware
 * that decides whether the sender is signed in had run. Twenty anonymous
 * connections each declaring 12 MB held a quarter of a gigabyte of a small
 * box's memory, and none of them had to be anybody.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { connect } from "node:net";
import { freshDb, seedMember, startTestApp } from "./harness.test-data.ts";

/**
 * Send the headers and a little of a body that claims to be much larger, and
 * report the status line if one arrives within `ms` — or null if the server
 * sat waiting for the rest.
 */
function partialPost(
  baseUrl: string, path: string, declared: number, sent: number, ms = 1500,
  extra: Record<string, string> = {},
): Promise<number | null> {
  const { hostname, port } = new URL(baseUrl);
  return new Promise((resolve) => {
    const socket = connect(Number(port), hostname);
    let buffer = "";
    const timer = setTimeout(() => { socket.destroy(); resolve(null); }, ms);
    socket.on("data", (chunk) => {
      buffer += chunk.toString("latin1");
      const m = /^HTTP\/1\.1 (\d{3})/.exec(buffer);
      if (m) { clearTimeout(timer); socket.destroy(); resolve(Number(m[1])); }
    });
    socket.on("error", () => { clearTimeout(timer); resolve(null); });
    const headers = {
      Host: `${hostname}:${port}`,
      "Content-Type": "application/x-www-form-urlencoded",
      "Content-Length": String(declared),
      Origin: baseUrl,
      ...extra,
    };
    socket.write(
      `POST ${path} HTTP/1.1\r\n` +
      Object.entries(headers).map(([k, v]) => `${k}: ${v}\r\n`).join("") +
      "\r\n" + "a=".padEnd(sent, "x"),
    );
  });
}

describe("request bodies and authentication", () => {
  test("an anonymous write is answered without waiting for its body", async () => {
    const db = freshDb();
    seedMember(db, "m-ravi", "Ravi");
    const app = await startTestApp(db, { memberId: null });
    try {
      const status = await partialPost(app.baseUrl, "/transactions", 12 * 1024 * 1024 - 1, 1024);
      assert.notEqual(status, null, "the server waited for 12 MB from somebody not signed in");
      assert.ok(status === 303 || status === 401, `status ${status}`);
    } finally {
      await app.close();
    }
  });

  test("a sign-in form is not a 12 MB upload", async () => {
    const db = freshDb();
    seedMember(db, "m-ravi", "Ravi");
    const app = await startTestApp(db, { memberId: null, config: { localLogin: true } });
    try {
      const status = await partialPost(app.baseUrl, "/auth/password", 4 * 1024 * 1024, 1024 * 1024, 3000);
      assert.equal(status, 413);
    } finally {
      await app.close();
    }
  });

  test("a signed-in member's ordinary form post still works", async () => {
    const db = freshDb();
    seedMember(db, "m-ravi", "Ravi");
    const app = await startTestApp(db, { memberId: "m-ravi" });
    try {
      const res = await app.post("/settings/theme", { theme: "dark", return_to: "/settings" });
      assert.equal(res.status, 303);
      assert.deepEqual(app.failures, []);
    } finally {
      await app.close();
    }
  });

  test("password sign-in still reads its form", async () => {
    const db = freshDb();
    seedMember(db, "m-ravi", "Ravi");
    const app = await startTestApp(db, { memberId: null, config: { localLogin: true } });
    try {
      const res = await app.post("/auth/password", { email: "m-ravi@example.com", password: "wrong wrong wrong" });
      // Refused for the password, not for an unread body.
      assert.notEqual(res.status, 413);
      assert.notEqual(res.status, 500);
      assert.match(await res.text(), /password|email/i);
    } finally {
      await app.close();
    }
  });
});
