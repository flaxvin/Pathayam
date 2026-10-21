/**
 * Randomized budget fuzzer. Usage:
 *   node --experimental-strip-types .scratch/budget-fuzzer.ts <seedFrom> <seedTo> <steps>
 * After every step: identity in every scope and month, live vs rollup RTA and
 * per-category balance. Non-Refusal exceptions are reported as crashes.
 */
import { openDatabase, ensureHousehold, execute, queryAll, queryOne, type DB } from "../src/db/db.ts";
import type { Actor } from "../src/core/events.ts";
import { undoEvent } from "../src/core/events.ts";
import { nowIST, todayIST, monthOf, addMonths, addDays, lastDayOfMonth, type MonthKey, type IsoDate } from "../src/core/dates.ts";
import { Refusal } from "../src/core/refusal.ts";
import type { Paise } from "../src/core/money.ts";
import { createAccount } from "../src/domain/accounts.ts";
import * as B from "../src/domain/budget.ts";
import { createTransaction, createTransfer, deleteTransaction, updateTransaction } from "../src/domain/transactions.ts";
import { householdBudgetId, ensurePersonalBudget } from "../src/domain/budgets.ts";
import { ensureCommitmentEnvelope } from "../src/domain/commitments.ts";
import { callItEven } from "../src/domain/squaring-up.ts";
import { describeDeparture, settleDeparture } from "../src/domain/departure.ts";
import { removeMember, inviteMember } from "../src/auth/sessions.ts";
import * as S from "../src/domain/schedules.ts";
import * as G from "../src/domain/goals.ts";
import { closeMonth, reopenMonth } from "../src/domain/month-close.ts";
import { setOverspendModel } from "../src/engine/recompute.ts";
import { loadEngineInput } from "../src/engine/repository.ts";
import { computeBudget, identityResidual } from "../src/engine/engine.ts";
import { buildBudgetView } from "../src/web/viewmodel.ts";
import { digestFor } from "../src/domain/digest.ts";
import { queryTransactions } from "../src/domain/reports.ts";

export const refusals = new Map<string, number>();
const RAVI = "m-ravi", PRIYA = "m-priya";

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TODAY = todayIST();
const CUR = monthOf(TODAY);

function problems(db: DB, through: MonthKey): string[] {
  const scopes: (string | undefined)[] = [undefined, ...queryAll<{ id: string }>(db, `SELECT id FROM budgets`).map((r) => r.id)];
  const out: string[] = [];
  for (const scope of scopes) {
    const live = computeBudget(loadEngineInput(db, { through, budgetId: scope, useRollup: false }));
    const rolled = computeBudget(loadEngineInput(db, { through, budgetId: scope, useRollup: true }));
    for (const [month, st] of live) {
      const r = identityResidual(st);
      if (r !== 0) out.push(`${scope ?? "all"} ${month} live residual ${r}`);
      const b = st.rtaBreakdown;
      const sum = b.incomeToDate - b.assignedThisMonthAndEarlier - b.assignedInFutureMonths - b.heldForNextMonth - b.cashOverspendCarried;
      if (sum !== b.total || b.total !== st.readyToAssign) out.push(`${scope ?? "all"} ${month} explain lines sum ${sum} total ${b.total} rta ${st.readyToAssign}`);
      const o = rolled.get(month);
      if (!o) { out.push(`${scope} ${month} missing rollup`); continue; }
      if (identityResidual(o) !== 0) out.push(`${scope ?? "all"} ${month} rollup residual ${identityResidual(o)}`);
      if (o.readyToAssign !== st.readyToAssign) out.push(`${scope ?? "all"} ${month} RTA live ${st.readyToAssign} rollup ${o.readyToAssign}`);
      for (const [cid, cs] of st.categories) {
        const oc = o.categories.get(cid);
        if (!oc || oc.balance !== cs.balance) out.push(`${scope ?? "all"} ${month} cat ${cid} live ${cs.balance} rollup ${oc?.balance}`);
      }
    }
  }
  return out;
}

export function run(seed: number, steps: number, verbose = false): { crashes: string[]; broken: string[]; ops: Record<string, number> } {
  const r = rng(seed);
  const pick = <T,>(xs: T[]): T => xs[Math.floor(r() * xs.length)]!;
  const int = (lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));
  const db = openDatabase({ path: ":memory:", verbose: false });
  ensureHousehold(db);
  for (const [id, name] of [[RAVI, "Ravi"], [PRIYA, "Priya"]] as const) {
    execute(db, `INSERT INTO members (id,email,name,created_at) VALUES (?,?,?,?)`, id, `${name.toLowerCase()}@example.com`, name, nowIST());
  }
  const actors: Actor[] = [{ memberId: RAVI, source: "ui" }, { memberId: PRIYA, source: "ui" }];
  const A = () => pick(actors);
  const HH = householdBudgetId(db);
  const rb = ensurePersonalBudget(db, RAVI, "Ravi").id;
  const pb = ensurePersonalBudget(db, PRIYA, "Priya").id;
  B.startPersonalBudget(db, actors[0]!, rb);
  B.startPersonalBudget(db, actors[1]!, pb);
  const budgets = [HH, rb, pb];
  // months: from CUR-14 to CUR+3
  const months: MonthKey[] = [];
  for (let d = -14; d <= 3; d++) months.push(addMonths(CUR, d));
  const randDate = (): IsoDate => {
    const m = pick(months.filter((x) => x <= CUR));
    const day = pick([1, 2, 15, 28, 29, 30, 31]);
    const last = Number(lastDayOfMonth(m).slice(8));
    const d = `${m}-${String(Math.min(day, last)).padStart(2, "0")}` as IsoDate;
    return d > TODAY ? TODAY : d;
  };
  const acct = (name: string, kind: "budget" | "credit" | "tracking", subtype: string, budgetId: string, open: number, holder?: string) =>
    createAccount(db, actors[0]!, { name, kind, subtype, budgetId, openingBalance: open as Paise, openingDate: addDays(`${months[0]}-01` as IsoDate, 0), holderMemberId: holder ?? null, visibility: holder && budgetId !== HH ? "private" : "household" }).id;
  const accounts0 = [
    acct("HH bank", "budget", "savings", HH, 50_000_00),
    acct("HH card", "credit", "credit-card", HH, -2_000_00),
    acct("Ravi bank", "budget", "savings", rb, 30_000_00, RAVI),
    acct("Priya bank", "budget", "savings", pb, 20_000_00, PRIYA),
    acct("Priya card", "credit", "credit-card", pb, 0, PRIYA),
  ];
  const accountsAll = () => queryAll<{ id: string }>(db, `SELECT id FROM accounts WHERE closed_at IS NULL AND subtype <> 'family-loan'`).map((x) => x.id);
  void accounts0;
  const g = B.createGroup(db, actors[0]!, "Living", "normal", HH);
  for (const n of ["Groceries", "Rent", "Fuel", "Fun"]) B.createCategory(db, actors[0]!, { groupId: g.id, name: n });
  ensureCommitmentEnvelope(db, actors[0]!, rb);
  ensureCommitmentEnvelope(db, actors[1]!, pb);

  const cats = (budgetId?: string, includePayment = false) => queryAll<{ id: string; budget_id: string; pay: string | null; commits: string | null }>(db,
    `SELECT c.id, g.budget_id, c.payment_account_id AS pay, c.commits_to_budget_id AS commits FROM categories c JOIN category_groups g ON g.id=c.group_id
      WHERE c.deleted_at IS NULL ${budgetId ? "AND g.budget_id = ?" : ""}`, ...(budgetId ? [budgetId] : []))
    .filter((c) => includePayment || !c.pay);
  const budgetOfAcct = (id: string) => queryOne<{ budget_id: string | null; kind: string }>(db, `SELECT budget_id, kind FROM accounts WHERE id=?`, id)!;
  const ops: Record<string, number> = {};
  const crashes: string[] = [];
  const broken: string[] = [];
  const through = months.at(-1)!;
  const amt = () => pick([1, 100, 999, 50_00, 1234_56, 10_000_00, 99_999_99]) as Paise;

  const OPS: Record<string, () => void> = {
    assign: () => { const c = pick(cats()); B.setAssigned(db, A(), pick(months), c.id, (int(-1, 3) * amt()) as Paise); },
    add: () => { const c = pick(cats()); B.addAssigned(db, A(), pick(months), c.id, (int(-1, 1) * amt()) as Paise); },
    move: () => { const bud = pick(budgets); const cs = cats(bud); B.moveMoney(db, A(), { month: pick(months), fromCategoryId: pick(cs).id, toCategoryId: pick(cs).id, amount: amt() }); },
    hold: () => B.setHeld(db, A(), pick(months), (int(0, 1) * amt()) as Paise, pick(budgets)),
    copy: () => { const m = pick(months); B.copyAssignmentsFromMonth(db, A(), m, addMonths(m, -1), pick(budgets)); },
    spend: () => {
      const a = pick(accountsAll());
      const b = budgetOfAcct(a).budget_id;
      const cs = cats(b ?? undefined);
      const sign = r() < 0.8 ? -1 : 1;
      if (r() < 0.25 && cs.length > 1) {
        const x = amt(), y = amt();
        createTransaction(db, A(), { accountId: a, amount: (sign * (x + y)) as Paise, date: randDate(), splits: [{ categoryId: pick(cs).id, amount: (sign * x) as Paise }, { categoryId: r() < 0.2 ? null : pick(cs).id, amount: (sign * y) as Paise }] });
      } else {
        createTransaction(db, A(), { accountId: a, amount: (sign * amt()) as Paise, date: randDate(), categoryId: r() < 0.15 ? null : pick(cs).id });
      }
    },
    income: () => { const a = pick(accountsAll().filter((x) => budgetOfAcct(x).kind === "budget")); createTransaction(db, A(), { accountId: a, amount: amt(), date: randDate(), categoryId: null }); },
    crossSpend: () => {
      // a personal account paying for a household envelope
      const a = pick(accountsAll());
      createTransaction(db, A(), { accountId: a, amount: -amt() as Paise, date: randDate(), categoryId: pick(cats()).id });
    },
    transfer: () => { const f = pick(accountsAll()), t = pick(accountsAll()); if (f === t) return; createTransfer(db, A(), { fromAccountId: f, toAccountId: t, amount: amt(), date: randDate() }); },
    editTx: () => {
      const t = queryOne<{ id: string }>(db, `SELECT id FROM transactions WHERE deleted_at IS NULL AND transfer_pair_id IS NULL  ORDER BY random() LIMIT 1`);
      if (!t) return;
      updateTransaction(db, A(), t.id, r() < 0.5 ? { date: randDate() } : { categoryId: pick(cats()).id } as never);
    },
    delTx: () => { const t = queryOne<{ id: string }>(db, `SELECT id FROM transactions WHERE deleted_at IS NULL ORDER BY random() LIMIT 1`); if (t) deleteTransaction(db, A(), t.id); },
    newCat: () => { const gr = pick(queryAll<{ id: string }>(db, `SELECT id FROM category_groups WHERE kind='normal'`)); B.createCategory(db, A(), { groupId: gr.id, name: `c${int(0, 1e6)}` }); },
    newGroup: () => { B.createGroup(db, A(), `g${int(0, 1e6)}`, "normal", pick(budgets)); },
    renameCat: () => { B.renameCategory(db, A(), pick(cats()).id, `r${int(0, 1e6)}`); },
    hide: () => { B.setCategoryHidden(db, A(), pick(cats()).id, r() < 0.5); },
    moveCat: () => { const c = pick(cats()); const gr = pick(queryAll<{ id: string }>(db, `SELECT id FROM category_groups WHERE kind='normal' AND budget_id = ?`, c.budget_id)); B.moveCategoryToGroup(db, A(), c.id, gr.id); },
    delCat: () => {
      const c = pick(cats());
      const st = computeBudget(loadEngineInput(db, { through: CUR, budgetId: c.budget_id })).get(CUR)?.categories.get(c.id);
      const others = cats(c.budget_id).filter((x) => x.id !== c.id);
      B.deleteCategory(db, A(), c.id, { remapTo: r() < 0.6 && others.length ? pick(others).id : null, currentBalance: (st?.balance ?? 0) as Paise });
    },
    delGroup: () => { const gr = queryOne<{ id: string }>(db, `SELECT id FROM category_groups WHERE kind='normal' ORDER BY random() LIMIT 1`); if (gr) B.deleteGroup(db, A(), gr.id); },
    merge: () => { const c = pick(cats()); const w = pick(r() < 0.8 ? cats(c.budget_id) : cats()); B.mergeCategories(db, A(), c.id, w.id); },
    target: () => {
      const c = pick(cats());
      const type = pick(["monthly", "refill", "by-date"] as const);
      B.setTarget(db, A(), c.id, { type, amount: amt(), targetDate: type === "by-date" ? `${pick(months)}-${pick(["01", "15", "28"])}` as IsoDate : null });
    },
    clearTarget: () => B.clearTarget(db, A(), pick(cats()).id),
    autoAssign: () => {
      const bud = pick(budgets); const month = pick(months.filter((m) => m >= CUR));
      const view = buildBudgetView(db, month, bud, null);
      let remaining = view.monthState.readyToAssign; let total = 0;
      const actor = A();
      for (const c of view.categories.values()) {
        if (remaining <= 0) break;
        if (c.hidden || c.isPaymentCategory) continue;
        const u = c.progress?.underfunded ?? 0; if (u <= 0) continue;
        const gr = Math.min(u, remaining); remaining -= gr; total += gr;
        B.setAssigned(db, actor, month, c.id, (c.state.assigned + gr) as Paise);
      }
      const av = buildBudgetView(db, month, bud, null);
      const after = av.monthState.readyToAssign;
      if (after < 0 && view.monthState.readyToAssign >= 0) broken.push(`seed ${seed}: autoAssign drove ${bud} ${month} RTA negative ${after}`);
      for (const m of months.filter((x) => x > month)) {
        const before = computeBudget(loadEngineInput(db, { through: m, budgetId: bud })).get(m)?.readyToAssign ?? 0;
        void before;
      }
      if (after !== view.monthState.readyToAssign - total) broken.push(`seed ${seed}: autoAssign ${bud} ${month} rta ${view.monthState.readyToAssign} - ${total} != ${after}`);
    },
    schedule: () => {
      const a = pick(accountsAll()); const b = budgetOfAcct(a).budget_id;
      const s = S.createSchedule(db, A(), { name: `s${int(0, 1e6)}`, accountId: a, categoryId: r() < 0.2 ? null : pick(cats(b ?? undefined)).id, amount: (-amt()) as Paise,
        recurrence: pick(S.RECURRENCES as unknown as S.Recurrence[]), nextDue: `${pick(months)}-${pick(["29", "30", "31", "28", "01"])}` as IsoDate });
      void s;
    },
    scheduleSplit: () => {
      const s = queryOne<{ id: string; account_id: string; amount: number }>(db, `SELECT id, account_id, amount FROM schedules ORDER BY random() LIMIT 1`); if (!s) return;
      const b = budgetOfAcct(s.account_id).budget_id; const cs = cats(b ?? undefined);
      const half = Math.trunc(s.amount / 2);
      S.setScheduleSplits(db, A(), s.id, [{ categoryId: pick(cs).id, amount: half as Paise }, { categoryId: pick(cs).id, amount: (s.amount - half) as Paise }]);
    },
    markPaid: () => {
      const s = queryOne<{ id: string; amount: number | null; account_id: string | null }>(db, `SELECT id, amount, account_id FROM schedules ORDER BY random() LIMIT 1`); if (!s) return;
      const n0 = queryOne<{ n: number }>(db, `SELECT COUNT(*) n FROM transactions WHERE deleted_at IS NULL`)!.n;
      S.markPaid(db, A(), s.id, randDate());
      const t = queryOne<{ id: string; amount: number; is_split: number }>(db, `SELECT id, amount, is_split FROM transactions WHERE deleted_at IS NULL ORDER BY rowid DESC LIMIT 1`)!;
      const n1 = queryOne<{ n: number }>(db, `SELECT COUNT(*) n FROM transactions WHERE deleted_at IS NULL`)!.n;
      if (s.amount !== null && s.account_id) {
        if (n1 !== n0 + 1 || t.amount !== s.amount) broken.push(`seed ${seed}: markPaid posted ${n1 - n0} tx amount ${t.amount} vs ${s.amount}`);
        if (t.is_split) {
          const sum = queryOne<{ s: number }>(db, `SELECT SUM(amount) s FROM transaction_splits WHERE transaction_id = ?`, t.id)!.s;
          if (sum !== t.amount) broken.push(`seed ${seed}: markPaid split sum ${sum} vs ${t.amount}`);
        }
      }
    },
    skip: () => { const s = queryOne<{ id: string }>(db, `SELECT id FROM schedules ORDER BY random() LIMIT 1`); if (s) S.skipOccurrence(db, A(), s.id); },
    delSchedule: () => { const s = queryOne<{ id: string }>(db, `SELECT id FROM schedules ORDER BY random() LIMIT 1`); if (s) S.deleteSchedule(db, A(), s.id); },
    detect: () => { S.detectSchedules(db, TODAY); S.projectCashflow(db, { budgetId: pick(budgets) }); },
    goal: () => {
      const bud = pick(budgets);
      G.createGoal(db, A(), { name: `goal${int(0, 1e6)}`, targetAmount: amt(), targetDate: r() < 0.5 ? addDays(TODAY, int(-400, 400)) : null, budgetId: bud });
    },
    completeGoal: () => {
      const gl = queryOne<{ id: string }>(db, `SELECT id FROM goals WHERE completed_at IS NULL ORDER BY random() LIMIT 1`); if (!gl) return;
      const res = pick(["spend", "roll", "release"] as const);
      G.completeGoal(db, A(), gl.id, res, res === "roll" ? { name: `next${int(0, 1e6)}`, targetAmount: amt() } : undefined);
    },
    delGoal: () => { const gl = queryOne<{ id: string }>(db, `SELECT id FROM goals ORDER BY random() LIMIT 1`); if (gl) G.deleteGoal(db, A(), gl.id); },
    callEven: () => {
      const env = queryOne<{ id: string }>(db, `SELECT id FROM categories WHERE commits_to_budget_id IS NOT NULL AND deleted_at IS NULL ORDER BY random() LIMIT 1`); if (!env) return;
      const month = pick(months.filter((m) => m <= CUR));
      const bal = Math.abs(computeBudget(loadEngineInput(db, { through: month })).get(month)?.categories.get(env.id)?.balance ?? 0);
      callItEven(db, A(), { envelopeId: env.id, amount: (r() < 0.5 ? bal : Math.max(1, Math.floor(bal * r()))) as Paise, month });
    },
    depart: () => {
      const who = pick([RAVI, PRIYA]);
      const d = describeDeparture(db, who);
      if (d.options.length) {
        const how = pick(d.options);
        const loansBefore = queryAll<{ id: string }>(db, `SELECT id FROM accounts WHERE subtype='family-loan'`).length;
        settleDeparture(db, A(), who, how);
        ops["depart:" + how] = (ops["depart:" + how] ?? 0) + 1; ops["ok:depart:" + how] = ops["depart:" + how]!;
        const after = describeDeparture(db, who);
        if (after.standing !== "even") broken.push(`seed ${seed}: departure ${how} left ${after.balance} (was ${d.balance})`);
        // every month from now on: the envelope is empty
        for (const m of months.filter((x) => x >= CUR)) {
          const bal = computeBudget(loadEngineInput(db, { through: m, budgetId: d.budgetId! })).get(m)?.categories.get(d.envelopeId!)?.balance ?? 0;
          if (bal !== 0) broken.push(`seed ${seed}: departure ${how} envelope ${m} still ${bal}`);
        }
        if (how === "family-loan") {
          const loans = queryAll<{ id: string; opening_balance: number }>(db, `SELECT id, opening_balance FROM accounts WHERE subtype='family-loan'`);
          if (loans.length !== loansBefore + 1) broken.push(`seed ${seed}: family-loan departure made ${loans.length - loansBefore} loans`);
        }
      }
      if (r() < 0.5) {
        const actor = actors.find((x) => x.memberId !== who)!;
        removeMember(db, actor, who);
        if (r() < 0.7) inviteMember(db, actor, { email: `${who === RAVI ? "ravi" : "priya"}@example.com` });
      }
    },
    close: () => { closeMonth(db, A(), pick(months.filter((m) => m < CUR)), null, pick(budgets)); },
    reopen: () => { reopenMonth(db, A(), pick(months.filter((m) => m < CUR)), pick(budgets)); },
    model: () => { setOverspendModel(db, A(), pick(["reduce-rta", "carry-negative"] as const)); },
    undo: () => {
      const ev = queryOne<{ id: string }>(db, `SELECT id FROM events WHERE action <> 'undo' AND undone_by_event_id IS NULL ORDER BY random() LIMIT 1`);
      if (!ev) return;
      const force = r() < 0.5;
      try { undoEvent(db, ev.id, A(), { force }); } catch (e) {
        if (process.env.V === "1" && !(e instanceof Refusal) && !/Refus/.test((e as Error).constructor.name)) console.error("UNDO", (e as Error).message, force, JSON.stringify(queryOne(db, `SELECT * FROM events WHERE id = ?`, ev.id)), queryAll(db, `SELECT entity, action, summary FROM events WHERE rowid > (SELECT rowid FROM events WHERE id = ?)`, ev.id));
        throw e;
      }
    },
    digest: () => { for (const m of [null, RAVI, PRIYA]) digestFor(db, m as never); },
    query: () => {
      const rows = queryTransactions(db, {});
      const total = rows.reduce((a, x) => a + (x as unknown as { amount: number }).amount, 0);
      void total;
    },
  };
  const weights: [string, number][] = [
    ["assign", 8], ["add", 4], ["move", 5], ["hold", 2], ["copy", 2], ["spend", 12], ["income", 5], ["crossSpend", 3], ["transfer", 4],
    ["editTx", 3], ["delTx", 2], ["newCat", 2], ["newGroup", 1], ["renameCat", 1], ["hide", 2], ["moveCat", 2], ["delCat", 2], ["delGroup", 1],
    ["merge", 2], ["target", 4], ["clearTarget", 1], ["autoAssign", 3], ["schedule", 3], ["scheduleSplit", 2], ["markPaid", 3], ["skip", 1],
    ["delSchedule", 1], ["detect", 1], ["goal", 2], ["completeGoal", 2], ["delGoal", 1], ["callEven", 2], ["depart", 1], ["close", 2],
    ["reopen", 1], ["model", 1], ["undo", 6], ["digest", 1], ["query", 1],
  ];
  const totalW = weights.reduce((s, [, w]) => s + w, 0);
  for (let i = 0; i < steps; i++) {
    let x = r() * totalW; let name = weights[0]![0];
    for (const [n, w] of weights) { if ((x -= w) < 0) { name = n; break; } }
    ops[name] = (ops[name] ?? 0) + 1;
    try {
      OPS[name]!();
      ops["ok:" + name] = (ops["ok:" + name] ?? 0) + 1;
    } catch (e) {
      if (process.env.R === "1" && e instanceof Refusal) { const k = name + ": " + e.message.slice(0, 90); refusals.set(k, (refusals.get(k) ?? 0) + 1); }
      if (!(e instanceof Refusal) && !(e as Error)?.constructor?.name?.match(/Refus|Missing|Conflict|HttpError|UndoRefused/)) {
        crashes.push(`seed ${seed} step ${i} ${name}: ${(e as Error).constructor.name} ${(e as Error).message?.slice(0, 200)}`);
        if (verbose) console.error(e);
      }
    }
    const p = problems(db, through);
    if (p.length) { broken.push(`seed ${seed} step ${i} after ${name}: ${p.slice(0, 3).join("; ")}`); break; }
  }
  db.close();
  return { crashes, broken, ops };
}

if (import.meta.main) {
  const [from = "1", to = "5", steps = "150"] = process.argv.slice(2);
  const all: Record<string, number> = {};
  const crashKinds = new Map<string, number>();
  for (let s = Number(from); s <= Number(to); s++) {
    const res = run(s, Number(steps), process.env.V === "1");
    for (const [k, v] of Object.entries(res.ops)) all[k] = (all[k] ?? 0) + v;
    for (const c of res.crashes) { const key = c.replace(/^seed \d+ step \d+ /, ""); if (!crashKinds.has(key)) console.log(c); crashKinds.set(key, (crashKinds.get(key) ?? 0) + 1); }
    for (const b of res.broken) console.log("BROKEN", b);
  }
  const keys = Object.keys(all).filter((k) => !k.startsWith("ok:")).sort();
  console.log(keys.map((k) => `${k} ${all["ok:" + k] ?? 0}/${all[k]}`).join("  "));
  if (process.env.R === "1") for (const [k, v] of [...refusals].sort((a, b) => b[1] - a[1]).slice(0, 40)) console.log(v, k);
}
