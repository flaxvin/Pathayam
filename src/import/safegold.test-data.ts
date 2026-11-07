/**
 * A synthetic SafeGold statement, for the SafeGold reader's tests.
 *
 * The shape follows a real statement — account summary, transaction summary,
 * transaction statement — and nothing else of one: every name, number and
 * row here is made up.
 */

const HEAD = [
  "                                                    RAVI EXAMPLE",
  "                                                    9000000000",
  "                                                    ravi@example.com",
  "Account Summary",
  "                                                    As of 31st October 2026",
  " SafeGold Balance                                                   1.5000 g",
  "  Available Gold Balance                                            1.5000 g",
  "  Gold on Lease                                                     0.0000 g",
  " Gold Balance with SafeGold Distributors                            0.0000 g",
  " Total Gold                                                         1.5000 g",
  "",
  "   Transaction Summary",
  "Opening Gold Wallet Balance as of 1st October 2026 :                1.0000 g",
  "Opening Leased Gold Balance as of 1st October 2026 :                0.0000 g",
  "Opening Available Gold Balance as of 1st October 2026 :             1.0000 g",
  " Transaction Activities between 1st October 2026 to 31st October 2026",
  " Total Purchased Gold                                               0.7000 g",
  " Total Sold Gold                                                    0.2000 g",
  " Net Change in Available Balance                                    0.5000 g",
  "Closing Available Gold Balance as of 31st October 2026 :            1.5000 g",
  "Closing Leased Gold Balance as of 31st October 2026 :               0.0000 g",
  "Closing Gold Wallet Balance as of 31st October 2026 :               1.5000 g",
  "",
  "   Transaction Statement",
  "                                           Opening Gold Wallet Balance as of",
  "                                           1st October 2026   1.0000 g",
  "Date & Time     Transaction Details                            Quantity          Closing Balance",
];

const FOOT = [
  "                                           Closing Gold Wallet Balance as of",
  "                                           31st October 2026   1.5000 g",
];

/** The statement around these rows, closing at `closing` grams wherever it says so. */
export const statement = (rows: string[], closing = "1.5000") =>
  [...HEAD, ...rows, ...FOOT].join("\n")
    .replace(/(Closing (?:Gold Wallet|Available Gold) Balance as of 31st October 2026 :\s+)1\.5000/g, `$1${closing}`)
    .replace(/(31st October 2026   )1\.5000/, `$1${closing}`);

export const TWO_ROWS = [
  "05 Oct 2026     Gold Purchased                                  0.7000 g          1.7000 g",
  "10:15 AM        Rate ₹10,000.00/g  Amount ₹7,210.00 (incl. GST ₹210.00)",
  "20 Oct 2026     Gold Sold                                       0.2000 g          1.5000 g",
  "04:30 PM        Rate ₹10,500.00/g  Amount ₹2,100.00",
];
