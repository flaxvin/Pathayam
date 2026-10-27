import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { parseCasText, unitsDisagreement } from "./cas.ts";

/*
 * The three statement shapes a household's inbox actually carries, beyond
 * the classic CDSL MF CAS the original fixture models. Every figure, folio and
 * name here is invented.
 */

const CDSL_DEMAT = [
  "CONSOLIDATED ACCOUNT STATEMENT (CAS) FOR SECURITIES HELD IN DEMAT",
  "                       30-09-2026 HOLDING STATEMENT AS ON 30-09-2026",
  "                                                                     Market",
  "                                  Current  Frozen  Pledge        Price /",
  "      ISIN              Security                    Setup  Free Bal    Value (`)",
  "                                  Bal      Bal     Bal                  Face",
  "                                                                         Value",
  "               ALPHA AMC LTD# ALPHA MF -",
  "INF000A01AA1   ALPHA GOLD FUND OF            1000.000      --     --        -- 1000.000  45.523045,523.00",
  "               FUND - DIRECT PLAN- GROWTH",
  "               BETA HOTELS LIMITED # EQUITY",
  "INE000B01BB2                                    2.000      --     --        --    2.000  729.0000   1,458.00",
  "               SHARES",
  "               GAMMA ASSET MANAGEMENT",
  "               LTD#GAMMA MF-GAMMA NIFTY",
  "INF000C01CC3   MIDCAP 150 INDEX FUND         145.018      --     --        --  145.018   39.6700   5,752.86",
  "               -DIRECT-",
  "               GROWTH",
  "Portfolio Value ` 52,733.86 as on 30-09-2026",
  "BO ID            ISIN               Scheme Name",
  "1200000000000001 INF000A01AA1   ALPHA GOLD FUND",
].join("\n");

const CAMS_FOLIO = [
  "FOLIO NUMBER : 11112222",
  " FOLIO DETAILS                                                  BANK DETAILS",
  " FINANCIAL TRANSACTIONS",
  " AB123C DELTA US EQUITY FOF DIRECT PLAN GROWTH                                 ISIN CODE : INF000D01DD4",
  "                                                Amount            NAV            PRICE",
  " DATE                    TRANSACTION TYPE                                              UNITS      BALANCE UNITS",
  "             Opening Balance                                                                               306.299",
  " 10-Aug-2026   Redemption(Electronic credit)-BSE -      (7812.4)     25.5058          25.5058       (306.299)",
  "                                                                  ...continued  on next page Page 1 / 2",
  "FOLIO NUMBER : 11112222",
  " 12-Aug-2026   Purchase-BSE -                            1000.00     25.0000          25.0000          40.000          40.000",
].join("\n");

const KFINTECH_FOLIO = [
  "                                  01/01/2025 to 31/01/2025",
  " Name         : A HOLDER                                   FOLIO    : 9999888877                    CAN         :",
  "Detailed Transaction Summary",
  " Scheme      Epsilon Nifty Midcap 150 Index Fund - Direct Plan Growth- ISIN No : INF000E01EE5 (Demat)",
  "NAV Date     Transaction Type                                  Amount(INR)    NAV(INR)         Units    Unit Balance",
  "             Opening Balance                                                                          145.018",
  "Balance Units:   145.018     Pledged/Blocked Units:     0.000       Free Units:    145.018",
].join("\n");

describe("a CDSL demat CAS · the holding statement", () => {
  const statement = parseCasText(CDSL_DEMAT);

  test("every ISIN in the holding table becomes a holding", () => {
    assert.deepEqual(statement.schemes.map((s) => s.isin), ["INF000A01AA1", "INE000B01BB2", "INF000C01CC3"]);
  });

  test("a name wrapped above and below its row is put back together", () => {
    assert.deepEqual(statement.schemes.map((s) => s.name), [
      "ALPHA MF - ALPHA GOLD FUND OF FUND - DIRECT PLAN- GROWTH",
      "BETA HOTELS LIMITED EQUITY SHARES",
      "GAMMA MF-GAMMA NIFTY MIDCAP 150 INDEX FUND -DIRECT- GROWTH",
    ]);
    assert.equal(statement.schemes[0]!.amc, "ALPHA AMC LTD");
  });

  test("a value run into its price is split where units × price is the value", () => {
    const alpha = statement.schemes[0]!;
    assert.equal(alpha.closingUnits, 1_000_000);
    assert.equal(alpha.closingNav, 45_523_000);
    assert.equal(alpha.closingValue, 4_552_300);
  });

  test("a holdings snapshot is not reported as disagreeing with rows it never had", () => {
    for (const scheme of statement.schemes) assert.equal(unitsDisagreement(scheme), null);
  });
});

describe("a CAMS folio statement", () => {
  const statement = parseCasText(CAMS_FOLIO);

  test("the scheme is named from its ISIN line, without the product code", () => {
    assert.equal(statement.schemes.length, 1);
    assert.equal(statement.schemes[0]!.name, "DELTA US EQUITY FOF DIRECT PLAN GROWTH");
    assert.equal(statement.schemes[0]!.isin, "INF000D01DD4");
    assert.equal(statement.schemes[0]!.folio, "11112222");
  });

  test("units and NAV are read from CAMS's amount, NAV, price, units order", () => {
    const [redemption, purchase] = statement.schemes[0]!.rows;
    assert.equal(redemption!.kind, "redemption");
    assert.equal(redemption!.units, -306_299);
    assert.equal(redemption!.nav, 25_505_800);
    // The repeated folio line at the page break kept the scheme open.
    assert.equal(purchase!.kind, "purchase");
    assert.equal(purchase!.units, 40_000);
  });

  test("the opening balance counts toward the units check", () => {
    assert.equal(statement.schemes[0]!.openingUnits, 306_299);
  });
});

describe("a KFintech folio statement", () => {
  const statement = parseCasText(KFINTECH_FOLIO);

  test("a folio with no activity still lists its holding", () => {
    assert.equal(statement.schemes.length, 1);
    const scheme = statement.schemes[0]!;
    assert.equal(scheme.name, "Epsilon Nifty Midcap 150 Index Fund - Direct Plan Growth");
    assert.equal(scheme.isin, "INF000E01EE5");
    assert.equal(scheme.closingUnits, 145_018);
    assert.equal(unitsDisagreement(scheme), null);
  });

  test("its bare date range is the statement period", () => {
    assert.deepEqual(statement.period, { from: "2025-01-01", to: "2025-01-31" });
  });
});

describe("CAS row descriptions that registrars write their own way", () => {
  const scheme = (row: string) => parseCasText([
    "Folio No: 1234/56",
    "Zeta Flexi Cap Fund - Direct Plan - Growth",
    "ISIN: INF000Z01ZZ9",
    row,
  ].join("\n")).schemes[0]!.rows[0]!;

  test("a description ending in a bare number does not become the amount", () => {
    const row = scheme("07-Apr-2026  SIP Purchase Instalment 3  1,000.00  10.000  100.0000  60.000");
    assert.equal(row.description, "SIP Purchase Instalment 3");
    assert.equal(row.amount, 100_000);
    assert.equal(row.units, 10_000);
    assert.equal(row.nav, 100_000_000);
  });
});
