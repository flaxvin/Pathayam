import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { parseAlert, looksLikeUnreadAlert } from "./email-alerts.ts";

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

const INDUSIND = `IndusInd Bank Dear Customer, Thank you for banking with us. Your IndusInd Bank Account No. 15XXXXXX3333 has been Debited for INR 1.00 towards UPI/400111222333/DR/Moj/YESB0PTMUPI/-12345678@ptyb. The…`;

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

describe("IMPORTS-SCHEDULES-34 · a named month with a two-digit year", () => {
  test("a YES Bank card alert dated 27-Aug-26 is read, not dropped", () => {
    const r = parseAlert("alerts@yes.bank.in", "Txn alert",
      "INR 70.00 has been spent on your YES BANK Credit Card ending with 8803 at UPI_ZZ CAFE " +
      "on 27-Aug-26 at 06:46:36 pm. Avl Bal INR 1,000.00");
    assert.equal(r?.record.date, "2026-08-27");
    assert.equal(r?.record.amount, -7000);
    assert.equal(r?.record.cardLast4, "8803");
  });
});

/*
 * IMPORT-SND-3..11 · Alert wordings from a real mailbox, 2024-26, with the
 * card and account digits, amounts and merchants replaced by test values.
 */
describe("IMPORT-SND · alert senders and wordings that were not read", () => {
  test("IMPORT-SND-3: Axis's pre-2025 sender alerts@axisbank.com is read", () => {
    const r = parseAlert("alerts@axisbank.com", "INR 600.00 was debited", AXIS_ACCOUNT);
    assert.equal(r?.bank, "axis");
    assert.equal(r?.record.accountLast4, "0000");
  });

  test("IMPORT-SND-3: a non-breaking space that decoded to U+FFFD does not hide the amount", () => {
    const r = parseAlert("alerts@axis.bank.in", "Card spend",
      AXIS_CARD_ADDON.replace("INR 198", "INR�198"));
    assert.equal(r?.record.amount, -19800);
  });

  test("IMPORT-SND-4: all three HDFC card wordings", () => {
    const cases: [string, string, number][] = [
      ["Dear Card Member, Thank you for using your HDFC Bank Credit Card ending 1111 for Rs 459.00 at ZZ FOODS on 01-12-2024 12:48:20. Authorization code:- 000000",
        "2024-12-01", -45900],
      ["Dear Customer, Greetings from HDFC Bank! Rs.232.00 is debited from your HDFC Bank Credit Card ending 1111 towards PayU*ZZ Foods Limited on 31 Aug, 2025 at 18:57:59. If you did not",
        "2025-08-31", -23200],
      ["Dear Customer, Greetings from HDFC Bank. We would like to inform you that Rs. 203.00 has been debited from your HDFC Bank Credit Card ending 1111 towards RAZ*ZZ Foods on 31 May, 2026 at 16:22:53. To check",
        "2026-05-31", -20300],
    ];
    for (const [body, date, amount] of cases) {
      const r = parseAlert("alerts@hdfcbank.net", "Alert", body);
      assert.equal(r?.record.date, date, body);
      assert.equal(r?.record.amount, amount);
      assert.equal(r?.record.cardLast4, "1111");
      assert.equal(r?.record.cardholderName, null);
    }
    assert.ok(parseAlert("alerts@hdfcbank.bank.in", "Alert", cases[2]![0]));
  });

  test("IMPORT-SND-5: an ICICI card spend dated month-first, and a standing instruction that ran", () => {
    const spend = parseAlert("credit_cards@icicibank.com", "Transaction alert",
      "Dear Customer, Your ICICI Bank Credit Card XX2222 has been used for a transaction of INR 1,528.00 on Apr 10, 2026 at 06:36:10. Info: ZZ INTERNET PVT. The Available Credit Limit on your card is INR 4,000.00");
    assert.equal(spend?.record.date, "2026-04-10");
    assert.equal(spend?.record.amount, -152800);
    assert.equal(spend?.record.narration, "ZZ INTERNET PVT");
    const ran = parseAlert("cards@icici.bank.in", "Transaction Success",
      "We have successfully processed your payment of INR 1499.00 towards ZZShop, with Standing Instruction Y00000, on 19/10/2026, through your ICICI Bank Credit Card 2222. Click here");
    assert.equal(ran?.record.date, "2026-10-19");
    assert.equal(ran?.record.amount, -149900);
    assert.equal(ran?.record.cardLast4, "2222");
  });

  test("IMPORT-SND-5: an upcoming standing instruction is neither a spend nor an unread alert", () => {
    const body = "Dear Customer, Your payment of INR 125.40 towards ZZShop through Standing Instruction Y00000 is due on 01/08/2026 and will be debited from your ICICI Bank Credit Card 2222.";
    assert.equal(parseAlert("cards@icici.bank.in", "Upcoming payment notification", body), null);
    assert.equal(looksLikeUnreadAlert("cards@icici.bank.in", body), false);
  });

  test("IMPORT-SND-6: Axis's older one-sentence card alert", () => {
    const r = parseAlert("alerts@axisbank.com", "Transaction alert",
      "31-12-2024 Dear Ravi Kumar, Thank you for using your credit card no. XX1111 for INR 649 at ZZ Gifts Pv on 31-12-2024 15:21:26 IST. The total credit limit across all your cards is INR 1000 while the available limit is now INR 351.00.");
    assert.equal(r?.record.date, "2024-12-31");
    assert.equal(r?.record.amount, -64900);
    assert.equal(r?.record.cardLast4, "1111");
    assert.equal(r?.record.cardholderName, "Ravi Kumar");
  });

  test("IMPORT-SND-7: an IndusInd card alert; a declined one moved no money", () => {
    const body = "The transaction on your IndusInd Bank Credit Card ending 3333 for INR 226.80 on 12-04-2025 09:49:46 pm at ZZ Foods Ltd is Approved. Available Limit: INR 1,000.00.";
    const r = parseAlert("transactionalert@indusind.com", "Transaction Alert", body);
    assert.equal(r?.record.date, "2025-04-12");
    assert.equal(r?.record.amount, -22680);
    assert.equal(r?.record.cardLast4, "3333");
    assert.equal(parseAlert("transactionalert@indusind.com", "Transaction Alert",
      body.replace("is Approved", "is Declined")), null);
  });

  test("IMPORT-SND-8: a Standard Chartered payment received is a credit, not a spend", () => {
    const r = parseAlert("alerts.in@sc.com", "Card Payment Received",
      "Alerts CASA | Email Alerts August 06 2025, 05:08 PM | Dear Customer, | We have received your payment of INR 270.00 towards your credit card number ending 4444. Thank you");
    assert.equal(r?.record.amount, 27000);
    assert.equal(r?.record.date, "2025-08-06");
    assert.equal(r?.record.cardLast4, "4444");
  });

  test("IMPORT-SND-9: an RBL card spend, and a payment as a credit", () => {
    const spend = parseAlert("RBLAlerts@rbl.bank.in", "Card swiped",
      "Card swipe | INR338.00 spent at PYU*ZZ FOOD on RBL Bank credit card (5555) on 21-04-2026.AVL limit- INR67,662.00.");
    assert.equal(spend?.record.amount, -33800);
    assert.equal(spend?.record.cardLast4, "5555");
    assert.equal(spend?.record.date, "2026-04-21");
    const paid = parseAlert("RBLAlerts@rbl.bank.in", "Payment",
      "Dear RAVI KUMAR, A payment of Rs.338.00 has been received towards your RBL Bank Credit Card ending with 55 on 31-05-2026 through BBPS.");
    assert.equal(paid?.record.amount, 33800);
    assert.equal(paid?.record.cardLast4, null);
  });

  test("IMPORT-SND-10: an HSBC card alert", () => {
    const r = parseAlert("hsbc@mail.hsbc.co.in", "You have used your HSBC Credit Card",
      "Dear Customer, We write to confirm that your Credit card no ending with 6666,has been used for INR 3992.00 for payment to ZZ Online Private Limi on 22 Jul 2024 at 14:01. If you want");
    assert.equal(r?.record.date, "2024-07-22");
    assert.equal(r?.record.amount, -399200);
    assert.equal(r?.record.cardLast4, "6666");
  });

  test("IMPORT-SND-11: both Canara card wordings", () => {
    const newer = parseAlert("noreply@canarabank.com", "Credit Card Transaction Alert",
      "Dear Customer, Thank you for using Canara Credit Card. INR 2,074.60 spent on CanaraBank CreditCard XX7777: ZZ FUELS on 31-AUG-26 17:51:42.Ref.000001 . Avl limit INR 1,000.00.");
    assert.equal(newer?.record.date, "2026-08-31");
    assert.equal(newer?.record.amount, -207460);
    assert.equal(newer?.record.narration, "ZZ FUELS");
    const older = parseAlert("noreply@canarabank.com", "Credit Card Transaction Alert",
      "Dear Customer, Thank you for using Canara Credit Card. Rs 1,988.08 spent on your Canara card ************7777 at ZZ PAY INDIA PRIVA on 08-NOV-25 at 14:52:27. Available limit Rs 1,000.00");
    assert.equal(older?.record.date, "2025-11-08");
    assert.equal(older?.record.amount, -198808);
    assert.equal(older?.record.cardLast4, "7777");
  });
});
