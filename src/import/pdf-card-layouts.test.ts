import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { parseStatementText, readHeader } from "./pdf-statements.ts";

/**
 * Card statement layouts found by running real SBI Card and Canara Bank card
 * statements through the parser (07-11-2026). The files stay out of the
 * repository; these rebuild the layout that broke, with invented names,
 * references and figures.
 */

/** SBI Card: one Amount column, then a lone C or D in a column of its own. */
const SBI_CARD = `GSTIN of SBI Card : 00AAAAA0000A0ZZ                                  Stmt/Debit Note/Credit Note/Tax Invoice
        RAVI KUMAR                                                                  Credit Card Number
       Credit Limit ( \` ) (including cash) Cash Limit ( \` )(as part of credit limit)  Statement Date
            1,00,000.00                         20,000.00                           13 Nov 2026
    Date                                    Transaction Details                                  Amount  ( \` )
                                      for Statement Period: 14 Oct 26 to 13 Nov 26
  15 Oct 26   PAYMENT RECEIVED 000AB1234567XYZ                                             500.00    C
              TRANSACTIONS FOR RAVI KUMAR
  20 Oct 26   SAMPLE STORES      SOMETOWN    IN (Pay in EMIs)                              1,250.00    D
 Transactions highlighted in grey color, if any, do not form part of Purchases & Other Debits; #Transactions fully/partially converted to Flexipay/Encash/Merchant EMI.
 C=Credit  ;   D=Debit; EN=Encash; FP=Flexipay; EMD=Easy Money Draft; BT=Balance Transfer; M=Monthly Installments; TAD=Total Amount Due; T=Temporary Credit.
                                                                    Important Messages
    A day after the statement is generated post account
    date of such EMI plans shall be debited to the Credit Card
`;

describe("SBI Card · a C or D column decides the sign", () => {
  test("a prose sentence naming a date, a debit and a credit is not the table header", () => {
    assert.equal(readHeader(["    date of such EMI plans shall be debited to the Credit Card"]), null);
  });

  test("C is a payment in, D a purchase, and neither is flagged", () => {
    const result = parseStatementText(SBI_CARD);
    assert.deepEqual(result.records.map((r) => r.amount), [50_000, -125_000]);
    assert.deepEqual(result.errors, []);
  });
});

describe("SBI Card · a row's narration is the row", () => {
  test("the table heading, a cardholder banner and a section title are not glued on", () => {
    const result = parseStatementText(SBI_CARD);
    assert.deepEqual(result.records.map((r) => r.narration), [
      "PAYMENT RECEIVED 000AB1234567XYZ",
      "SAMPLE STORES SOMETOWN IN (Pay in EMIs)",
    ]);
  });
});

/**
 * Canara Bank card: a Transaction Amount and a Closing Balance, each with its
 * own Cr / Dr set a few spaces apart, under headings that name neither debit
 * nor credit. The balance is what is owed, so Dr is below zero.
 */
const CANARA_CARD = `                                                                           Credit Card Statement
                                                                                                                                    e-mail: help@canarabank.com
                                                                  TRANSACTIONS SUMMARY(In Indian Rupees)
   Transaction Date             Reference No.                          Transaction Description                        Transaction Amount                      Closing Balance
                                                                                                                                  Previous Balance :                      2,000.00   Dr
     05-10-2026        123456                         BBPS Payment                                                                   2,000.00 Cr                              0.00   Dr
     08-10-2026        111122223333                   FUEL SURCHARGE REIMB                                                              15.00 Cr                             15.00   Cr
     10-10-2026        111122223333444                ANNUAL FEE 0000-0000 THRHLD-000000 USED-                                        300.00  Dr                            285.00   Dr
                                                      50000.00
     10-10-2026        111122223333                   IGST @ 18%  On Fees and Charges                                                   54.00 Dr                            339.00   Dr
                                     For details of Complimentary Insurance provided by M/s ABC, please refer MITC.
                                     For claim, contact:
           Insurance                 Mr. A Sample
                                     Canara Bank
`;

describe("Canara card · the closing balance column decides the sign", () => {
  test("a payment that clears the balance to 0.00 Dr is a credit, not an unreadable row", () => {
    const result = parseStatementText(CANARA_CARD);
    assert.deepEqual(result.records.map((r) => r.amount), [200_000, 1_500, -30_000, -5_400]);
    assert.deepEqual(result.errors, []);
  });
});

describe("Canara card · a paragraph below the table is not a row's payee", () => {
  test("a notice set left of the description column stays out of the last row", () => {
    const last = parseStatementText(CANARA_CARD).records.at(-1)!;
    assert.match(last.narration, /^IGST @ 18% On Fees and Charges\b/);
    assert.doesNotMatch(last.narration, /details|claim|Insurance|Sample/);
  });

  test("a payee wrapped onto the line below, in its own column, is still kept", () => {
    const result = parseStatementText(`YES BANK
Date        Description            Amount
15/02/2026  A LONG MERCHANT        100.00 Dr
            NAME CONTINUED`);
    assert.match(result.records[0]!.narration, /A LONG MERCHANT/);
    assert.match(result.records[0]!.narration, /NAME CONTINUED/);
  });
});
