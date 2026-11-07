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

/**
 * IMP-34 · A month in which gold moved in from a partner bank's wallet, in the
 * shape a real statement prints it — the figures and the partner are made up.
 *
 *   · The opening balance in the summary wraps its grams onto the next line.
 *   · A row's date stands alone on its line; the details, the signed quantity
 *     ("+ 0.5000 g", the sign apart) and the balance follow on the next; the
 *     time comes last, on its own line. The statement's font maps ":" and
 *     "(" to private-use code points, so "09:41:07 PM" is extracted as
 *     "09\uE09241\uE09207 PM" and "(99.5%" as "\uE08199.5%".
 *   · A second "Transaction Statement" follows for the partner's own wallet,
 *     with its own opening and closing lines. It is not SafeGold's wallet.
 */
export const TRANSFER_STATEMENT = [
  "                                                    RAVI EXAMPLE",
  "Account Summary",
  "                                                    As of 31st December 2026",
  " SafeGold Balance                                                   1.2345 g",
  " Gold Balance with SafeGold Distributors                            0.0000 g",
  "    Transaction Summary",
  "Opening Gold Wallet Balance as of 1st December 2026 :",
  "                                                                    0.0000 g",
  " Transaction Activities between 1st December 2026 to 31st December 2026",
  " Total Purchased Gold                                               0.0000 g",
  " Total Other Gold Inflows                                           1.2345 g",
  "Closing Gold Wallet Balance as of 31st December 2026 :              1.2345 g",
  "Opening Gold Balance with Example Bank                              1.2400 g",
  "Closing Gold balance with Example Bank                              0.0000 g",
  "",
  "    T ransaction Statement",
  "                                           Opening Gold Wallet Balance as of",
  "                                        1st December 2026 \uE088 0.0000 g",
  "Date & Time         Transaction Details                            Quantity        Closing Balance",
  "31st December 2026",
  "                    Gold transferred from Example Bank \uE08199.5% to 99.99% purity)   + 1.2345 g     1.2345 g",
  "09\uE09241\uE09207 PM",
  "                                           Closing Gold Wallet Balance as of",
  "                                        31st December 2026 - 1.2345 g",
  "",
  "    T ransaction Statement",
  "                                           Opening Gold Wallet Balance as of",
  "                                        1st December 2026 - 1.2400 g",
  "Date & Time         Transaction Details                            Quantity        Closing Balance",
  "31st December 2026",
  "                    Gold transferred to SafeGold \uE08199.5% to 99.99% purity)          - 1.2400 g     0.0000 g",
  "09\uE09241\uE09207 PM",
  "                                           Closing Gold Wallet Balance as of",
  "                                        31st December 2026 - 0.0000 g",
].join("\n");

/**
 * The statement as a one-page, unencrypted PDF, one text run per line, so a
 * test goes through the real chain: extract → recognise → parse. Helvetica
 * has no rupee sign, so "₹" is written "Rs.".
 */
export function safeGoldPdf(text: string): Uint8Array {
  const lines = text.split("\n");
  const escape = (s: string) => s.replace(/₹/g, "Rs.").replace(/[\\()]/g, (c) => `\\${c}`);
  const content = lines
    .map((line, i) => `BT /F1 8 Tf 1 0 0 1 20 ${820 - i * 11} Tm (${escape(line)}) Tj ET`)
    .join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
  ];
  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((o, i) => {
    offsets.push(body.length);
    body += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const at of offsets) body += `${String(at).padStart(10, "0")} 00000 n \n`;
  body += `trailer << /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(body, "latin1"));
}
