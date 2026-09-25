import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { parseAlert } from "./email-alerts.ts";

/**
 * The bodies below are the real formats from this household's inbox, with the
 * account and card numbers replaced by test digits. The *structure* is exact —
 * the label/value layout, the sentence wording, the "Dear <name>," greeting —
 * because that is what the parser keys on.
 */

const AXIS_ACCOUNT = `                    28-08-2026
        Dear Ravi Kumar,
        Here's the summary of your transaction:
                Amount Debited:
                INR 600.00
                Account Number:
                XX0000
                Date & Time:
                28-08-26, 00:01:28 IST
                Transaction Info:
                UPI/P2A/400111222444/KAVYA R PILLAI
        Regards, Axis Bank Ltd.`;

const AXIS_CARD_ADDON = `        22-08-2026 Dear Priya Menon,
        Here's the summary of your Axis Bank Credit Card Transaction:
                Transaction Amount:
                INR 198
                Merchant Name:
                M S NOVA EN
                Axis Bank Credit Card No.
                XX1111
                Date & Time:
                22-08-2026, 19:17:01 IST
                Available Limit*:
                INR 57891.96`;

const YES_CARD = `YES BANK Dear Customer, Greetings from YES BANK. INR 70.00 has been spent on your YES BANK Credit Card ending with 2222 at UPI_DESI BITES FAST FO on 27-08-2026 at 06:46:36 pm. Avl Bal INR 284368.87. In case of…`;

const INDUSIND = `IndusInd Bank Dear Customer, Thank you for banking with us. Your IndusInd Bank Account No. 15XXXXXX3333 has been Debited for INR 1.00 towards UPI/400111222333/DR/Moj/YESB0PTMUPI/-72704731@ptyb. The…`;

describe("04 §3.4 · parsing bank transaction alerts", () => {
  test("Axis account debit — label/value layout", () => {
    const r = parseAlert(
      "alerts@axis.bank.in",
      "INR 600.00 was debited from your A/c no. XX0000.",
      AXIS_ACCOUNT,
    )!;
    assert.ok(r);
    assert.equal(r.bank, "axis");
    assert.equal(r.record.amount, -60_000, "a debit is negative");
    assert.equal(r.record.date, "2026-08-28");
    assert.equal(r.record.accountLast4, "0000");
    assert.match(r.record.narration, /KAVYA R PILLAI/);
    assert.equal(r.record.reference, "400111222444");
  });

  test("Axis credit card — merchant, card, and no running balance", () => {
    const r = parseAlert(
      "alerts@axis.bank.in", "INR 198 spent on credit card no. XX1111", AXIS_CARD_ADDON,
    )!;
    assert.equal(r.record.amount, -19_800);
    assert.equal(r.record.cardLast4, "1111");
    assert.equal(r.record.narration, "M S NOVA EN");
    assert.equal(r.record.accountLast4, null);
  });

  test("R6.e · an add-on alert names the cardholder, not the inbox owner", () => {
    // Priya's add-on alert arrives in Ravi's inbox. The greeting is the
    // signal that its owner should default to Priya.
    const r = parseAlert(
      "alerts@axis.bank.in", "INR 198 spent on credit card no. XX1111", AXIS_CARD_ADDON,
    )!;
    assert.equal(r.record.cardholderName, "Priya Menon");
  });

  test("a primary-card alert greets the account holder", () => {
    const r = parseAlert("alerts@axis.bank.in", "…", AXIS_ACCOUNT)!;
    assert.equal(r.record.cardholderName, "Ravi Kumar");
  });

  test("Axis NEFT — the sentence-style alert, not the summary", () => {
    /*
     * NEFT and IMPS debits arrive as one sentence with no Amount Debited
     * label. A transfer this shape is usually the month's largest and was
     * the one alert Axis sends that parsed to nothing.
     */
    const r = parseAlert(
      "alerts@axis.bank.in",
      "Debit transaction alert for Axis Bank A/c",
      "16-09-2026 Dear Kavya R Pillai, Thank you for banking with us. " +
        "We wish to inform you that your A/c no. XX0000 has been debited with " +
        "INR 23000.00 on 16-09-2026 06:17:07 IST by NEFT/MB/AXOMB00000000000/V. " +
        "To check your available balance, please click here .",
    )!;
    assert.ok(r);
    assert.equal(r.bank, "axis");
    assert.equal(r.record.amount, -23_000_00);
    assert.equal(r.record.date, "2026-09-16");
    assert.equal(r.record.accountLast4, "0000");
    assert.match(r.record.narration, /^NEFT\/MB\/AXOMB00000000000\/V$/);
    assert.equal(r.record.cardholderName, "Kavya R Pillai");
  });

  test("Axis sentence credit is positive", () => {
    const r = parseAlert(
      "alerts@axis.bank.in",
      "Credit transaction alert for Axis Bank A/c",
      "Dear Kavya R Pillai, your A/c no. XX0000 has been credited with " +
        "INR 5000.00 on 01-09-2026 10:00:00 IST by IMPS/P2A/000000000001/RENT.",
    )!;
    assert.ok(r);
    assert.equal(r.record.amount, 5_000_00);
  });

  test("YES Bank card — a single sentence, with the balance as a hint", () => {
    const r = parseAlert("alerts@yes.bank.in", "YES BANK - Transaction Alert", YES_CARD)!;
    assert.equal(r.record.amount, -7_000);
    assert.equal(r.record.date, "2026-08-27");
    assert.equal(r.record.cardLast4, "2222");
    assert.match(r.record.narration, /DESI BITES/);
    assert.equal(r.record.balance, 28_436_887);
  });

  test("an alert dated a day that does not exist is not staged on it", () => {
    // parseAlertDate accepted any day up to 31 in any month, so an alert
    // reading "on 31-02-2026" staged a ₹70 row dated "2026-02-31" — a string
    // that sorts like a date and is not one. The shared calendar check refuses
    // it; the message is then left for a person rather than filed wrongly.
    const feb31 = YES_CARD.replace("27-08-2026", "31-02-2026");
    assert.equal(parseAlert("alerts@yes.bank.in", "YES BANK - Transaction Alert", feb31), null);
    const leap = YES_CARD.replace("27-08-2026", "29-02-2028");
    assert.equal(parseAlert("alerts@yes.bank.in", "YES BANK - Transaction Alert", leap)!.record.date, "2028-02-29");
    const notLeap = YES_CARD.replace("27-08-2026", "29-02-2026");
    assert.equal(parseAlert("alerts@yes.bank.in", "YES BANK - Transaction Alert", notLeap), null);
  });

  test("IndusInd account — sentence form, account last four and UPI narration", () => {
    const r = parseAlert(
      "IndusInd_Bank@indusind.com", "IndusInd Bank Transaction Alert", INDUSIND,
      "2026-08-27",
    )!;
    assert.equal(r.record.amount, -100);
    assert.equal(r.record.accountLast4, "3333");
    assert.match(r.record.narration, /UPI\/400111222333/);
    assert.equal(r.record.date, "2026-08-27", "falls back to the received date");
  });

  test("SBI Card — rupees, a two-digit year, and a squashed merchant", () => {
    const r = parseAlert(
      "onlinesbicard@sbicard.com",
      "Transaction Alert from SBI Card",
      "Dear Cardholder, This is to inform you that, Rs.591.00 spent on your " +
        "SBI Credit Card ending 0000 at MSPRETAILPRIVATELIMITE on 05/09/26. " +
        "Trxn. not done by you? Report at https://sbicard.com/Dispute .",
    )!;
    assert.ok(r);
    assert.equal(r.bank, "sbicard");
    assert.equal(r.record.amount, -591_00);
    assert.equal(r.record.date, "2026-09-05");
    assert.equal(r.record.cardLast4, "0000");
    assert.equal(r.record.narration, "MSPRETAILPRIVATELIMITE");
    // "Dear Cardholder" is a salutation, not the name of a person.
    assert.equal(r.record.cardholderName, null);
  });

  test("IndusInd states the balance, and it is kept", () => {
    const r = parseAlert(
      "IndusInd_Bank@indusind.com",
      "IndusInd Bank Transaction Alert",
      "Dear Customer, Your IndusInd Bank Account No. 15XXXXXX0000 has been " +
        "Debited for INR 1.00 towards UPI/000000000001/DR/ZBUL/UTIB/x@pineaxis . " +
        "The balance available in your Account is INR 171.95.",
      "2026-09-04",
    )!;
    assert.ok(r);
    assert.equal(r.record.amount, -1_00);
    assert.equal(r.record.accountLast4, "0000");
    assert.equal(r.record.balance, 171_95);
    // No date anywhere in the message: the message's own date stands in.
    assert.equal(r.record.date, "2026-09-04");
  });

  test("a credit alert is positive", () => {
    const credited = AXIS_ACCOUNT
      .replace("Amount Debited:", "Amount Credited:")
      .replace("INR 600.00", "INR 5,000.00");
    const r = parseAlert("alerts@axis.bank.in", "credited", credited)!;
    assert.equal(r.record.amount, 5_00_000);
  });

  test("an unknown sender is not parsed", () => {
    assert.equal(parseAlert("noreply@example.com", "You spent money", "INR 100 spent"), null);
  });

  test("a matching sender but unrecognised body is null, not a wrong record", () => {
    assert.equal(parseAlert("alerts@axis.bank.in", "Newsletter", "Read our latest offers!"), null);
  });
});
