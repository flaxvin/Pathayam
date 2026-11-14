// Property check: a loan account balance equals outstandingPrincipal and the projection after every instalment, prepayment and rate change. FUZZ_SEEDS raises the count.
import { test } from "node:test";
import assert from "node:assert/strict";
import { openDatabase, ensureHousehold, execute } from "../db/db.ts";
import { nowIST, addDays } from "../core/dates.ts";
import type { Actor } from "../core/events.ts";
import { createAccount } from "./accounts.ts";
import { createLoan, recordInstalment, recordPrepayment, recordRateChange, outstandingPrincipal, projectLoan, getLoan } from "./loans.ts";
import { accountBalances } from "../engine/repository.ts";

const actor: Actor = { memberId: "m", source: "ui" };
function rng(seed: number) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
}
const SEEDS = Number(process.env.FUZZ_SEEDS ?? 15);
for (let seed = 1; seed <= SEEDS; seed++) {
  test(`loan fuzz ${seed}`, () => {
    const r = rng(seed * 104729);
    const db = openDatabase({ path: ":memory:", verbose: false });
    ensureHousehold(db);
    execute(db, `INSERT INTO members (id,email,name,created_at) VALUES (?,?,?,?)`, "m", "f@e.com", "Ravi", nowIST());
    const bank = createAccount(db, actor, { name: "Bank", kind: "budget", subtype: "savings", openingDate: "2024-01-01", openingBalance: 1e10 }).id;
    const principal = Math.round(r() * 5e7) + 1e6;
    const flat = r() < 0.2;
    const loan = createLoan(db, actor, {
      lender: "SBI", loanType: r() < 0.5 ? "home" : "personal",
      sanctioned: principal, sanctionDate: "2024-01-05",
      interestModel: flat ? "flat" : "reducing", annualRatePct: 6 + Math.round(r() * 1000) / 100, tenureMonths: 12 + Math.floor(r() * 200),
      firstInstalmentDate: "2024-02-05", repaymentAccountId: bank, currentOutstanding: principal, disbursementDestination: "third-party",
    } as never);
    let date = "2024-02-05";
    const log: string[] = [];
    for (let i = 0; i < 30; i++) {
      const op = r();
      try {
        const p = projectLoan(db, loan.id)!;
        if (op < 0.6) {
          const amt = p.emi > 0 ? p.emi : 100000;
          if (r() < 0.3) {
            const interest = Math.min(amt, Math.round(r() * amt));
            recordInstalment(db, actor, { loanId: loan.id, date, amount: amt, principal: amt - interest, interest, fromAccountId: bank });
            log.push(`inst split ${date} ${amt}`);
          } else {
            recordInstalment(db, actor, { loanId: loan.id, date, amount: amt, fromAccountId: bank });
            log.push(`inst ${date} ${amt}`);
          }
          date = addDays(date, 30);
        } else if (op < 0.8) {
          const amt = Math.max(1, Math.round(p.outstanding * r() * 0.3));
          recordPrepayment(db, actor, { loanId: loan.id, date, amount: amt, mode: r() < 0.5 ? "tenure" : "emi", fromAccountId: bank, charge: r() < 0.3 ? 50000 : 0 });
          log.push(`prepay ${date} ${amt}`);
        } else {
          recordRateChange(db, actor, { loanId: loan.id, effectiveFrom: date, annualRatePct: 6 + Math.round(r() * 800) / 100, keep: r() < 0.5 ? "tenure" : "emi" });
          log.push(`rate ${date}`);
        }
      } catch (e) {
        log.push(`refused ${(e as Error).message.slice(0, 70)}`);
      }
      const l = getLoan(db, loan.id)!;
      const bal = accountBalances(db).get(l.account_id)!.working;
      const out = outstandingPrincipal(db, loan.id);
      const proj = projectLoan(db, loan.id)!;
      assert.ok(-bal === out, `account balance vs outstanding after ${log.at(-1)}\n${log.join("\n")}`);
      assert.equal(proj.outstanding, out, `projection vs outstanding\n${log.join("\n")}`);
      if (out > 0) {
        const s = proj.schedule;
        const sumPrincipal = s.instalments.reduce((t, x) => t + x.principal, 0);
        assert.ok(Math.abs(sumPrincipal - out) <= s.instalments.length, `schedule principal ${sumPrincipal} vs ${out} flat=${flat}\n${log.join("\n")}`);
      }
    }
    db.close();
  });
}
