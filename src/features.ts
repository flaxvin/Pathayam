/**
 * PLAN-1 · Which modules a deployment offers, and the limits it runs under.
 *
 * A hosted instance is one container per household, so a plan is nothing more
 * than how that container is configured. `PLAN` picks a preset; every
 * `FEATURE_*`, `MAX_MEMBERS` and `BACKUP_RETENTION_DAYS` set on its own wins
 * over the preset. The default preset, `selfhost`, is everything on — a
 * self-hosted install, and the public demo, behave exactly as they did before
 * plans existed.
 *
 * A module switched off disappears (F28.2): its pages answer 404, and nothing
 * links to it. Its data is kept, untouched, so a household that moves to a
 * plan with the module gets it back as it left it.
 *
 * What is never gated: the budget, accounts, cards, transactions, review,
 * month close, reconciliation, the export (every plan promises it), health,
 * settings and sign-in. Those are the app, not modules of it.
 */

/** Every module that can be switched off, with the variable that switches it. */
export const FEATURE_ENV = {
  loans: "FEATURE_LOANS",
  familyLoans: "FEATURE_FAMILY_LOANS",
  assets: "FEATURE_ASSETS",
  deposits: "FEATURE_DEPOSITS",
  insurance: "FEATURE_INSURANCE",
  goals: "FEATURE_GOALS",
  tax: "FEATURE_TAX",
  reports: "FEATURE_REPORTS",
  schedules: "FEATURE_SCHEDULES",
  rules: "FEATURE_RULES",
  attachments: "FEATURE_ATTACHMENTS",
  importCsv: "FEATURE_IMPORT_CSV",
  importPdf: "FEATURE_IMPORT_PDF",
  importBudgetApp: "FEATURE_IMPORT_BUDGET_APP",
  gmail: "FEATURE_GMAIL",
  gmailByo: "FEATURE_GMAIL_BYO",
  apiTokens: "FEATURE_API_TOKENS",
  ai: "FEATURE_AI",
  multiCurrency: "FEATURE_MULTI_CURRENCY",
} as const;

export type FeatureName = keyof typeof FEATURE_ENV;
export type Features = Record<FeatureName, boolean>;
export const FEATURE_NAMES = Object.keys(FEATURE_ENV) as FeatureName[];

export const PLANS = ["selfhost", "solo", "household", "power"] as const;
export type Plan = (typeof PLANS)[number];

export interface Limits {
  /** Members who may be in the household at once; null is no limit. */
  maxMembers: number | null;
  /**
   * How far back a backup can be restored from, in days. Null keeps the
   * self-hosted behaviour: the newest 14 backups, whatever their age.
   */
  backupRetentionDays: number | null;
}

export interface PlanPreset {
  features: Features;
  limits: Limits;
}

/** Everything a self-hosted install has always had: every module but multi-currency (Q18). */
const EVERYTHING: Features = {
  loans: true, familyLoans: true, assets: true, deposits: true, insurance: true,
  goals: true, tax: true, reports: true, schedules: true, rules: true,
  attachments: true, importCsv: true, importPdf: true, importBudgetApp: true,
  gmail: true, gmailByo: true, apiTokens: true, ai: true, multiCurrency: false,
};

/*
 * The hosted tiers, as website/pricing.html and website/privacy.html state them.
 * `gmail` is the deployment's own Google client (GOOGLE_CLIENT_ID) reading a
 * mailbox, and is off on every hosted tier: the hosted service never asks
 * Google for mailbox access under its own name. `gmailByo` is a member or the
 * household bringing their own Google Cloud OAuth client, and is on in every
 * preset (Febin, 08-11-2026): the consent is then to the household's own
 * application, and the hosted service only runs it. Solo is the budgeting engine for one person:
 * no loans (family lending included), no investments or net worth (FIRE is
 * built on net worth), no API tokens, and no AI connections (Febin, 07-11-2026).
 */
export const PLAN_PRESETS: Record<Plan, PlanPreset> = {
  selfhost: {
    features: EVERYTHING,
    limits: { maxMembers: null, backupRetentionDays: null },
  },
  solo: {
    features: {
      ...EVERYTHING,
      loans: false, familyLoans: false, assets: false, apiTokens: false, ai: false, gmail: false,
    },
    limits: { maxMembers: 1, backupRetentionDays: 30 },
  },
  household: {
    features: { ...EVERYTHING, gmail: false },
    limits: { maxMembers: 5, backupRetentionDays: 90 },
  },
  power: {
    features: { ...EVERYTHING, gmail: false },
    // Febin, 07-11-2026: Power has no member limit.
    limits: { maxMembers: null, backupRetentionDays: 365 },
  },
};

export const ALL_FEATURES_ON: Features = Object.fromEntries(
  FEATURE_NAMES.map((name) => [name, true]),
) as Features;

export const ALL_FEATURES_OFF: Features = Object.fromEntries(
  FEATURE_NAMES.map((name) => [name, false]),
) as Features;

/** Any of the three ways in to the import page. */
export function anyImport(features: Features): boolean {
  return features.importCsv || features.importPdf || features.importBudgetApp;
}

/*
 * The route table. Each entry names the module a path belongs to, matched on
 * whole segments so `/goalsx` is not `/goals`. A path in no entry is core and
 * always served. Checked once, ahead of every handler, so a route added to a
 * module later is gated by being under its prefix rather than by remembering
 * to call a guard.
 */
type Rule = { test: (segments: string[]) => boolean; available: (f: Features) => boolean };

const under = (...prefix: string[]) => (s: string[]) =>
  prefix.every((p, i) => p === ":id" ? s[i] !== undefined : s[i] === p);

const RULES: Rule[] = [
  { test: under("loans"), available: (f) => f.loans },
  { test: under("family"), available: (f) => f.familyLoans },
  { test: under("portfolio"), available: (f) => f.assets },
  { test: under("net-worth"), available: (f) => f.assets },
  { test: under("net-worth.csv"), available: (f) => f.assets },
  { test: under("fire"), available: (f) => f.assets },
  { test: under("accounts", ":id", "deposit"), available: (f) => f.deposits },
  { test: under("insurance"), available: (f) => f.insurance },
  { test: under("goals"), available: (f) => f.goals },
  { test: under("tax"), available: (f) => f.tax },
  { test: under("reports"), available: (f) => f.reports },
  { test: under("query"), available: (f) => f.reports },
  { test: under("query.csv"), available: (f) => f.reports },
  { test: under("schedules"), available: (f) => f.schedules },
  { test: under("rules"), available: (f) => f.rules },
  { test: under("attachment"), available: (f) => f.attachments },
  { test: under("transaction", ":id", "attach"), available: (f) => f.attachments },
  // A card purchase converted to EMI becomes a loan with its own schedule.
  { test: under("transaction", ":id", "convert-to-emi"), available: (f) => f.loans },
  { test: under("import", "pdf"), available: (f) => f.importPdf },
  { test: under("import", "budget-app"), available: (f) => f.importBudgetApp },
  // A PDF with no known layout goes to the same column-mapping step as a CSV.
  { test: under("import", "map"), available: (f) => f.importCsv || f.importPdf },
  { test: under("import"), available: anyImport },
  // Either way of connecting a mailbox opens the Gmail pages; which keys a
  // connection may use is decided in gmail/clients.ts.
  { test: under("gmail"), available: (f) => f.gmail || f.gmailByo },
  // AI-7 · Connect an AI lives under /tokens but is its own module: an AI
  // connection is offered without hand-minted tokens, and vice versa.
  { test: under("tokens", "ai"), available: (f) => f.ai },
  { test: under("tokens"), available: (f) => f.apiTokens },
  { test: under("mcp"), available: (f) => f.ai },
  { test: under("oauth"), available: (f) => f.ai },
  { test: under(".well-known", "oauth-protected-resource"), available: (f) => f.ai },
  { test: under(".well-known", "oauth-authorization-server"), available: (f) => f.ai },
  { test: under("export", "analysis.json"), available: (f) => f.ai },
];

/** Is this path served under these features? Core paths always are. */
export function pathAvailable(path: string, features: Features): boolean {
  const segments = path.split(/[?#]/)[0]!.split("/").filter((s) => s.length > 0);
  // The first rule that claims the path decides: specific entries sit above
  // the bare prefix they refine (`/import/pdf` above `/import`).
  const rule = RULES.find((r) => r.test(segments));
  return rule ? rule.available(features) : true;
}
