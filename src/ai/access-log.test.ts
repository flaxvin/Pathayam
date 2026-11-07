import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { openDatabase, ensureHousehold, execute, queryOne } from "../db/db.ts";
import { nowIST } from "../core/dates.ts";
import { mintToken } from "../auth/tokens.ts";
import { recordAiAccess, listAiAccess, MAX_ROWS_PER_MEMBER, RETENTION_DAYS } from "./access-log.ts";

function setup() {
  const db = openDatabase({ path: ":memory:", verbose: false });
  ensureHousehold(db);
  for (const [id, name] of [["m-ravi", "Ravi"], ["m-priya", "Priya"]]) {
    execute(db, `INSERT INTO members (id,email,name,created_at) VALUES (?,?,?,?)`, id, `${id}@example.com`, name, nowIST());
  }
  const ravi = mintToken(db, { memberId: "m-ravi", source: "ui" }, { name: "Claude", scope: "read" }).token;
  const priya = mintToken(db, { memberId: "m-priya", source: "ui" }, { name: "ChatGPT", scope: "read" }).token;
  return { db, ravi, priya };
}

describe("AI-4 · the AI access log", () => {
  test("records the question, never the answer, and each member sees only their own", () => {
    const { db, ravi, priya } = setup();
    recordAiAccess(db, { tokenId: ravi.id, tokenName: ravi.name, memberId: "m-ravi", tool: "transactions", args: { payee: "Swiggy" }, ok: true, bytes: 1200 });
    recordAiAccess(db, { tokenId: priya.id, tokenName: priya.name, memberId: "m-priya", tool: "overview", args: {}, ok: false, bytes: 0 });

    const mine = listAiAccess(db, "m-ravi");
    assert.equal(mine.length, 1);
    assert.equal(mine[0]!.token_name, "Claude");
    assert.equal(mine[0]!.tool, "transactions");
    assert.equal(mine[0]!.arguments, `{"payee":"Swiggy"}`);
    assert.equal(mine[0]!.ok, 1);
    assert.equal(listAiAccess(db, "m-priya")[0]!.token_name, "ChatGPT");
    db.close();
  });

  test("long arguments are cut", () => {
    const { db, ravi } = setup();
    recordAiAccess(db, { tokenId: ravi.id, tokenName: ravi.name, memberId: "m-ravi", tool: "transactions", args: { text: "x".repeat(2000) }, ok: true, bytes: 1 });
    assert.ok(listAiAccess(db, "m-ravi")[0]!.arguments.length <= 501);
    db.close();
  });

  test("rows past retention go, and a member keeps at most the cap", () => {
    const { db, ravi } = setup();
    const old = nowIST(new Date(Date.now() - (RETENTION_DAYS + 1) * 86_400_000));
    execute(db, `INSERT INTO ai_access_log (token_id, token_name, member_id, tool, arguments, ok, bytes, at) VALUES (?,?,?,?,?,?,?,?)`,
      ravi.id, "Claude", "m-ravi", "old", "{}", 1, 1, old);
    recordAiAccess(db, { tokenId: ravi.id, tokenName: ravi.name, memberId: "m-ravi", tool: "new", args: {}, ok: true, bytes: 1 });
    assert.deepEqual(listAiAccess(db, "m-ravi").map((r) => r.tool), ["new"]);

    for (let i = 0; i < MAX_ROWS_PER_MEMBER + 5; i++) {
      execute(db, `INSERT INTO ai_access_log (token_id, token_name, member_id, tool, arguments, ok, bytes, at) VALUES (?,?,?,?,?,?,?,?)`,
        ravi.id, "Claude", "m-ravi", "bulk", "{}", 1, 1, nowIST());
    }
    recordAiAccess(db, { tokenId: ravi.id, tokenName: ravi.name, memberId: "m-ravi", tool: "last", args: {}, ok: true, bytes: 1 });
    const n = queryOne<{ n: number }>(db, `SELECT COUNT(*) AS n FROM ai_access_log WHERE member_id = ?`, "m-ravi")!.n;
    assert.equal(n, MAX_ROWS_PER_MEMBER);
    assert.equal(listAiAccess(db, "m-ravi", 1)[0]!.tool, "last");
    db.close();
  });

  test("an AI app's expired access token can be pruned with its reads still listed", () => {
    const { db, ravi } = setup();
    recordAiAccess(db, { tokenId: ravi.id, tokenName: ravi.name, memberId: "m-ravi", tool: "overview", args: {}, ok: true, bytes: 1 });
    execute(db, `DELETE FROM api_tokens WHERE id = ?`, ravi.id);
    assert.equal(listAiAccess(db, "m-ravi")[0]!.token_name, "Claude");
    db.close();
  });
});
