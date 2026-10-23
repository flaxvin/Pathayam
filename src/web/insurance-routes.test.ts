/**
 * INSURANCE-1 · The policy register, through the routes.
 *
 * Priya is signed in; Ravi holds one private policy and the household one
 * shared. Every per-policy URL aimed at Ravi's answers 404 and changes
 * nothing; the shared one renews on Overview's "Due soon" and can be marked
 * paid from there; and the tax page offers what Priya's own policies come to,
 * filling the form only when asked.
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { freshDb, seedMember, startTestApp, type TestApp } from "./harness.test-data.ts";
import type { Actor } from "../core/events.ts";
import { rupees, type Paise } from "../core/money.ts";
import { addDays, todayIST, fiscalYearOf } from "../core/dates.ts";
import { createPolicy, getPolicy } from "../domain/insurance.ts";
import { getDeclaration } from "../domain/tax.ts";

const RAVI = "m-ravi";
const PRIYA = "m-priya";
const ravi: Actor = { memberId: RAVI, source: "ui" };
const SECRET = "Manticore Mutual";

describe("INSURANCE-1 · the register, as the wrong member", () => {
  let app: TestApp;
  let secretId: string;
  let sharedId: string;
  const due = addDays(todayIST(), 5);

  before(async () => {
    const db = freshDb();
    seedMember(db, RAVI, "Ravi");
    seedMember(db, PRIYA, "Priya");
    secretId = createPolicy(db, ravi, {
      insurer: SECRET, kind: "term-life", premium: rupees(21_000) as Paise, frequency: "yearly",
      nextDue: due, taxGroup: "80c", holderMemberId: RAVI, visibility: "private",
    }).id;
    sharedId = createPolicy(db, ravi, {
      insurer: "Shared Shield Health", kind: "health", premium: rupees(24_000) as Paise,
      frequency: "yearly", nextDue: due, taxGroup: "80d-self", holderMemberId: PRIYA,
    }).id;
    app = await startTestApp(db, { memberId: PRIYA });
  });
  after(async () => {
    assert.deepEqual(app.failures, [], "nothing 500ed");
    await app.close();
  });

  test("the list shows the shared policy and not Ravi's", async () => {
    const body = await (await app.get("/insurance")).text();
    assert.ok(body.includes("Shared Shield Health"));
    assert.ok(!body.includes(SECRET), "Ravi's private policy is not listed");
  });

  test("every per-policy route answers 404 for Ravi's, and changes nothing", async () => {
    const res = await app.get(`/insurance/${secretId}`);
    assert.equal(res.status, 404);
    assert.ok(!(await res.text()).includes(SECRET));
    for (const [path, form] of [
      [`/insurance/${secretId}/edit`, { insurer: "Renamed", kind: "term-life", premium: "1", frequency: "yearly" }],
      [`/insurance/${secretId}/paid`, {}],
      [`/insurance/${secretId}/status`, { status: "lapsed" }],
      [`/insurance/${secretId}/delete`, {}],
    ] as [string, Record<string, string>][]) {
      assert.equal((await app.post(path, form)).status, 404, path);
    }
    const p = getPolicy(app.db, secretId)!;
    assert.equal(p.insurer, SECRET);
    assert.equal(p.next_due, due);
    assert.equal(p.status, "active");
  });

  test("the activity log and the export do not name it", async () => {
    assert.ok(!(await (await app.get("/activity")).text()).includes(SECRET));
    assert.ok(!(await (await app.get("/export.json")).text()).includes(SECRET));
  });

  test("the shared renewal is due soon on Overview, and Paid there moves it on", async () => {
    const overview = await (await app.get("/overview")).text();
    assert.ok(overview.includes("Shared Shield Health"), "listed under Due soon");
    assert.ok(overview.includes(`/insurance/${sharedId}/paid`));
    assert.ok(!overview.includes(SECRET));

    const res = await app.post(`/insurance/${sharedId}/paid`, { back: "/overview" });
    assert.equal(res.status, 303);
    assert.ok(res.headers.get("location")!.startsWith("/overview"));
    const year = Number(due.slice(0, 4)) + 1;
    assert.equal(getPolicy(app.db, sharedId)!.next_due!.slice(0, 4), String(year));
    const count = app.db.prepare(`SELECT COUNT(*) AS n FROM transactions`).get() as { n: number };
    assert.equal(count.n, 0, "nothing posted");
  });

  test("the tax page suggests her own policies' figures and fills them only when asked", async () => {
    const fy = fiscalYearOf(todayIST());
    const plain = await (await app.get(`/tax?fy=${fy}`)).text();
    assert.ok(plain.includes("From your policies"));
    assert.ok(plain.includes("Use these figures"));
    assert.ok(!plain.includes(SECRET), "Ravi's 80C policy is not Priya's suggestion");
    assert.ok(plain.includes(`name="s80d" inputmode="decimal" value="0.00"`), "nothing filled yet");

    const applied = await (await app.get(`/tax?fy=${fy}&from=policies`)).text();
    assert.ok(applied.includes(`name="s80d" inputmode="decimal" value="24000.00"`), "filled from the policy");
    assert.equal(getDeclaration(app.db, PRIYA, fy).s80d, 0, "and nothing saved");
  });
});

describe("INSURANCE-1 · the holder's own", () => {
  test("Ravi opens his private policy, and adds one through the form", async () => {
    const db = freshDb();
    seedMember(db, RAVI, "Ravi");
    seedMember(db, PRIYA, "Priya");
    const id = createPolicy(db, ravi, {
      insurer: SECRET, kind: "term-life", premium: rupees(21_000) as Paise, frequency: "yearly",
      holderMemberId: RAVI, visibility: "private",
    }).id;
    const app = await startTestApp(db, { memberId: RAVI });
    try {
      const res = await app.get(`/insurance/${id}`);
      assert.equal(res.status, 200);
      assert.ok((await res.text()).includes(SECRET));

      const made = await app.post("/insurance/new", {
        insurer: "Wheels Co", kind: "vehicle", premium: "9,000", frequency: "yearly",
        policy_number: "MOT-2026-55551234", next_due: "2027-01-15", tax_group: "none",
        holder_member_id: "", visibility: "household",
      });
      assert.equal(made.status, 303);
      const row = db.prepare(`SELECT policy_last4, premium FROM insurance_policies WHERE insurer = 'Wheels Co'`)
        .get() as { policy_last4: string; premium: number };
      assert.deepEqual({ ...row }, { policy_last4: "1234", premium: rupees(9_000) });

      const refused = await app.post("/insurance/new", {
        insurer: "Wheels Co", kind: "vehicle", premium: "9000", frequency: "yearly", tax_group: "80c",
      });
      assert.equal(refused.status, 422);
      assert.deepEqual(app.failures, []);
    } finally {
      await app.close();
    }
  });
});
