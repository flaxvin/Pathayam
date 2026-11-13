// Property check: household + two personal budgets, cross-budget filings, transfers, commitments, edits and undo; identityProblems() in every scope. FUZZ_SEEDS raises the count.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Actor } from "../core/events.ts";
import { addMonths, monthOf, todayIST, daysInMonth } from "../core/dates.ts";
import { createAccount, createCard } from "../domain/accounts.ts";
import { createTransfer, createTransaction, deleteTransaction, updateTransaction } from "../domain/transactions.ts";
import { ensurePersonalBudget } from "../domain/budgets.ts";
import { startPersonalBudget, createGroup, createCategory, setAssigned, moveMoney, setHeld } from "../domain/budget.ts";
import { ensureCommitmentEnvelope } from "../domain/commitments.ts";
import { callItEven } from "../domain/squaring-up.ts";
import { execute, queryAll } from "../db/db.ts";
import { undoEvent } from "../core/events.ts";
import { freshHousehold, identityProblems, RAVI, PRIYA } from "./identity.test-data.ts";

const HH = "budget-household";
function rng(seed: number) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
}
const SEEDS = Number(process.env.FUZZ_SEEDS ?? 15);

for (let seed = 1; seed <= SEEDS; seed++) {
  test(`multi-budget fuzz ${seed}`, () => {
    const r = rng(seed * 7919);
    const pick = <T>(xs: T[]): T => xs[Math.floor(r() * xs.length)]!;
    const amt = () => Math.round(r() * 3000000) + 1;
    const db = freshHousehold();
    const model = r() < 0.5 ? "reduce-rta" : "carry-negative";
    execute(db, `UPDATE household SET overspend_model = ? WHERE id = 1`, model);
    const actor: Actor = { memberId: RAVI, source: "ui" };
    const ravi = ensurePersonalBudget(db, RAVI, "Ravi").id;
    const priya = ensurePersonalBudget(db, PRIYA, "Priya").id;
    startPersonalBudget(db, actor, ravi);
    startPersonalBudget(db, actor, priya);
    const now = monthOf(todayIST());
    const months = 3 + Math.floor(r() * 8);
    const start = addMonths(now, -(months - 1));
    const open = { openingDate: `${start}-01` };
    const acct = (name: string, kind: "budget" | "credit", budgetId?: string, holder?: string) =>
      createAccount(db, actor, {
        name, kind, subtype: kind === "credit" ? "credit-card" : "savings", ...open,
        openingBalance: kind === "budget" ? amt() * 3 : (r() < 0.3 ? -amt() : 0),
        ...(budgetId ? { budgetId, holderMemberId: holder } : {}),
      }).id;
    const hBank = acct("HBank", "budget"), hCard = acct("HCard", "credit");
    const rBank = acct("RBank", "budget", ravi, RAVI), rCard = acct("RCard", "credit", ravi, RAVI);
    const pBank = acct("PBank", "budget", priya, PRIYA);
    createCard(db, actor, { accountId: hCard, label: "H", holderMemberId: RAVI });
    createCard(db, actor, { accountId: rCard, label: "R", holderMemberId: RAVI });
    if (r() < 0.6) createCard(db, actor, { accountId: rCard, label: "P addon", holderMemberId: PRIYA, isPrimary: false });
    const cats: Record<string, string[]> = {};
    for (const b of [HH, ravi, priya]) {
      const g = createGroup(db, actor, `G-${b}`, "normal", b);
      cats[b] = ["x", "y"].map((n) => createCategory(db, actor, { groupId: g.id, name: `${n}-${b}` }).id);
    }
    const commits: string[] = [];
    if (r() < 0.7) commits.push(ensureCommitmentEnvelope(db, actor, ravi, HH).id);
    if (r() < 0.7) commits.push(ensureCommitmentEnvelope(db, actor, priya, HH).id);
    const budgetOf: Record<string, string> = { [hBank]: HH, [hCard]: HH, [rBank]: ravi, [rCard]: ravi, [pBank]: priya };
    const allAccts = [hBank, hCard, rBank, rCard, pBank];
    const txns: string[] = [];
    const log: string[] = [];
    let refused = 0;
    const ops = 30 + Math.floor(r() * 60);
    for (let i = 0; i < ops; i++) {
      const m = addMonths(start, Math.floor(r() * months));
      const day = 1 + Math.floor(r() * daysInMonth(Number(m.slice(0, 4)), Number(m.slice(5))));
      const date = `${m}-${String(day).padStart(2, "0")}`;
      const op = r();
      try {
        if (op < 0.12) {
          const a = pick([hBank, rBank, pBank]);
          txns.push(createTransaction(db, actor, { accountId: a, amount: amt() * 2, date, payeeName: "Salary" }).id);
          log.push(`income ${a} ${date}`);
        } else if (op < 0.42) {
          const a = pick(allAccts);
          // mostly own budget's envelope, sometimes another budget's
          const b = r() < 0.7 ? budgetOf[a]! : pick([HH, ravi, priya]);
          const c = pick(cats[b]!);
          txns.push(createTransaction(db, actor, { accountId: a, amount: (r() < 0.9 ? -1 : 1) * amt(), date, categoryId: c, payeeName: "Shop" }).id);
          log.push(`spend ${a} -> ${b} ${date}`);
        } else if (op < 0.55) {
          const from = pick(allAccts), to = pick(allAccts);
          const [t] = createTransfer(db, actor, { fromAccountId: from, toAccountId: to, amount: amt(), date });
          txns.push(t.id);
          log.push(`transfer ${from}->${to} ${date}`);
        } else if (op < 0.7) {
          const b = pick([HH, ravi, priya]);
          const pool = [...cats[b]!, ...commits.filter(() => b !== HH)];
          setAssigned(db, actor, addMonths(start, Math.floor(r() * (months + 1))), pick(pool), amt());
          log.push(`assign ${b}`);
        } else if (op < 0.75) {
          const b = pick([HH, ravi, priya]);
          moveMoney(db, actor, { month: m, fromCategoryId: cats[b]![0]!, toCategoryId: cats[b]![1]!, amount: amt() });
          log.push(`move ${b} ${m}`);
        } else if (op < 0.8) {
          setHeld(db, actor, m, amt(), pick([HH, ravi, priya]));
          log.push(`held ${m}`);
        } else if (op < 0.85 && commits.length) {
          callItEven(db, actor, { envelopeId: pick(commits), amount: amt(), month: m });
          log.push(`even ${m}`);
        } else if (op < 0.92 && txns.length) {
          deleteTransaction(db, actor, pick(txns));
          log.push(`delete`);
        } else if (op < 0.95 && txns.length) {
          const t = pick(txns);
          if (r() < 0.5) updateTransaction(db, actor, t, { amount: (r() < 0.8 ? -1 : 1) * amt() } as never);
          else { const b = pick([HH, ravi, priya]); const a = amt(); updateTransaction(db, actor, t, { amount: -a, categoryId: null, splits: [{ categoryId: cats[b]![0]!, amount: -Math.floor(a / 3) }, { categoryId: cats[b]![1]!, amount: -(a - Math.floor(a / 3)) }] } as never); }
          log.push(`edit amount/splits`);
        } else if (op < 0.97) {
          const evs = queryAll<{ id: string; entity: string; action: string }>(db, `SELECT id, entity, action FROM events WHERE undone_by_event_id IS NULL AND action <> 'undo' ORDER BY rowid DESC LIMIT 20`);
          if (evs.length) { const ev = pick(evs); const res = undoEvent(db, ev.id, actor, { force: true }); log.push(`undo ${ev.entity}/${ev.action} ${res.ok ? "ok" : res.reason}`); }
        } else if (txns.length) {
          const b = pick([HH, ravi, priya]);
          updateTransaction(db, actor, pick(txns), { categoryId: r() < 0.3 ? null : pick(cats[b]!), date } as never);
          log.push(`update -> ${b} ${date}`);
        }
      } catch (e) {
        refused++;
        log.push(`refused: ${(e as Error).message.slice(0, 80)}`);
      }
    }
    const problems = identityProblems(db, addMonths(now, 2));
    if (process.env.FUZZ_LOG) console.log(`seed ${seed} refused ${refused}/${ops} undos ${log.filter(l => / ok$/.test(l)).length} edits ${log.filter(l => l.startsWith("edit")).length}`);
    assert.deepEqual(problems.slice(0, 10), [], `model ${model}\n${log.join("\n")}`);
    db.close();
  });
}
