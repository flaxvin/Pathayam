/**
 * DEBUG-TAX · Which cities take the 50% HRA share, by year.
 *
 * Income-tax Rules 2026 (CBDT Notification 22/2026, from 1 April 2026) put
 * Bengaluru, Hyderabad, Pune and Ahmedabad beside Delhi, Mumbai, Kolkata and
 * Chennai. The form named only the four, so somebody renting in Bengaluru in
 * 2026-27 left the box unticked and was given 40%.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import type { Paise } from "../core/money.ts";
import { hraFiftyPercentCities } from "./tax.ts";
import { taxOnGains } from "./capital-gains-tax.ts";
import { renderTax } from "../web/pages/tax.ts";

const EMPTY = {
  equityLong: 0 as Paise, equityShort: 0 as Paise, otherLong: 0 as Paise,
  slabRated: 0 as Paise, unclassified: 0 as Paise, unclassifiedReasons: [],
};

function page(fy: number): string {
  return renderTax({
    fy, gross: 0 as Paise, ledgerIncome: 0 as Paise,
    deductions: { s80c: 0 as Paise, s80d: 0 as Paise, s80dSenior: false, other: 0 as Paise, hra: null },
    estimate: null, advance: [], gains: taxOnGains(fy, EMPTY), staleWarning: null,
    ratesVerifiedOn: "2026-10-22", ratesSource: "https://incometaxindia.gov.in", availableYears: [2026, 2025],
  }).value;
}

test("2025-26 keeps the four cities", () => {
  assert.deepEqual(hraFiftyPercentCities(2025), ["Delhi", "Mumbai", "Kolkata", "Chennai"]);
  assert.ok(!page(2025).includes("Bengaluru"));
});

test("2026-27 adds Bengaluru, Hyderabad, Pune and Ahmedabad, and the form says so", () => {
  const cities = hraFiftyPercentCities(2026);
  for (const c of ["Delhi", "Mumbai", "Kolkata", "Chennai", "Bengaluru", "Hyderabad", "Pune", "Ahmedabad"]) {
    assert.ok(cities.includes(c), c);
    assert.ok(page(2026).includes(c), `the form names ${c}`);
  }
});
