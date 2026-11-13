// Property check: random domain operations in one budget, then the identity (docs/dev/01-engine-derivation.md §1) in every month, live and through the rollup. FUZZ_SEEDS raises the count.
import { test } from "node:test";
import assert from "node:assert/strict";
import { openDatabase, ensureHousehold, execute } from "../db/db.ts";
import { nowIST, addMonths, monthOf, todayIST, daysInMonth } from "../core/dates.ts";
import { formatPaise } from "../core/money.ts";
import type { Actor } from "../core/events.ts";
import { createAccount, createCard } from "../domain/accounts.ts";
import { createGroup, createCategory, setAssigned, setHeld, moveMoney } from "../domain/budget.ts";
import { createTransaction, createTransfer, deleteTransaction, updateTransaction } from "../domain/transactions.ts";
import { loadEngineInput } from "./repository.ts";
import { computeBudget, identityResidual, cardFunding } from "./engine.ts";

const actor: Actor = { memberId: "m", source: "ui" };

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const SEEDS = Number(process.env.FUZZ_SEEDS ?? 20);

for (let seed = 1; seed <= SEEDS; seed++) {
  test(`identity fuzz seed ${seed}`, () => {
    const r = rng(seed);
    const pick = <T>(xs: T[]): T => xs[Math.floor(r() * xs.length)]!;
    const amt = () => Math.round(r() * 5000000) + 1;
    const db = openDatabase({ path: ":memory:", verbose: false });
    ensureHousehold(db);
    execute(db, `INSERT INTO members (id,email,name,created_at) VALUES (?,?,?,?)`, "m", "f@e.com", "Ravi", nowIST());
    const model = r() < 0.5 ? "reduce-rta" : "carry-negative";
    execute(db, `UPDATE household SET overspend_model = ? WHERE id = 1`, model);
    const now = monthOf(todayIST());
    const months = 3 + Math.floor(r() * 12);
    const start = addMonths(now, -(months - 1));
    const opened = `${start}-01` as never;
    const bank = createAccount(db, actor, { name: "Bank", kind: "budget", subtype: "savings", openingDate: opened, openingBalance: amt() }).id;
    const cash = createAccount(db, actor, { name: "Cash", kind: "budget", subtype: "cash", openingDate: opened, openingBalance: amt() }).id;
    const cards: string[] = [];
    for (let i = 0; i < 2; i++) {
      const c = createAccount(db, actor, { name: `Card${i}`, kind: "credit", subtype: "credit-card", openingDate: opened, openingBalance: r() < 0.5 ? -amt() : 0 }).id;
      createCard(db, actor, { accountId: c, label: `Card${i}`, last4: `111${i}`, holderMemberId: "m" });
      cards.push(c);
    }
    const gold = createAccount(db, actor, { name: "Gold", kind: "tracking", subtype: "asset", openingDate: opened, openingBalance: 0 }).id;
    const g = createGroup(db, actor, "Flex");
    const cats = ["A", "B", "C", "D"].map((n) => createCategory(db, actor, { groupId: g.id, name: n }).id);
    const txns: string[] = [];
    const log: string[] = [];
    const ops = 30 + Math.floor(r() * 80);
    for (let i = 0; i < ops; i++) {
      const m = addMonths(start, Math.floor(r() * months));
      const day = 1 + Math.floor(r() * daysInMonth(Number(m.slice(0, 4)), Number(m.slice(5))));
      const date = `${m}-${String(day).padStart(2, "0")}` as never;
      const op = r();
      try {
        if (op < 0.15) {
          txns.push(createTransaction(db, actor, { accountId: pick([bank, cash]), amount: amt() * 3, date, payeeName: "Salary" }).id);
          log.push(`income ${date}`);
        } else if (op < 0.4) {
          const acct = pick([bank, cash, ...cards]);
          const cat = r() < 0.85 ? pick(cats) : undefined;
          const sign = r() < 0.9 ? -1 : 1;
          txns.push(createTransaction(db, actor, { accountId: acct, amount: sign * amt(), date, categoryId: cat, payeeName: "Shop" }).id);
          log.push(`spend ${acct} ${cat} ${date} ${sign}`);
        } else if (op < 0.5) {
          const acct = pick([bank, ...cards]);
          const a = amt();
          const c1 = pick(cats); const c2 = pick(cats.filter((c) => c !== c1));
          txns.push(createTransaction(db, actor, { accountId: acct, amount: -a, date, payeeName: "Split", splits: [{ categoryId: c1, amount: -Math.floor(a / 2) }, { categoryId: c2, amount: -(a - Math.floor(a / 2)) }] }).id);
          log.push(`split ${acct} ${date}`);
        } else if (op < 0.6) {
          const [t1] = createTransfer(db, actor, { fromAccountId: pick([bank, cash]), toAccountId: pick([...cards, gold, cash, bank]), amount: amt(), date });
          txns.push(t1.id);
          log.push(`transfer ${date}`);
        } else if (op < 0.75) {
          const mm = addMonths(start, Math.floor(r() * (months + 2)));
          setAssigned(db, actor, mm, pick(cats), amt());
          log.push(`assign ${mm}`);
        } else if (op < 0.8) {
          moveMoney(db, actor, { month: m, fromCategoryId: cats[0]!, toCategoryId: cats[1]!, amount: amt() });
          log.push(`move ${m}`);
        } else if (op < 0.85) {
          setHeld(db, actor, m, amt());
          log.push(`held ${m}`);
        } else if (op < 0.92 && txns.length) {
          const id = pick(txns);
          deleteTransaction(db, actor, id);
          log.push(`delete ${id}`);
        } else if (txns.length) {
          const id = pick(txns);
          updateTransaction(db, actor, id, { categoryId: r() < 0.3 ? null : pick(cats), date } as never);
          log.push(`update ${id} ${date}`);
        }
      } catch (e) {
        log.push(`refused: ${(e as Error).message.slice(0, 60)}`);
      }
    }
    for (const useRollup of [true, false]) {
      const input = loadEngineInput(db, { through: now, useRollup });
      const budget = computeBudget(input);
      const broken: string[] = [];
      for (const [month, state] of budget) {
        const res = identityResidual(state);
        if (res !== 0) broken.push(`${month} out by ${formatPaise(res)}`);
      }
      assert.deepEqual(broken, [], `model ${model} rollup ${useRollup}\n${log.join("\n")}`);
    }
    void cardFunding; if (process.env.FUZZ_LOG) console.log(log.filter(l=>l.startsWith("refused")).join("\n"), log.length);
    db.close();
  });
}
