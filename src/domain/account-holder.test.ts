/**
 * H2 · Whose account is this.
 *
 * A household with two current accounts and four cards knows perfectly well
 * which belongs to whom, and until this existed there was nowhere to say so.
 * Transactions already carried an owner and cards a holder; accounts carried
 * nothing.
 *
 * The property that matters most is the one asserted last: the holder is inert.
 * `02` §3 is that there is one shared budget, and an account with a holder must
 * fund it exactly as an account without one does — otherwise this label would
 * have quietly become a second budget.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { openDatabase, ensureHousehold, execute, type DB } from "../db/db.ts";
import type { Actor } from "../core/events.ts";
import { nowIST } from "../core/dates.ts";
import { rupees } from "../core/money.ts";
import { createAccount, updateAccount, getAccount, listAccounts } from "./accounts.ts";
import { buildBudgetView } from "../web/viewmodel.ts";
import { monthOf, todayIST } from "../core/dates.ts";

const RAVI = "m-ravi";
const PRIYA = "m-priya";
const actor: Actor = { memberId: RAVI, source: "ui" };

function setup(): DB {
  const db = openDatabase({ path: ":memory:", verbose: false });
  ensureHousehold(db);
  for (const [id, name] of [[RAVI, "Ravi"], [PRIYA, "Priya"]] as const) {
    execute(db, `INSERT INTO members (id,email,name,created_at) VALUES (?,?,?,?)`,
      id, `${name.toLowerCase()}@example.com`, name, nowIST());
  }
  return db;
}

describe("H2 · an account can say whose it is", () => {
  test("a holder is optional, and absent means the household's", () => {
    const db = setup();
    const joint = createAccount(db, actor, {
      name: "Cash", kind: "budget", subtype: "cash", openingBalance: rupees(5_000),
    });
    assert.equal(getAccount(db, joint.id)!.holder_member_id, null);
    db.close();
  });

  test("a holder can be set when the account is made, and changed later", () => {
    const db = setup();
    const account = createAccount(db, actor, {
      name: "Kotak Savings", kind: "budget", subtype: "savings",
      openingBalance: rupees(58_000), holderMemberId: PRIYA,
    });
    assert.equal(getAccount(db, account.id)!.holder_member_id, PRIYA);

    updateAccount(db, actor, account.id, { holder_member_id: RAVI });
    assert.equal(getAccount(db, account.id)!.holder_member_id, RAVI);

    // Back to joint, which has to be expressible or a mistake is permanent.
    updateAccount(db, actor, account.id, { holder_member_id: null });
    assert.equal(getAccount(db, account.id)!.holder_member_id, null);
    db.close();
  });

  test("members can hold different accounts at once", () => {
    const db = setup();
    createAccount(db, actor, { name: "HDFC", kind: "budget", subtype: "savings", holderMemberId: RAVI });
    createAccount(db, actor, { name: "Kotak", kind: "budget", subtype: "savings", holderMemberId: PRIYA });
    createAccount(db, actor, { name: "Cash", kind: "budget", subtype: "cash" });

    const byHolder = new Map(listAccounts(db).map((a) => [a.name, a.holder_member_id]));
    assert.deepEqual([...byHolder.entries()].sort(), [
      ["Cash", null], ["HDFC", RAVI], ["Kotak", PRIYA],
    ]);
    db.close();
  });

  test("02 §3 · a held account funds the one shared budget, exactly as a joint one does", () => {
    // The whole risk of this feature is that it becomes a second budget by
    // accident. Two accounts, two holders, one Ready to Assign covering both.
    const db = setup();
    createAccount(db, actor, {
      name: "HDFC", kind: "budget", subtype: "savings",
      openingBalance: rupees(60_000), holderMemberId: RAVI,
    });
    createAccount(db, actor, {
      name: "Kotak", kind: "budget", subtype: "savings",
      openingBalance: rupees(40_000), holderMemberId: PRIYA,
    });

    const view = buildBudgetView(db, monthOf(todayIST()));
    assert.equal(
      view.monthState.readyToAssign, rupees(1_00_000),
      "both holders' money lands in the same Ready to Assign",
    );
    db.close();
  });
});
