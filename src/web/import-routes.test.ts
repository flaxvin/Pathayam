/**
 * The import routes ask whether the viewer can see the account first.
 *
 * `POST /import`, `/import/pdf` and `/import/map` took `account_id` straight
 * from the form. An id that matched no account reached the INSERT into
 * import_batches and failed its foreign key — a 500, recorded as a server
 * fault, for a form value anyone can type. And an id that matched another
 * member's private account imported into it, which the rest of the app would
 * not even show them.
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Actor } from "../core/events.ts";
import type { DB } from "../db/db.ts";
import { queryOne, execute, newId } from "../db/db.ts";
import { nowIST } from "../core/dates.ts";
import { createGroup, createCategory } from "../domain/budget.ts";
import { resolvePayee } from "../domain/transactions.ts";
import { createAccount } from "../domain/accounts.ts";
import { STATEMENTS } from "../import/statements.test-data.ts";
import { startTestApp, seedMember, freshDb, type TestApp } from "./harness.test-data.ts";

const CSV = "Date,Narration,Amount\n02-09-2026,SHOP,-100.00";

let db: DB;
let app: TestApp;
let privateToPriya: string;

before(async () => {
  db = freshDb();
  seedMember(db, "m", "Ravi");
  seedMember(db, "p", "Priya");
  const priya: Actor = { memberId: "p", source: "ui" };
  privateToPriya = createAccount(db, priya, {
    name: "Priya's gold", kind: "tracking", subtype: "asset",
    openingDate: "2026-08-01", visibility: "private", holderMemberId: "p",
  }).id;
  app = await startTestApp(db, { memberId: "m" });
});
after(async () => {
  await app.close();
});

function batches(): number {
  return queryOne<{ n: number }>(db, `SELECT COUNT(*) AS n FROM import_batches`)!.n;
}

test("an unknown account is a 404 on every import route, not a foreign-key 500", async () => {
  const csv = await app.post("/import", { account_id: "no-such-account", csv: CSV });
  assert.equal(csv.status, 404);

  const map = await app.post("/import/map", {
    account_id: "no-such-account", csv: CSV, profile_name: "x",
    header_row: "0", date: "0", narration: "1", amount: "2",
  });
  assert.equal(map.status, 404);

  const form = new FormData();
  form.set("account_id", "no-such-account");
  form.set("statement", new Blob([STATEMENTS.hdfc], { type: "application/pdf" }), "hdfc.pdf");
  const pdf = await app.get("/import/pdf", {
    method: "POST", body: form, headers: { Origin: app.baseUrl },
  });
  assert.equal(pdf.status, 404);

  assert.deepEqual(app.failures, []);
  assert.equal(batches(), 0);
});

test("another member's private account cannot be imported into", async () => {
  const res = await app.post("/import", { account_id: privateToPriya, csv: CSV });
  assert.equal(res.status, 404);
  assert.equal(batches(), 0);
});

test("an auto-approved row is reported as added, not as waiting in Review", async () => {
  const ravi: Actor = { memberId: "m", source: "ui" };
  const account = createAccount(db, ravi, {
    name: "Ravi's savings", kind: "budget", subtype: "savings", openingDate: "2026-08-01",
  });
  const group = createGroup(db, ravi, "Flexible");
  const eatingOut = createCategory(db, ravi, { groupId: group.id, name: "Eating Out" }).id;
  resolvePayee(db, ravi, "Swiggy");
  execute(
    db,
    `INSERT INTO rules (id,name,stage,conditions_json,actions_json,enabled,proposed,created_at)
     VALUES (?,?,?,?,?,1,0,?)`,
    newId(), "Swiggy", "default",
    JSON.stringify([{ field: "merchant", op: "is", value: "Swiggy" }]),
    JSON.stringify([
      { type: "setPayee", payee: "Swiggy" }, { type: "setCategory", categoryId: eatingOut },
      { type: "markAutoApprovable" },
    ]),
    nowIST(),
  );

  // It read "1 to review, 1 auto-approved" and opened an empty Review.
  const res = await app.post("/import", {
    account_id: account.id, csv: "Date,Narration,Amount\n02-09-2026,UPI/P2M/SWIGGY*ORDER,-450.00",
  });
  assert.equal(res.status, 303);
  const location = decodeURIComponent(res.headers.get("location") ?? "");
  assert.match(location, /0 to review, 1 auto-approved/);
  assert.ok(location.startsWith("/import"), "nothing waits in Review, so it does not send you there");
});
