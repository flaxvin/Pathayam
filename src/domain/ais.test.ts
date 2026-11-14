/**
 * TAX-AIS · Checking, storing and summarising a member's AIS, and what the
 * tax page offers from it. Synthetic statements only (src/import/ais.test-data.ts).
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { Paise } from "../core/money.ts";
import { rupees } from "../core/money.ts";
import { queryOne } from "../db/db.ts";
import { Refusal } from "../core/refusal.ts";
import { parseAisText } from "../import/ais.ts";
import { aisText, sampleAis, AIS_PAN, AIS_DOB } from "../import/ais.test-data.ts";
import { setIdentity } from "../import/identity.ts";
import { checkAis, replaceAis, deleteAis, aisSummary, applyAisSuggestion } from "./ais.ts";
import { freshDb, seedMember } from "../web/harness.test-data.ts";
import { taxPageModel } from "../web/screen-data.ts";
import { createAssetAccount, findOrCreateInstrument, recordPurchase, recordSale, listHoldings } from "./assets.ts";
import { units, price } from "../portfolio/holdings.ts";

const sample = () => parseAisText(aisText(sampleAis()));

function setup() {
  const db = freshDb();
  seedMember(db, "m", "Ravi");
  seedMember(db, "p", "Priya");
  return db;
}

function importFor(db: ReturnType<typeof setup>, memberId: string, fy = 2025) {
  const statement = sample();
  const check = checkAis(db, memberId, fy, statement);
  replaceAis(db, memberId, fy, statement, check);
  return check;
}

describe("TAX-AIS · whose AIS, and for which year", () => {
  test("a PAN that is not the member's saved PAN is refused", () => {
    const db = setup();
    setIdentity(db, { memberId: "m", source: "ui" }, { name: "Ravi", pan: "ZZZZZ9999Z", dob: AIS_DOB });
    assert.throws(() => checkAis(db, "m", 2025, sample()), (e: unknown) =>
      e instanceof Refusal && /not the PAN saved for you/.test(e.message) && !/ZZZZZ9999Z|ABCDE1234F/.test(e.message));
  });

  test("the member's own PAN passes, checked", () => {
    const db = setup();
    setIdentity(db, { memberId: "m", source: "ui" }, { name: "Ravi", pan: AIS_PAN.toLowerCase(), dob: AIS_DOB });
    assert.deepEqual(checkAis(db, "m", 2025, sample()), { panChecked: true, warnings: [] });
  });

  test("with no saved PAN it is imported with a warning", () => {
    const db = setup();
    const check = checkAis(db, "m", 2025, sample());
    assert.equal(check.panChecked, false);
    assert.match(check.warnings[0]!, /could not be checked as yours/);
  });

  test("a file for another year than the page's is refused", () => {
    const db = setup();
    assert.throws(() => checkAis(db, "m", 2026, sample()), /is for FY 2025-26|2025-26/);
  });

  test("a year the app has no slabs for is refused, as the page refuses it", () => {
    const db = setup();
    const old = parseAisText(aisText(sampleAis({ fy: "2024-25" })));
    assert.throws(() => checkAis(db, "m", 2024, old), Refusal);
  });
});

describe("TAX-AIS · storage", () => {
  test("a re-import replaces the year: the same file twice is the same lines", () => {
    const db = setup();
    importFor(db, "m");
    const once = queryOne<{ n: number }>(db, `SELECT COUNT(*) AS n FROM ais_lines WHERE member_id = 'm'`)!.n;
    importFor(db, "m");
    const twice = queryOne<{ n: number }>(db, `SELECT COUNT(*) AS n FROM ais_lines WHERE member_id = 'm'`)!.n;
    assert.equal(once, sample().lines.length);
    assert.equal(twice, once);
    assert.equal(aisSummary(db, "m", 2025)!.tdsTotal, 85_800_00);
  });

  test("another year is left alone by a re-import", () => {
    const db = setup();
    importFor(db, "m", 2025);
    const next = parseAisText(aisText(sampleAis({ fy: "2026-27" })));
    replaceAis(db, "m", 2026, next, checkAis(db, "m", 2026, next));
    importFor(db, "m", 2025);
    assert.ok(aisSummary(db, "m", 2026));
    assert.ok(aisSummary(db, "m", 2025));
  });

  test("nothing personal is stored: no PAN, no name, no address", () => {
    const db = setup();
    importFor(db, "m");
    const dump = JSON.stringify([
      ...db.prepare(`SELECT * FROM ais_lines`).all(), ...db.prepare(`SELECT * FROM ais_imports`).all(),
    ]);
    assert.doesNotMatch(dump, /ABCDE1234F|abcde1234f|TEST PERSON|EXAMPLE ROAD/);
  });

  test("forgetting removes the year's lines", () => {
    const db = setup();
    importFor(db, "m");
    assert.equal(deleteAis(db, "m", 2025), true);
    assert.equal(aisSummary(db, "m", 2025), null);
    assert.equal(queryOne<{ n: number }>(db, `SELECT COUNT(*) AS n FROM ais_lines`)!.n, 0);
  });
});

describe("TAX-AIS · the summary", () => {
  test("TDS by deductor, and income by kind with a bank's two reports counted once", () => {
    const db = setup();
    importFor(db, "m");
    const s = aisSummary(db, "m", 2025)!;
    assert.deepEqual(s.tdsBySource.map((t) => [t.source, t.tds]), [
      ["EXAMPLE SOFTWARE LTD (BLRE00000A)", 80_000_00],
      ["SAMPLE BANK (MUMS00000B)", 5_000_00],
      ["EXAMPLE INDUSTRIES LTD (MUME00000C)", 800_00],
    ]);
    assert.equal(s.salary, 12_00_000_00);
    assert.equal(s.interestSavings, 4_200_00);
    // 194A's ₹50,000 and SFT-016's ₹48,000 from the same bank: the higher, not both.
    assert.equal(s.interestDeposit, 50_000_00);
    // 194's ₹8,000 and SFT-015's ₹8,000 from the same company: once.
    assert.equal(s.dividends, 8_000_00);
    assert.equal(s.securitiesSold, 2_50_000_00);
    assert.equal(s.incomeOffer, (12_00_000_00 + 4_200_00 + 50_000_00 + 8_000_00) as Paise);
    assert.deepEqual(s.unread.map((u) => u.label), ["Rent received"]);
    assert.deepEqual(s.notRead, [{ part: "Payment of taxes", lines: 1 }]);
  });

  test("the app's own sale proceeds for the member's holdings sit beside the AIS's sales", () => {
    const db = setup();
    const ravi = { memberId: "m", source: "ui" as const };
    const demat = createAssetAccount(db, ravi, {
      name: "Demat", subtype: "investment", holderMemberId: "m", visibility: "household",
    }).id;
    const share = findOrCreateInstrument(db, ravi, {
      name: "Example Co", kind: "mutual-fund", symbol: "EXCO", provider: "manual",
    }).id;
    recordPurchase(db, ravi, {
      accountId: demat, instrumentId: share, tradeDate: "2024-04-10", price: price(1_000), units: units(100),
    });
    recordSale(db, ravi, {
      holdingId: listHoldings(db, demat)[0]!.id, date: "2025-06-01", units: units(100), price: price(2_400),
    });
    importFor(db, "m");
    assert.equal(aisSummary(db, "m", 2025)!.appSaleProceeds, rupees(2_40_000));
  });
});

describe("TAX-AIS · applying it to the form", () => {
  test("raises gross and TDS, never lowers them", () => {
    const db = setup();
    importFor(db, "m");
    const s = aisSummary(db, "m", 2025)!;
    assert.deepEqual(applyAisSuggestion({ gross: 0 as Paise, tds: 0 as Paise }, s), { gross: s.incomeOffer, tds: s.tdsTotal });
    const higher = { gross: rupees(50_00_000), tds: rupees(5_00_000) };
    assert.deepEqual(applyAisSuggestion(higher, s), higher);
  });

  test("the page model offers it only when asked, and nothing is saved", () => {
    const db = setup();
    importFor(db, "m");
    const plain = taxPageModel(db, "m", 2025, false);
    assert.equal(plain.applyAis, false);
    assert.equal(plain.formTds, 0);
    const applied = taxPageModel(db, "m", 2025, false, true);
    assert.equal(applied.applyAis, true);
    assert.equal(applied.formTds, 85_800_00);
    assert.ok(applied.formGross! >= 12_62_200_00);
    // Asking did not save: the declaration's TDS is still nothing.
    assert.equal(taxPageModel(db, "m", 2025, false).paid.tds, 0);
    assert.equal(queryOne(db, `SELECT 1 FROM tax_declarations WHERE member_id = 'm'`), null);
  });
});

describe("TAX-AIS · one member's AIS is theirs alone", () => {
  test("another member sees none of it, and cannot apply it", () => {
    const db = setup();
    importFor(db, "m");
    assert.equal(aisSummary(db, "p", 2025), null);
    const priya = taxPageModel(db, "p", 2025, false, true);
    assert.equal(priya.fromAis, null);
    assert.equal(priya.applyAis, false);
    assert.equal(priya.formTds, 0);
  });

  test("another member forgetting their year leaves this member's alone", () => {
    const db = setup();
    importFor(db, "m");
    importFor(db, "p");
    deleteAis(db, "p", 2025);
    assert.ok(aisSummary(db, "m", 2025));
  });
});
