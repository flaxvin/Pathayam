/**
 * `06` §7.4 · Converting a card purchase to EMI.
 *
 * The bank moves part of a card's revolving balance onto an instalment plan: the
 * card's outstanding drops by the converted amount, and a new debt appears with
 * its own schedule, its own rate, and a processing fee the household is about to
 * pay for the privilege.
 *
 * **The bug this exists to avoid** is named in §7.4: *"the card's payment category
 * expectation MUST fall by the converted amount so the household is not asked to
 * fund it twice."* Charging ₹60,000 to a card already moved ₹60,000 into the
 * card's payment envelope (R6). If the conversion left the card's outstanding
 * alone, the household would be asked to clear ₹60,000 on the card *and* pay
 * twelve instalments against the same purchase.
 *
 * So a conversion is modelled as exactly what it is: **a loan whose money went to
 * the card.** The card is credited, its outstanding falls, and its payment
 * envelope stops asking for money it no longer needs — which is the existing
 * disbursement mechanic (R15.2) pointed at a credit account instead of a bank
 * account, not a new one.
 *
 * The fee is a real cost and is charged to the card like any other purchase, so it
 * needs an envelope and shows up in the total cost of borrowing (R22).
 */

import type { DB } from "../db/db.ts";
import { queryOne, execute, transact } from "../db/db.ts";
import type { Actor } from "../core/events.ts";
import { appendEvent } from "../core/events.ts";
import { todayIST, monthOf, type IsoDate } from "../core/dates.ts";
import { formatPaise, type Paise } from "../core/money.ts";
import { Refusal } from "../core/refusal.ts";
import { getAccount, paymentCategoryFor } from "./accounts.ts";
import { moveMoney } from "./budget.ts";
import { loadEngineInput } from "../engine/repository.ts";
import { computeBudget } from "../engine/engine.ts";
import { createTransaction, getTransaction } from "./transactions.ts";
import { createLoan, projectLoan, paymentCategoryForLoan, type Loan } from "./loans.ts";

/** The GST an Indian issuer adds to a processing fee. */
export const GST_PCT = 18;

export interface ConvertToEmiInput {
  /** The card charge being converted. Its account and amount are read from it. */
  transactionId?: string;
  /** Or name the card and the amount directly, for a part conversion. */
  accountId?: string;
  amount?: Paise;
  tenureMonths: number;
  annualRatePct: number;
  /** Before GST. ₹199 is typical; some issuers charge nothing. */
  processingFee?: Paise;
  /** Where the fee is budgeted. Required when there is a fee to pay. */
  feeCategoryId?: string | null;
  date?: IsoDate;
  /** R6.c · Which card the purchase was made on — the primary, or an add-on. */
  cardId?: string | null;
  /**
   * What to call it, beyond "<card> EMI".
   *
   * A household converting three purchases on the same card otherwise ends up
   * with three plans called "Swiggy HDFC EMI", indistinguishable in the loan list,
   * the debt table and the envelope grid. The payee of the original charge is
   * usually exactly the right word — "Croma", "Apple" — so it is the default.
   */
  nameSuffix?: string | null;
  note?: string | null;
}

export interface ConversionResult {
  loan: Loan;
  /** What the plan costs beyond the amount borrowed (R22). */
  interest: Paise;
  feeWithGst: Paise;
  totalCostOfBorrowing: Paise;
  emi: Paise;
}

export function convertToEmi(db: DB, actor: Actor, input: ConvertToEmiInput): ConversionResult {
  return transact(db, () => {
    const source = input.transactionId ? getTransaction(db, input.transactionId) : null;
    if (input.transactionId && !source) {
      throw new Refusal("That transaction does not exist.");
    }

    const accountId = source?.account_id ?? input.accountId;
    if (!accountId) throw new Refusal("Say which card is being converted.");

    const card = getAccount(db, accountId);
    if (!card) throw new Refusal("That account does not exist.");
    if (card.kind !== "credit") {
      throw new Refusal(
        "Only a card balance converts to EMI. A bank account's money is already yours.",
      );
    }

    /*
     * A charge is stored negative, so the amount being converted is its
     * magnitude. Converting more than was charged is the sort of typo that would
     * hand the household free money on the card, so it is refused.
     */
    const amount = (input.amount ?? (source ? Math.abs(source.amount) : 0)) as Paise;
    if (amount <= 0) throw new Refusal("Say how much is being converted.");
    if (source && amount > Math.abs(source.amount)) {
      throw new Refusal(
        `That charge was ${formatPaise(Math.abs(source.amount) as Paise)}, so ` +
        `${formatPaise(amount)} cannot be converted from it.`,
      );
    }
    if (input.tenureMonths <= 0) throw new Refusal("An EMI plan needs a tenure of at least a month.");

    const fee = (input.processingFee ?? 0) as Paise;
    if (fee > 0 && !input.feeCategoryId) {
      throw new Refusal(
        "The processing fee is money you are about to spend, so it needs an " +
        "envelope — the same as any other charge on the card.",
      );
    }

    /*
     * B123 · The plan is dated from the charge it replaces, not from the moment
     * somebody pressed the button.
     *
     * An issuer converts a purchase where it sits: the instalments replace that
     * charge, on that statement. Defaulting to today instead put the whole plan
     * in the current month however old the charge was — and took the envelope
     * move with it, so converting a charge from last year moved the money the
     * household had set aside for *this* month's card bill, and left this
     * month's payment envelope ₹84,000 in the red. The date the app knows to be
     * related to this conversion is the charge's own.
     */
    const date = input.date ?? source?.date ?? todayIST();
    const suffix = (input.nameSuffix ?? "").trim();
    const label = suffix
      ? `${card.nickname || card.name} EMI — ${suffix}`
      : `${card.nickname || card.name} EMI`;

    // The plan itself. Sanctioned and drawn are the same figure: the bank has
    // already advanced it, which is why the card's balance falls.
    const loan = createLoan(db, actor, {
      lender: card.institution || card.name,
      nickname: label,
      loanType: "credit-card-emi",
      sanctioned: amount,
      sanctionDate: date,
      interestModel: "reducing",
      annualRatePct: input.annualRatePct,
      tenureMonths: input.tenureMonths,
      currentOutstanding: amount,
      holderMemberId: card.holder_member_id,
      visibility: card.visibility,
      /*
       * R15.2, pointed at the card. This is the step that keeps §7.4's promise:
       * the credit lands on the card, its outstanding falls by the converted
       * amount, and its payment envelope stops asking to clear money that is now
       * an instalment plan.
       */
      disbursementDestination: "budget-account",
      disbursementAccountId: card.id,
    });

    execute(
      db,
      `UPDATE loans SET card_id = ?, converted_from_transaction_id = ? WHERE id = ?`,
      input.cardId ?? source?.card_id ?? null, source?.id ?? null, loan.id,
    );

    /*
     * The fee, with GST, charged to the card. It is a cost of borrowing and a real
     * purchase at the same time: the bank puts it on the statement, so the
     * household budgets for it like anything else it bought.
     */
    const feeWithGst = Math.round(fee * (1 + GST_PCT / 100)) as Paise;
    if (feeWithGst > 0) {
      createTransaction(db, actor, {
        accountId: card.id,
        amount: -feeWithGst as Paise,
        date,
        categoryId: input.feeCategoryId ?? null,
        payeeName: card.institution || card.name,
        memo: `EMI processing fee (${formatPaise(fee)} + ${GST_PCT}% GST)`,
        cleared: true,
      });
    }

    /*
     * §7.4 · And the money that was set aside to clear the card follows the debt.
     *
     * Charging ₹60,000 to a card put ₹60,000 into the card's payment envelope
     * (R6). The conversion pays the card off, so that money is no longer needed
     * there — it is needed for the instalments, which is what the plan's envelope
     * is. Leaving it behind would show the card wildly over-funded and the plan
     * unfunded, and make the household move it by hand to say something the app
     * already knows.
     *
     * A move between two envelopes, so nothing is created or destroyed.
     */
    const cardEnvelope = paymentCategoryFor(db, card.id);
    const planEnvelope = paymentCategoryForLoan(db, loan.id);
    if (cardEnvelope && planEnvelope) {
      const held = computeBudget(loadEngineInput(db, { through: monthOf(date) }))
        .get(monthOf(date))?.categories.get(cardEnvelope.id)?.balance ?? 0;
      const toMove = Math.min(Math.max(0, held), amount) as Paise;
      if (toMove > 0) {
        moveMoney(db, actor, {
          month: monthOf(date),
          fromCategoryId: cardEnvelope.id,
          toCategoryId: planEnvelope.id,
          amount: toMove,
        });
      }
    }

    const projection = projectLoan(db, loan.id);
    const interest = (projection?.schedule.totalInterest ?? 0) as Paise;

    appendEvent(db, actor, {
      entity: "loan", entityId: loan.id, action: "convert-to-emi",
      after: { amount, tenureMonths: input.tenureMonths, fee: feeWithGst },
      summary:
        `Converted ${formatPaise(amount)} on ${card.nickname || card.name} to ` +
        `${input.tenureMonths} instalments — ${formatPaise(interest)} interest` +
        (feeWithGst > 0 ? ` and ${formatPaise(feeWithGst)} in fees` : ""),
    });

    return {
      loan: queryOne<Loan>(db, `SELECT * FROM loans WHERE id = ?`, loan.id)!,
      interest,
      feeWithGst,
      totalCostOfBorrowing: (interest + feeWithGst) as Paise,
      emi: (projection?.emi ?? 0) as Paise,
    };
  });
}
