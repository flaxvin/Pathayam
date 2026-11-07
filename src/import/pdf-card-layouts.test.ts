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
