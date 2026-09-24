/**
 * The retirement projection, and the four ways it could lie.
 *
 * Every assertion here exists because the same mistake would read as a
 * plausible number rather than an obvious fault. A FIRE target is annual
 * expenses multiplied by twenty-five or more, so an error in the expense
 * measure arrives multiplied by twenty-five too — which is the difference
 * between "you need ₹3 crore" and "you need ₹60 lakh", told to somebody making
 * a decision about the rest of their life.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { openDatabase, ensureHousehold, execute } from "../db/db.ts";
import { nowIST } from "../core/dates.ts";
import { rupees } from "../core/money.ts";
import type { Actor } from "../core/events.ts";
import { createAccount } from "./accounts.ts";
import { createGroup, createCategory } from "./budget.ts";
import { createTransaction } from "./transactions.ts";
import { createAssetAccount, recordValuation } from "./assets.ts";
import { fireProjection, yearsToTarget, DEFAULT_ASSUMPTIONS } from "./fire.ts";

const actor: Actor = { memberId: "m", source: "ui" };
const ASOF = "2026-09-30";

function household() {
  const db = openDatabase({ path: ":memory:", verbose: false });
  ensureHousehold(db);
  execute(db, `INSERT INTO members (id,email,name,created_at) VALUES (?,?,?,?)`,
    "m", "f@e.com", "Ravi", nowIST());
  execute(db, `INSERT INTO members (id,email,name,created_at) VALUES (?,?,?,?)`,
    "m2", "p@e.com", "Priya", nowIST());
  const bank = createAccount(db, actor, {
    name: "HDFC", kind: "budget", subtype: "savings",
    openingDate: "2025-09-01", openingBalance: rupees(200000),
  }).id;
  const card = createAccount(db, actor, {
    name: "Atlas", kind: "credit", subtype: "credit-card",
    openingDate: "2025-09-01", openingBalance: 0,
  }).id;
  const group = createGroup(db, actor, "Flexible");
  const groceries = createCategory(db, actor, { groupId: group.id, name: "Groceries" }).id;
  return { db, bank, card, groceries };
}

describe("the expense measure a FIRE number is built on", () => {
  test("card spending counts, because otherwise the target is a fraction of the truth", () => {
    const { db, bank, card, groceries } = household();
    // ₹1,000 a month from the bank, ₹9,000 a month on the card.
    for (let m = 10; m <= 12; m++) {
      const month = `2025-${String(m).padStart(2, "0")}`;
      createTransaction(db, actor, {
        accountId: bank, amount: -rupees(1000), date: `${month}-05`, categoryId: groceries,
      });
      createTransaction(db, actor, {
        accountId: card, amount: -rupees(9000), date: `${month}-06`, categoryId: groceries,
      });
    }

    const p = fireProjection(db, { asOf: ASOF });

    // ₹30,000 over the window, annualised. If the card were missed it would be
    // ₹3,000 — and the FIRE number a tenth of what it should be.
    assert.equal(p.annualExpenses, rupees(30_000));
    assert.ok(
      p.fireNumber > rupees(800_000),
      `a target of ${p.fireNumber} paise means the card spending went missing`,
    );
  });

  test("paying the card is not spending, or every card rupee counts twice", () => {
    const { db, bank, card, groceries } = household();
    createTransaction(db, actor, {
      accountId: card, amount: -rupees(10000), date: "2025-10-06", categoryId: groceries,
    });
    const before = fireProjection(db, { asOf: ASOF }).annualExpenses;

    // Settle the card. The money leaves the bank, but nothing is consumed.
    createTransaction(db, actor, {
      accountId: bank, amount: -rupees(10000), date: "2025-11-02", categoryId: null,
    });
    const after = fireProjection(db, { asOf: ASOF }).annualExpenses;

    assert.equal(after, before, "settling a card inflated the cost of living");
  });
});

describe("what counts as a retirement, and what only looks like one", () => {
  test("a flat is excluded and an index fund is not", () => {
    const { db } = household();
    const fund = createAssetAccount(db, actor, {
      name: "Index fund", subtype: "investment", currency: "INR",
    });
    const flat = createAssetAccount(db, actor, {
      name: "Flat in Kochi", subtype: "physical", currency: "INR",
    });
    recordValuation(db, actor, { accountId: fund.id, value: rupees(2_000_000), asOf: "2026-09-01" });
    recordValuation(db, actor, { accountId: flat.id, value: rupees(9_000_000), asOf: "2026-09-01" });

    const p = fireProjection(db, { asOf: ASOF });

    assert.ok(
      p.drawableLines.some((l) => l.label === "Index fund"),
      "the fund is not counted",
    );
    assert.ok(
      p.excludedLines.some((l) => l.label === "Flat in Kochi"),
      "the flat was treated as spendable — you cannot sell a tenth of it a year",
    );
    assert.equal(p.excluded, rupees(9_000_000));
    // Cash ₹2,00,000 opening + the fund.
    assert.equal(p.drawableNow, rupees(2_200_000));
  });

  test("a provident fund is real money, held apart because it is locked", () => {
    const { db } = household();
    const epf = createAssetAccount(db, actor, {
      name: "EPF", subtype: "retirement", currency: "INR",
    });
    recordValuation(db, actor, { accountId: epf.id, value: rupees(1_500_000), asOf: "2026-09-01" });

    const counted = fireProjection(db, { asOf: ASOF });
    assert.equal(counted.lockedUntilRetirement, rupees(1_500_000));
    assert.equal(counted.corpus, counted.drawableNow + rupees(1_500_000));

    const ignored = fireProjection(db, {
      asOf: ASOF, assumptions: { includeLocked: false },
    });
    assert.equal(ignored.corpus, ignored.drawableNow, "a locked fund was counted anyway");
    assert.ok(ignored.corpus < counted.corpus);
  });

  test("a private account stays out of another member's projection", () => {
    const { db } = household();
    const mine = createAssetAccount(db, actor, {
      name: "Her fund", subtype: "investment", currency: "INR",
    });
    execute(db, `UPDATE accounts SET visibility = 'private', holder_member_id = ? WHERE id = ?`,
      "m2", mine.id);
    recordValuation(db, actor, { accountId: mine.id, value: rupees(5_000_000), asOf: "2026-09-01" });

    const hers = fireProjection(db, { asOf: ASOF, viewerMemberId: "m2" });
    const his = fireProjection(db, { asOf: ASOF, viewerMemberId: "m" });

    assert.ok(hers.drawableNow > his.drawableNow, "the holder cannot see their own account");
    assert.ok(
      !his.drawableLines.some((l) => l.label === "Her fund"),
      "a private account was named to somebody else",
    );
    assert.ok(
      his.corpus < rupees(5_000_000),
      "the total published a private balance by including it",
    );
  });
});

describe("the arithmetic of getting there", () => {
  test("already past the target is nought years, not a negative one", () => {
    assert.equal(yearsToTarget(1_000, 100, 0.05, 500), 0);
  });

  test("saving nothing with nothing invested never arrives", () => {
    assert.equal(yearsToTarget(0, 0, 0.05, 1_000), null);
    assert.equal(yearsToTarget(100, 0, 0, 1_000), null);
  });

  test("with no growth it is plain division", () => {
    assert.equal(yearsToTarget(0, 100, 0, 1_000), 10);
  });

  test("compounding is solved, not guessed", () => {
    // ₹1,00,000 at 10%, no contributions, doubling: ln2/ln1.1 = 7.27 years.
    const years = yearsToTarget(100_000, 0, 0.10, 200_000)!;
    assert.ok(Math.abs(years - 7.2725) < 0.01, `got ${years}`);
  });

  test("a plan a century out is reported as no plan at all", () => {
    assert.equal(yearsToTarget(1, 1, 0, 1_000_000), null);
  });
});

describe("the projection counts no further earnings", () => {
  /** Same corpus, same spending, wildly different salaries. */
  function withIncome(extraIncome: number) {
    const { db, bank, groceries } = household();
    createTransaction(db, actor, {
      accountId: bank, amount: -rupees(120_000), date: "2025-10-05", categoryId: groceries,
    });
    if (extraIncome > 0) {
      createTransaction(db, actor, {
        accountId: bank, amount: rupees(extraIncome), date: "2025-10-01", categoryId: null,
      });
      // Spent again immediately, so the corpus ends where the other one does
      // and only the *income* differs.
      createTransaction(db, actor, {
        accountId: bank, amount: -rupees(extraIncome), date: "2025-10-02", categoryId: null,
      });
    }
    return fireProjection(db, { asOf: ASOF });
  }

  test("a large salary does not bring the date forward", () => {
    const poor = withIncome(0);
    const rich = withIncome(5_000_000);

    assert.equal(rich.corpus, poor.corpus, "the fixture changed the corpus, not just income");
    assert.ok(rich.annualIncome > poor.annualIncome, "the fixture did not change income");
    assert.equal(
      rich.yearsToFire, poor.yearsToFire,
      "future earnings were projected forward; this screen must not assume them",
    );
  });

  test("income is still reported, because it explains the gap", () => {
    const p = withIncome(5_000_000);
    assert.ok(p.annualIncome > 0, "income was dropped rather than merely excluded from the maths");
    assert.ok(p.savingsRatePct !== null);
  });

  test("with nothing invested, growth alone never arrives", () => {
    const db = household().db;
    const p = fireProjection(db, { asOf: ASOF });
    // No spending recorded, so no target; and with a target but no corpus,
    // compounding zero is still zero.
    assert.equal(yearsToTarget(0, 0, 0.05, 1_000_000), null);
    assert.equal(p.yearsToFire, null);
  });
});

describe("the projected date", () => {
  test("is a well-formed month, not a mangled date", () => {
    const { db, bank, groceries } = household();
    // Comfortably short of the target, so the projection is genuinely in the
    // future and the month arithmetic actually has to run.
    createTransaction(db, actor, {
      accountId: bank, amount: rupees(300_000), date: "2025-10-01", categoryId: null,
    });
    createTransaction(db, actor, {
      accountId: bank, amount: -rupees(120_000), date: "2025-10-05", categoryId: groceries,
    });

    const p = fireProjection(db, { asOf: ASOF });
    assert.ok(p.yearsToFire !== null && p.yearsToFire > 0, `got ${p.yearsToFire} years`);
    // addMonths works on YYYY-MM. Handing it a full date produced "-Na-0NaN",
    // which rendered on the page as somebody's retirement date.
    assert.match(p.fireMonth!, /^\d{4}-\d{2}$/, `got ${p.fireMonth}`);
    assert.ok(p.fireMonth! > "2026-09", `${p.fireMonth} is not in the future`);
  });

  test("arriving already is this month, not a date in the past", () => {
    const { db, bank, groceries } = household();
    createTransaction(db, actor, {
      accountId: bank, amount: -rupees(1_000), date: "2025-10-05", categoryId: groceries,
    });
    const p = fireProjection(db, { asOf: ASOF });
    assert.equal(p.yearsToFire, 0, "a household past its target has nothing to wait for");
    assert.equal(p.fireMonth, "2026-09");
  });
});

describe("the bridge to a provident fund", () => {
  test("retiring at forty must fund twenty years before the fund opens", () => {
    const { db, bank, groceries } = household();
    for (let m = 10; m <= 12; m++) {
      createTransaction(db, actor, {
        accountId: bank, amount: -rupees(25_000),
        date: `2025-${String(m).padStart(2, "0")}-05`, categoryId: groceries,
      });
    }
    const epf = createAssetAccount(db, actor, {
      name: "EPF", subtype: "retirement", currency: "INR",
    });
    recordValuation(db, actor, { accountId: epf.id, value: rupees(5_000_000), asOf: "2026-09-01" });

    const p = fireProjection(db, { asOf: ASOF, assumptions: { currentAge: 40 } });

    assert.ok(p.bridgeYears !== null, "no bridge was computed for somebody with a locked fund");
    assert.ok(p.bridgeYears! > 0, "a 40-year-old was assumed to reach 60 immediately");
    assert.equal(typeof p.bridgeCovered, "boolean");
  });

  test("with no age given there is no bridge claim, rather than a wrong one", () => {
    const { db } = household();
    const epf = createAssetAccount(db, actor, {
      name: "EPF", subtype: "retirement", currency: "INR",
    });
    recordValuation(db, actor, { accountId: epf.id, value: rupees(100_000), asOf: "2026-09-01" });

    const p = fireProjection(db, { asOf: ASOF });
    assert.equal(p.bridgeYears, null);
    assert.equal(p.bridgeCovered, null);
  });
});

describe("the figure carries its own caveats", () => {
  test("a short history is flagged, because a trailing year needs a year", () => {
    const { db, bank, groceries } = household();
    // History starts with the first account opened as well as the first
    // transaction (an account open for a year with quiet months has a year of
    // history), so a household that is actually new opens its accounts late.
    execute(db, `UPDATE accounts SET opening_date = '2026-09-01'`);
    createTransaction(db, actor, {
      accountId: bank, amount: -rupees(5_000), date: "2026-09-05", categoryId: groceries,
    });
    assert.equal(fireProjection(db, { asOf: ASOF }).windowIsShort, true);
  });

  test("the 4% comparison is offered next to the conservative default", () => {
    const { db, bank, groceries } = household();
    createTransaction(db, actor, {
      accountId: bank, amount: -rupees(120_000), date: "2025-10-05", categoryId: groceries,
    });
    const p = fireProjection(db, { asOf: ASOF });

    assert.equal(DEFAULT_ASSUMPTIONS.withdrawalRateBp, 350);
    assert.ok(
      p.fireNumberAtFourPercent < p.fireNumber,
      "the familiar rule should ask for less than the cautious one",
    );
  });

  test("no income means no savings rate, rather than a division by zero", () => {
    const { db, bank, groceries } = household();
    createTransaction(db, actor, {
      accountId: bank, amount: -rupees(1_000), date: "2025-10-05", categoryId: groceries,
    });
    assert.equal(fireProjection(db, { asOf: ASOF }).savingsRatePct, null);
  });
});
