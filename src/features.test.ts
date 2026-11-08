/**
 * PLAN-1 · Reading a plan from the environment, and the route table.
 *
 * The crawls (src/web/plan-*.test.ts) prove that each configuration works.
 * This proves each configuration is the one that was asked for: the preset
 * picked, an override winning over it, and a value that cannot be read
 * stopping the process rather than quietly switching a paid module on or off.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { loadConfig, InvalidConfiguration } from "./config.ts";
import {
  FEATURE_ENV, FEATURE_NAMES, PLANS, PLAN_PRESETS, pathAvailable, anyImport,
  ALL_FEATURES_ON, ALL_FEATURES_OFF,
} from "./features.ts";

const base = { BASE_URL: "http://localhost:8080" };

describe("PLAN-1 · presets", () => {
  test("no PLAN is self-hosted: every module but multi-currency, no limits", () => {
    const c = loadConfig(base);
    assert.equal(c.plan, "selfhost");
    for (const name of FEATURE_NAMES) assert.equal(c.features[name], name !== "multiCurrency", name);
    assert.deepEqual(c.limits, { maxMembers: null, backupRetentionDays: null });
  });

  test("Solo is the budget for one person, as the pricing page sells it", () => {
    const c = loadConfig({ ...base, PLAN: "solo" });
    assert.equal(c.limits.maxMembers, 1);
    assert.equal(c.limits.backupRetentionDays, 30);
    for (const off of ["loans", "familyLoans", "assets", "apiTokens", "ai", "gmail", "multiCurrency"] as const) {
      assert.equal(c.features[off], false, off);
    }
    for (const on of ["insurance", "goals", "tax", "reports", "schedules", "rules", "attachments",
      "importCsv", "importPdf", "importBudgetApp", "deposits"] as const) {
      assert.equal(c.features[on], true, on);
    }
  });

  test("Household is up to 5 with 90 days; Power is unlimited with a year; neither has Gmail", () => {
    const h = loadConfig({ ...base, PLAN: "household" });
    assert.deepEqual(h.limits, { maxMembers: 5, backupRetentionDays: 90 });
    const p = loadConfig({ ...base, PLAN: "Power" });
    assert.deepEqual(p.limits, { maxMembers: null, backupRetentionDays: 365 });
    for (const c of [h, p]) {
      assert.equal(c.features.gmail, false);
      assert.equal(c.features.apiTokens, true);
      assert.equal(c.features.ai, true);
      assert.equal(c.features.loans, true);
    }
  });

  test("every preset names every flag", () => {
    for (const plan of PLANS) assert.deepEqual(Object.keys(PLAN_PRESETS[plan].features).sort(), [...FEATURE_NAMES].sort());
  });
});

describe("PLAN-1 · a variable set on its own wins over the preset", () => {
  test("FEATURE_* in either direction", () => {
    const c = loadConfig({ ...base, PLAN: "solo", FEATURE_LOANS: "true", FEATURE_GOALS: "off" });
    assert.equal(c.features.loans, true);
    assert.equal(c.features.goals, false);
    assert.equal(c.features.assets, false, "the rest stay as the preset has them");
  });

  test("every flag is read from its own variable", () => {
    for (const name of FEATURE_NAMES) {
      const on = loadConfig({ ...base, PLAN: "solo", [FEATURE_ENV[name]]: "1" });
      const off = loadConfig({ ...base, [FEATURE_ENV[name]]: "0" });
      assert.equal(on.features[name], true, FEATURE_ENV[name]);
      assert.equal(off.features[name], false, FEATURE_ENV[name]);
    }
  });

  test("MAX_MEMBERS and BACKUP_RETENTION_DAYS, including lifting a limit", () => {
    assert.equal(loadConfig({ ...base, PLAN: "solo", MAX_MEMBERS: "2" }).limits.maxMembers, 2);
    assert.equal(loadConfig({ ...base, PLAN: "solo", MAX_MEMBERS: "unlimited" }).limits.maxMembers, null);
    assert.equal(loadConfig({ ...base, PLAN: "solo", MAX_MEMBERS: "0" }).limits.maxMembers, null);
    assert.equal(loadConfig({ ...base, BACKUP_RETENTION_DAYS: "7" }).limits.backupRetentionDays, 7);
    assert.equal(loadConfig({ ...base, PLAN: "power", BACKUP_RETENTION_DAYS: "" }).limits.backupRetentionDays, 365);
  });
});

describe("PLAN-1 · a value that cannot be read stops the process", () => {
  const refuses = (env: Record<string, string>, name: RegExp) =>
    assert.throws(() => loadConfig({ ...base, ...env }),
      (err: unknown) => err instanceof InvalidConfiguration && name.test(err.message));

  test("an unknown plan", () => refuses({ PLAN: "family" }, /PLAN is 'family'.*selfhost, solo, household, power/));
  test("a misspelt flag", () => refuses({ FEATURE_LOANS: "flase" }, /FEATURE_LOANS is 'flase'/));
  test("a limit that is not a whole number in range", () => {
    for (const v of ["-1", "1.5", "five", "1001"]) refuses({ MAX_MEMBERS: v }, /MAX_MEMBERS/);
    for (const v of ["-1", "3651", "a year"]) refuses({ BACKUP_RETENTION_DAYS: v }, /BACKUP_RETENTION_DAYS/);
  });
});

describe("PLAN-1 · the route table", () => {
  test("core pages are always served", () => {
    for (const path of ["/", "/accounts", "/accounts/new", "/accounts/abc", "/review", "/months", "/cards",
      "/transaction/abc", "/search", "/export.json", "/export.csv", "/settings", "/health", "/add", "/more"]) {
      assert.ok(pathAvailable(path, ALL_FEATURES_OFF), path);
    }
  });

  test("each module's pages go with it, matched on whole segments", () => {
    const cases: [string, keyof typeof FEATURE_ENV][] = [
      ["/loans/what-if", "loans"], ["/transaction/abc/convert-to-emi", "loans"],
      ["/family/abc", "familyLoans"], ["/portfolio/cas", "assets"], ["/net-worth.csv", "assets"],
      ["/fire", "assets"], ["/accounts/abc/deposit/remove", "deposits"], ["/insurance/new", "insurance"],
      ["/goals", "goals"], ["/tax/payments", "tax"], ["/query.csv", "reports"], ["/reports", "reports"],
      ["/schedules/new", "schedules"], ["/rules/test", "rules"], ["/attachment/abc", "attachments"],
      ["/transaction/abc/attach", "attachments"], ["/import/pdf", "importPdf"],
      ["/import/budget-app", "importBudgetApp"], ["/gmail/fetch", "gmail"], ["/tokens", "apiTokens"],
      ["/tokens/ai", "ai"], ["/mcp", "ai"], ["/oauth/token", "ai"], ["/export/analysis.json", "ai"],
      ["/.well-known/oauth-authorization-server", "ai"],
    ];
    for (const [path, name] of cases) {
      assert.equal(pathAvailable(path, { ...ALL_FEATURES_ON, [name]: false }), false, `${path} without ${name}`);
      assert.equal(pathAvailable(path, { ...ALL_FEATURES_OFF, [name]: true }), true, `${path} with only ${name}`);
    }
    assert.ok(pathAvailable("/goalsx", ALL_FEATURES_OFF), "a prefix is a segment, not a string");
  });

  test("the import page is there while any way in is", () => {
    for (const name of ["importCsv", "importPdf", "importBudgetApp"] as const) {
      const only = { ...ALL_FEATURES_OFF, [name]: true };
      assert.ok(anyImport(only));
      assert.ok(pathAvailable("/import", only));
      assert.ok(pathAvailable("/import/undo", only));
    }
    assert.equal(pathAvailable("/import", ALL_FEATURES_OFF), false);
    // A PDF with no known layout is mapped like a CSV.
    assert.ok(pathAvailable("/import/map", { ...ALL_FEATURES_OFF, importPdf: true }));
    assert.equal(pathAvailable("/import/map", { ...ALL_FEATURES_OFF, importBudgetApp: true }), false);
  });
});

describe("AIW-1 · AI_WRITE", () => {
  test("off unless set, and never turned on by a preset", () => {
    assert.equal(loadConfig(base).aiWrite, "off");
    for (const plan of PLANS) assert.equal(loadConfig({ ...base, PLAN: plan }).aiWrite, "off", plan);
    assert.equal(loadConfig({ ...base, AI_WRITE: "" }).aiWrite, "off");
  });

  test("standard and full are read, case forgiven", () => {
    assert.equal(loadConfig({ ...base, AI_WRITE: "standard" }).aiWrite, "standard");
    assert.equal(loadConfig({ ...base, AI_WRITE: " FULL " }).aiWrite, "full");
    assert.equal(loadConfig({ ...base, AI_WRITE: "off" }).aiWrite, "off");
  });

  test("anything else stops the process, naming what it takes", () => {
    for (const value of ["on", "true", "1", "write"]) {
      assert.throws(() => loadConfig({ ...base, AI_WRITE: value }),
        (err: unknown) => err instanceof InvalidConfiguration && /AI_WRITE is .*off, standard, full/.test(err.message));
    }
  });

  test("it is not a module: no FEATURE_ variable switches it", () => {
    assert.ok(!Object.values(FEATURE_ENV).some((v) => v.includes("WRITE")));
  });
});
