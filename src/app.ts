/**
 * Route table and middleware.
 *
 * Two things are enforced here for every request rather than in each handler,
 * because "we forgot one" is exactly how both of them fail:
 *
 * - authentication and the allow-list (R38.16)
 * - an idempotency key on every mutation (R36.1, N20)
 */

import type { DB } from "./db/db.ts";
import { queryAll, queryOne, execute, newId } from "./db/db.ts";
import { devLoginModulePresent, type Config } from "./config.ts";
import {
  Router, field, fieldList, fileField, requiredField, HttpError, NotFound,
  type RequestContext, type Response,
} from "./http/router.ts";
import { clientIp, wantsJson } from "./http/server.ts";
import { html, raw, when } from "./http/html.ts";
import { page, MANIFEST, type Theme } from "./web/layout.ts";
import { STYLESHEET } from "./web/styles.ts";
import { CLIENT_SCRIPT } from "./web/client.ts";
import { APP_ICON_SVG } from "./web/icon.ts";
import {
  authenticate, parseCookies, sessionCookie, clearedSessionCookie, SESSION_COOKIE,
  actorFor, setTheme, listMembers, memberCount, inviteMember, createSession,
  startImpersonation, stopImpersonation, setImpersonationWrites, listSessions,
  revokeSession, recordAuthAttempt, isRateLimited, findMemberByEmail,
  type AuthContext,
} from "./auth/sessions.ts";
import { beginOAuth, exchangeCode } from "./auth/google.ts";
import { withIdempotency, IdempotencyConflict } from "./core/idempotency.ts";
import { parseAmount, evaluateAmountExpression, formatPaise } from "./core/money.ts";
import { parseDate, todayIST, nowIST, addDays, addMonths, monthOf, isMonthKey, formatMonth, type MonthKey } from "./core/dates.ts";
import { buildBudgetView, reviewCount } from "./web/viewmodel.ts";
import { renderBudget } from "./web/pages/budget.ts";
import {
  renderAccountList, renderAccountDetail, renderNewAccountForm, type AccountRow, type RegisterRow,
} from "./web/pages/accounts.ts";
import {
  renderAddTransaction, renderMoveMoney, renderAutoAssignPreview, renderHold,
  renderExplain, explainLineFor, renderNotFound,
} from "./web/pages/actions.ts";
import { renderReview, renderImport, renderMapping } from "./web/pages/review.ts";
import {
  recognise, saveProfile, listProfiles, markProfileUsed, deleteProfile,
  mappingFromSelections, validateMapping, columnChoices, candidateHeaderRows,
  parseWith,
} from "./import/profiles.ts";
import {
  proposeCategoryRules, proposePayeeRule, previewRetroactive, applyRetroactive,
  suppress, learningEnabled, setLearningEnabled,
} from "./import/learning.ts";
import {
  renderReconcileStart, renderReconcileDifference, renderReconcileDone,
  renderCheckpointConfirmation,
} from "./web/pages/reconcile.ts";
import {
  reconcile, reconciliationStatus, listCheckpoints, clearedBalanceAsOf,
  guardHistoricalEdit, breakCheckpoints, CheckpointConfirmationRequired,
} from "./domain/reconciliation.ts";
import { parseStatement } from "./import/csv.ts";
import {
  ingest, listStaged, approveStaged, rejectStaged, mergeStaged, undoBatch, listBatches,
} from "./import/pipeline.ts";
import {
  createAccount, listAccounts, getAccount, listCards, paymentCategoryFor,
  type AccountKind,
} from "./domain/accounts.ts";
import {
  setAssigned, moveMoney, setHeld, getHeld, listCategories, getCategory,
} from "./domain/budget.ts";
import {
  createTransaction, createTransfer, updateTransaction, deleteTransaction,
  getTransaction, getSplits, listPayees, payeeStats, tagsFor,
} from "./domain/transactions.ts";
import {
  accountBalances, creditOutstanding, loadAutoAssignRules, loadEngineInput,
  householdSettings,
} from "./engine/repository.ts";
import { computeBudget, planAutoAssign, suggestCoverSources, cardFunding } from "./engine/engine.ts";
import { historyFor, queryEvents, appendEvent } from "./core/events.ts";
import {
  withForwardRecompute, setOverspendModel, type RecomputeResult,
} from "./engine/recompute.ts";
import {
  renderHealth, overallState, type HealthGroup,
} from "./web/pages/health.ts";
import {
  createBackup, verifyRestore, listBackups, lastJobRun, recordJobRun,
  exportEverything, exportTransactionsCsv, pingHeartbeat,
} from "./ops/backup.ts";
import {
  renderLoanList, renderLoanDetail, renderNewLoanForm, renderRecordInstalment,
  renderPrepaymentComparison,
} from "./web/pages/loans.ts";
import {
  createLoan, listLoans, getLoan, projectLoan, recordInstalment, listPayments,
  listDisbursements, listRatePeriods, debtOverview, type LoanType,
} from "./domain/loans.ts";
import { comparePrepayment, NegativeAmortisation } from "./loans/amortisation.ts";
import {
  renderQuery, renderReports, renderSchedules, renderGoals,
} from "./web/pages/analysis.ts";
import {
  queryTransactions, groupTotals, periodPresets, periodFor, incomeVsExpense,
  loanInterestByFinancialYear, rowsToCsv, type GroupBy, type TransactionFilter,
} from "./domain/reports.ts";
import {
  listSchedules, createSchedule, markPaid, skipOccurrence, detectSchedules,
  projectCashflow, describeCashflow, subscriptions, type Recurrence,
} from "./domain/schedules.ts";
import { listGoals, createGoal, goalProgress, completeGoal } from "./domain/goals.ts";
import {
  renderMore, renderPayees, renderRules, renderCategories, renderFirstRun,
  type PayeeRow, type RuleRow,
} from "./web/pages/manage.ts";
import { loadRules } from "./import/pipeline.ts";
import { testRule, type Rule, type RuleSubject, extractNarrationFields } from "./import/rules.ts";
import {
  applyStartingTemplate, startBlank,
} from "./domain/starting-budget.ts";
import {
  mergePayees, getPayee, resolvePayee,
} from "./domain/transactions.ts";
import {
  createCategory, renameCategory, setCategoryHidden, listGroups,
} from "./domain/budget.ts";
import {
  monthCloseView, closeMonth, reopenMonth, closedMonths, monthAwaitingClose, isClosed,
} from "./domain/month-close.ts";
import {
  digestFor, mutedKinds, setMutedKinds, DIGEST_KINDS, type DigestKind,
} from "./domain/digest.ts";
import {
  renderMonthClose, renderClosedMonths, renderDigest, renderDigestSettings,
} from "./web/pages/month-close.ts";
import {
  renderPortfolio, renderHoldingDetail, renderSalePreview, renderNetWorth,
  renderAddHolding, renderCasUpload, renderCasReview,
  type PortfolioRow, type CasReviewScheme,
} from "./web/pages/portfolio.ts";
import { parseCasPdf, WrongPassword } from "./import/cas.ts";
import {
  planCasImport, applyCasPlan, casDestinations, stashPlan, takePlan,
} from "./import/cas-plan.ts";
import {
  createAssetAccount, listAssetAccounts, findOrCreateInstrument, recordPurchase,
  recordSale, recordPrice, latestValuation, listHoldings, viewHolding,
  priceHistory, previewHoldingSale, getInstrument, listInstruments,
  type InstrumentKind,
} from "./domain/assets.ts";
import {
  netWorthStatement, snapshotNetWorth, netWorthChange, netWorthHistory,
} from "./domain/networth.ts";
import {
  units as toUnits, price as toUnitPrice, xirr, formatUnits,
} from "./portfolio/holdings.ts";
import { mfapi, searchSchemes, fetchFxRate } from "./portfolio/providers.ts";

export interface AppDeps {
  db: DB;
  config: Config;
  /** Injected so tests can drive the OAuth exchange without a network call. */
  fetchImpl?: typeof fetch;
}

const PUBLIC_PATHS = new Set(["/signin", "/auth/google", "/auth/google/callback", "/auth/dev", "/healthz"]);
const STATIC_PREFIX = "/assets/";

export function buildApp(deps: AppDeps): { router: Router; middleware: ((ctx: RequestContext) => Response | void)[] } {
  const { db, config } = deps;
  const router = new Router();

  // -------------------------------------------------------------------------
  // Middleware
  // -------------------------------------------------------------------------
  const middleware = [
    function staticAssets(ctx: RequestContext): Response | void {
      const path = ctx.url.pathname;
      if (path === "/assets/app.css") {
        return asset(STYLESHEET, "text/css");
      }
      if (path === "/assets/app.js") {
        return asset(CLIENT_SCRIPT, "text/javascript");
      }
      if (path === "/assets/icon.svg") {
        return asset(APP_ICON_SVG, "image/svg+xml");
      }
      if (path === "/manifest.webmanifest") {
        return asset(MANIFEST, "application/manifest+json");
      }
      if (path.startsWith(STATIC_PREFIX)) throw new NotFound();
    },

    function authenticateRequest(ctx: RequestContext): Response | void {
      const path = ctx.url.pathname;
      const cookies = parseCookies(ctx.req.headers.cookie);
      const auth = authenticate(db, cookies[SESSION_COOKIE] ?? null);
      ctx.locals.auth = auth;

      if (PUBLIC_PATHS.has(path)) return;
      if (!auth) {
        if (wantsJson(ctx)) return { status: 401, json: { error: "Your session has expired." } };
        return { redirect: `/signin?next=${encodeURIComponent(path)}` };
      }

      // R38.10: impersonation is read-only unless the toggle was set. The
      // check lives here so no handler can be the one that forgets it.
      if (ctx.method !== "GET" && !auth.canWrite && path !== "/impersonate/exit") {
        throw new HttpError(
          403,
          `You're viewing as ${auth.viewingAs.name} in read-only mode. Enable writes first, or exit.`,
        );
      }
    },
  ];

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------
  function auth(ctx: RequestContext): AuthContext {
    const value = ctx.locals.auth as AuthContext | null;
    if (!value) throw new HttpError(401, "Please sign in.");
    return value;
  }

  function render(ctx: RequestContext, title: string, content: ReturnType<typeof html>, opts: { bare?: boolean; notice?: Parameters<typeof page>[0]["notice"] } = {}): Response {
    const a = ctx.locals.auth as AuthContext | null;
    return {
      body: page(
        {
          title,
          theme: (a?.viewingAs.theme ?? "system") as Theme,
          memberName: a?.member.name ?? null,
          impersonating: a?.impersonating
            ? { name: a.viewingAs.name, readOnly: !a.canWrite }
            : null,
          devMode: config.devLogin,
          path: ctx.url.pathname,
          reviewCount: a ? reviewCount(db) : 0,
          notice: opts.notice ?? noticeFrom(ctx),
          bare: opts.bare,
          features: { loans: config.features.loans, assets: config.features.assets },
        },
        content,
      ),
    };
  }

  function noticeFrom(ctx: RequestContext): Parameters<typeof page>[0]["notice"] {
    const message = ctx.query.get("notice");
    if (!message) return null;
    const kind = (ctx.query.get("kind") ?? "success") as "error" | "success" | "info" | "warning";
    return { kind, message };
  }

  /**
   * R36.1: every mutation runs through this. The key comes from the client;
   * a request without one still works (a plain form post from a browser with
   * no JavaScript), it simply is not replay-protected.
   */
  function mutate<T>(
    ctx: RequestContext,
    fn: (a: AuthContext) => { redirect?: string; message?: string; body?: T },
  ): Response {
    const a = auth(ctx);
    const key = (ctx.req.headers["idempotency-key"] as string | undefined) ?? null;

    try {
      const outcome = withIdempotency(
        db,
        {
          key,
          memberId: a.member.id,
          method: ctx.method,
          path: ctx.url.pathname,
          payload: ctx.body,
        },
        () => ({ statusCode: 200, body: fn(a) }),
      );

      const result = outcome.body as { redirect?: string; message?: string };
      if (wantsJson(ctx)) {
        return { json: { redirect: result.redirect, message: result.message ?? "Saved." } };
      }
      return { redirect: withNotice(result.redirect ?? ctx.url.pathname, result.message) };
    } catch (err) {
      if (err instanceof IdempotencyConflict) {
        throw new HttpError(err.statusCode, err.message);
      }
      throw err;
    }
  }

  function withNotice(path: string, message?: string): string {
    if (!message) return path;
    const separator = path.includes("?") ? "&" : "?";
    return `${path}${separator}notice=${encodeURIComponent(message)}`;
  }

  function monthParam(ctx: RequestContext): MonthKey {
    const value = ctx.query.get("month") ?? field(ctx.body, "month");
    return value && isMonthKey(value) ? value : monthOf(todayIST());
  }

  /** Amount fields accept an expression (F4.10) before falling back to a plain parse. */
  function amountField(raw: string | undefined, name = "Amount"): number {
    if (raw === undefined || raw.trim() === "") {
      throw new HttpError(400, `${name} is required.`);
    }
    const value = evaluateAmountExpression(raw) ?? parseAmount(raw);
    if (value === null) throw new HttpError(400, `"${raw}" isn't an amount I can read.`);
    return value;
  }

  function memberName(id: string | null): string {
    if (!id) return "the app";
    return listMembers(db, { includeRemoved: true }).find((m) => m.id === id)?.name ?? "a former member";
  }

  // -------------------------------------------------------------------------
  // Sign in
  // -------------------------------------------------------------------------
  const pendingOAuth = new Map<string, { verifier: string; next: string; at: number }>();

  router.get("/signin", async (ctx) => {
    if (ctx.locals.auth) return { redirect: "/" };

    let devForm = raw("");
    if (config.devLogin) {
      // R38.5: imported dynamically, so a production image can delete the file.
      const module = await import("./auth/dev-login.ts").catch(() => null);
      if (module) devForm = module.renderDevLoginForm(module.developmentMembers(db));
    }

    const googleConfigured = Boolean(config.google.clientId && config.google.clientSecret);
    const next = ctx.query.get("next") ?? "/";

    return render(
      ctx,
      "Sign in",
      html`
        <div style="max-width:26rem;margin:3rem auto">
          <h1>Budget</h1>
          <p class="muted">Envelope budgeting for your household.</p>
          ${googleConfigured
            ? html`
                <div class="card">
                  <a class="button button-primary" style="width:100%"
                     href="/auth/google?next=${encodeURIComponent(next)}">
                    Continue with Google
                  </a>
                  <p class="field-hint" style="margin-top:.75rem">
                    Only household members on the allow-list can sign in.
                  </p>
                </div>
              `
            : html`
                <p class="notice notice-warning">
                  Google sign-in isn't configured. Set GOOGLE_CLIENT_ID and
                  GOOGLE_CLIENT_SECRET to enable it.
                </p>
              `}
          ${devForm}
        </div>
      `,
      { bare: true },
    );
  });

  router.get("/auth/google", (ctx) => {
    if (!config.google.clientId) throw new HttpError(500, "Google sign-in is not configured.");
    const redirectUri = `${config.baseUrl}/auth/google/callback`;
    const start = beginOAuth({ clientId: config.google.clientId, redirectUri });

    // Held in memory only, and briefly — R35 forbids putting it on the device,
    // and it has no value after the callback.
    pendingOAuth.set(start.state, {
      verifier: start.codeVerifier,
      next: ctx.query.get("next") ?? "/",
      at: Date.now(),
    });
    for (const [key, value] of pendingOAuth) {
      if (Date.now() - value.at > 10 * 60_000) pendingOAuth.delete(key);
    }

    return { redirect: start.url };
  });

  router.get("/auth/google/callback", async (ctx) => {
    const source = clientIp(ctx, config.trustProxy);
    if (isRateLimited(db, source)) {
      throw new HttpError(429, "Too many sign-in attempts. Try again in a few minutes.");
    }

    const state = ctx.query.get("state") ?? "";
    const pending = pendingOAuth.get(state);
    pendingOAuth.delete(state);
    if (!pending) {
      recordAuthAttempt(db, source, "bad-state");
      throw new HttpError(400, "That sign-in link has expired. Please try again.");
    }

    const code = ctx.query.get("code");
    if (!code) {
      recordAuthAttempt(db, source, "no-code");
      throw new HttpError(400, "Google did not return a sign-in code.");
    }

    const profile = await exchangeCode({
      clientId: config.google.clientId!,
      clientSecret: config.google.clientSecret!,
      redirectUri: `${config.baseUrl}/auth/google/callback`,
      code,
      codeVerifier: pending.verifier,
      fetchImpl: deps.fetchImpl,
    });

    let member = findMemberByEmail(db, profile.email);

    // F1.3: the first person to sign in on a fresh instance becomes a member,
    // and is prompted to add the others.
    if (!member && memberCount(db) === 0) {
      member = inviteMember(db, { memberId: null, source: "system" }, {
        email: profile.email,
        name: profile.name,
      });
    }

    if (!member || member.removed_at || !member.allowed) {
      recordAuthAttempt(db, source, "not-allowed", profile.email);
      throw new HttpError(403, "That account isn't on this household's allow-list.");
    }

    db.prepare(`UPDATE members SET google_sub = ?, avatar_url = ?, name = COALESCE(NULLIF(name,''), ?) WHERE id = ?`)
      .run(profile.sub, profile.picture, profile.name, member.id);

    const { token } = createSession(db, member.id, {
      userAgent: ctx.req.headers["user-agent"] ?? null,
      ipHint: source,
      days: config.sessionDays,
    });
    recordAuthAttempt(db, source, "success", profile.email);

    return {
      redirect: pending.next,
      headers: { "Set-Cookie": sessionCookie(token, { secure: config.baseUrl.startsWith("https"), days: config.sessionDays }) },
    };
  });

  router.post("/auth/dev", async (ctx) => {
    if (!config.devLogin) throw new NotFound();
    const module = await import("./auth/dev-login.ts").catch(() => null);
    if (!module) throw new NotFound();

    const { token } = module.signInAsDevelopmentMember(db, requiredField(ctx.body, "member_id"), {
      userAgent: ctx.req.headers["user-agent"] ?? null,
      ipHint: clientIp(ctx, config.trustProxy),
      days: config.sessionDays,
    });

    return {
      redirect: "/",
      headers: { "Set-Cookie": sessionCookie(token, { secure: false, days: config.sessionDays }) },
    };
  });

  router.post("/signout", (ctx) => {
    const a = auth(ctx);
    revokeSession(db, actorFor(a), a.session.id);
    return {
      redirect: "/signin",
      headers: { "Set-Cookie": clearedSessionCookie(config.baseUrl.startsWith("https")) },
    };
  });

  // -------------------------------------------------------------------------
  // S1 · Budget
  // -------------------------------------------------------------------------
  router.get("/", (ctx) => {
    const a = auth(ctx);
    const month = monthParam(ctx);
    const view = buildBudgetView(db, month);

    // The digest belongs to the person reading, not to the month being read,
    // so it only shows on the current month.
    const digest = month === view.currentMonth
      ? renderDigest(digestFor(db, a.viewingAs.id))
      : undefined;

    return render(ctx, formatMonth(month), renderBudget(view, digest));
  });

  router.post("/assign", (ctx) =>
    mutate(ctx, (a) => {
      const month = monthParam(ctx);
      const categoryId = requiredField(ctx.body, "category_id");
      const rawAmount = field(ctx.body, "amount") ?? "";
      const amount = rawAmount.trim() === "" ? 0 : amountField(rawAmount);

      const category = getCategory(db, categoryId);
      const actor = actorFor(a, "ui", ctx.req.headers["idempotency-key"] as string);

      // R7.g: an assignment in a past month changes every derived figure from
      // there to now. Nothing is stored, so the figures are already right —
      // this logs the ripple so it can be explained.
      const { recompute } = withForwardRecompute(
        db, actor,
        { month, cause: `Changed what ${category?.name ?? "a category"} was assigned` },
        () => setAssigned(db, actor, month, categoryId, amount),
      );

      return {
        redirect: `/?month=${month}`,
        message:
          `Assigned ${formatPaise(amount)} to ${category?.name ?? "that category"}.` +
          rippleNote(recompute),
      };
    }),
  );

  router.get("/move", (ctx) => {
    const month = monthParam(ctx);
    const view = buildBudgetView(db, month);
    const to = ctx.query.get("to");
    const amountParam = ctx.query.get("amount");

    const suggestions = to
      ? suggestCoverSources(to, view.monthState.categories, {
          categoryNames: new Map([...view.categories].map(([id, c]) => [id, c.name])),
          metTargets: new Set(
            [...view.categories.values()].filter((c) => c.progress?.underfunded === 0).map((c) => c.id),
          ),
        })
      : [];

    return render(
      ctx,
      "Move money",
      renderMoveMoney({
        month,
        categories: [...view.categories.values()].filter((c) => !c.hidden),
        toCategoryId: to,
        amount: amountParam ? Number(amountParam) : null,
        suggestions,
      }),
    );
  });

  router.post("/move", (ctx) =>
    mutate(ctx, (a) => {
      const month = monthParam(ctx);
      const actor = actorFor(a, "ui", ctx.req.headers["idempotency-key"] as string);
      const { recompute } = withForwardRecompute(
        db, actor, { month, cause: "Moved money between categories" },
        () =>
          moveMoney(db, actor, {
            month,
            fromCategoryId: requiredField(ctx.body, "from_category_id"),
            toCategoryId: requiredField(ctx.body, "to_category_id"),
            amount: amountField(field(ctx.body, "amount")),
          }),
      );
      return { redirect: `/?month=${month}`, message: "Money moved." + rippleNote(recompute) };
    }),
  );

  router.get("/hold", (ctx) => {
    const month = monthParam(ctx);
    const view = buildBudgetView(db, month);
    return render(
      ctx,
      "Hold for next month",
      renderHold({
        month,
        currentlyHeld: getHeld(db, month),
        readyToAssign: view.monthState.readyToAssign,
      }),
    );
  });

  router.post("/hold", (ctx) =>
    mutate(ctx, (a) => {
      const month = monthParam(ctx);
      const rawAmount = field(ctx.body, "amount") ?? "";
      const amount = rawAmount.trim() === "" ? 0 : amountField(rawAmount);
      setHeld(db, actorFor(a, "ui", ctx.req.headers["idempotency-key"] as string), month, amount);
      return {
        redirect: `/?month=${month}`,
        message: amount === 0 ? "Released the held money." : `Held ${formatPaise(amount)} for next month.`,
      };
    }),
  );

  router.get("/auto-assign", (ctx) => {
    const month = monthParam(ctx);
    const plan = buildAutoAssignPlan(month);
    const view = buildBudgetView(db, month);
    return render(
      ctx,
      "Auto-assign",
      renderAutoAssignPreview({
        month,
        plan,
        categoryNames: new Map([...view.categories].map(([id, c]) => [id, c.name])),
      }),
    );
  });

  router.post("/auto-assign", (ctx) =>
    mutate(ctx, (a) => {
      const month = monthParam(ctx);
      const plan = buildAutoAssignPlan(month);
      const actor = actorFor(a, "ui", ctx.req.headers["idempotency-key"] as string);
      for (const proposal of plan.proposals) {
        setAssigned(db, actor, month, proposal.categoryId, proposal.to);
      }
      return {
        redirect: `/?month=${month}`,
        message: `Assigned ${formatPaise(plan.totalAssigned)} across ${plan.proposals.length} categories.`,
      };
    }),
  );

  function buildAutoAssignPlan(month: MonthKey) {
    const input = loadEngineInput(db, { through: month });
    const budget = computeBudget(input);
    const state = budget.get(month)!;
    return planAutoAssign(loadAutoAssignRules(db), {
      month,
      readyToAssign: state.readyToAssign,
      states: state.categories,
      categories: input.categories,
      incomeThisMonth: state.rtaBreakdown.incomeToDate,
      historicalAssigned: new Map(input.months.map((m) => [m, input.facts[m]?.assigned ?? {}])),
      today: todayIST(),
    });
  }

  // -------------------------------------------------------------------------
  // F25.10 · Explain this number
  // -------------------------------------------------------------------------
  router.get("/explain/ready-to-assign", (ctx) => {
    const month = monthParam(ctx);
    const view = buildBudgetView(db, month);
    const b = view.monthState.rtaBreakdown;

    const lines = [
      { when: "", who: "", what: `Income received up to ${formatMonth(month)}: ${formatPaise(b.incomeToDate)}` },
      { when: "", who: "", what: `Less assigned this month and earlier: ${formatPaise(-b.assignedThisMonthAndEarlier)}` },
      { when: "", who: "", what: `Less assigned in future months: ${formatPaise(-b.assignedInFutureMonths)}` },
      { when: "", who: "", what: `Less held for next month: ${formatPaise(-b.heldForNextMonth)}` },
      { when: "", who: "", what: `Less cash overspending carried in: ${formatPaise(-b.cashOverspendCarried)}` },
    ];

    return {
      body: renderExplain({
        title: "Ready to Assign",
        figure: b.total,
        summary: `Every rupee in a budget account that hasn't been given a job yet.`,
        lines,
      }),
    };
  });

  router.get("/explain/category/:id", (ctx) => {
    const month = monthParam(ctx);
    const view = buildBudgetView(db, month);
    const category = view.categories.get(ctx.params.id!);
    if (!category) throw new NotFound();

    // J22: three events, three actors, one answer.
    const events = [
      ...historyFor(db, "assignment", `${month}:${category.id}`),
      ...queryEvents(db, { entity: "transaction", limit: 40, descending: false }).filter((e) => {
        const after = e.after as { category_id?: string; date?: string } | undefined;
        return after?.category_id === category.id && after?.date?.startsWith(month);
      }),
    ].sort((a, b) => a.seq - b.seq);

    return {
      body: renderExplain({
        title: category.name,
        figure: category.state.balance,
        summary:
          `Opened at ${formatPaise(category.state.opening)}, ` +
          `${formatPaise(category.state.assigned)} assigned, ` +
          `${formatPaise(-category.state.activity)} spent.`,
        lines: events.map((e) => explainLineFor(e, memberName)),
      }),
    };
  });

  // -------------------------------------------------------------------------
  // S2 · Accounts
  // -------------------------------------------------------------------------
  router.get("/accounts", (ctx) => {
    const balances = accountBalances(db);
    const outstanding = creditOutstanding(db);
    const view = buildBudgetView(db);

    const rows: AccountRow[] = listAccounts(db).map((account) => {
      const recon = queryOne<{ as_of: string; broken_at: string | null }>(
        db,
        `SELECT as_of, broken_at FROM reconciliations WHERE account_id = ? ORDER BY as_of DESC LIMIT 1`,
        account.id,
      );
      const paymentCategory = account.kind === "credit" ? paymentCategoryFor(db, account.id) : null;
      const funded = paymentCategory ? view.categories.get(paymentCategory.id)?.state.balance ?? 0 : 0;

      return {
        account,
        balances: balances.get(account.id)!,
        unclearedCount:
          queryOne<{ n: number }>(
            db,
            `SELECT COUNT(*) AS n FROM transactions WHERE account_id = ? AND cleared = 0 AND deleted_at IS NULL`,
            account.id,
          )?.n ?? 0,
        lastReconciled: recon?.as_of ?? null,
        checkpointBroken: Boolean(recon?.broken_at),
        funding:
          account.kind === "credit"
            ? cardFunding(
                account.id,
                outstanding.get(account.id) ?? 0,
                funded,
                view.monthState.unfundedByAccount[account.id] ?? 0,
              )
            : null,
      };
    });

    return render(ctx, "Accounts", renderAccountList(rows));
  });

  router.get("/accounts/new", (ctx) => render(ctx, "Add an account", renderNewAccountForm()));

  router.post("/accounts/new", (ctx) =>
    mutate(ctx, (a) => {
      const openingRaw = field(ctx.body, "opening_balance");
      const openingDateRaw = field(ctx.body, "opening_date");
      const kind = requiredField(ctx.body, "kind") as AccountKind;
      let opening = openingRaw?.trim() ? amountField(openingRaw, "Current balance") : 0;

      // F2.6: a credit card's balance is what you owe. Entering it as a
      // positive figure is the obvious slip, so take it as intended rather
      // than rejecting it.
      if (kind === "credit" && opening > 0) opening = -opening;

      const account = createAccount(db, actorFor(a, "ui", ctx.req.headers["idempotency-key"] as string), {
        name: requiredField(ctx.body, "name"),
        kind,
        subtype: requiredField(ctx.body, "subtype"),
        institution: field(ctx.body, "institution") || null,
        last4: field(ctx.body, "last4") || null,
        openingBalance: opening,
        openingDate: openingDateRaw ? parseDate(openingDateRaw) ?? todayIST() : todayIST(),
        statementDay: numberOrNull(field(ctx.body, "statement_day")),
        dueDay: numberOrNull(field(ctx.body, "due_day")),
      });

      return { redirect: `/accounts/${account.id}`, message: `Added ${account.name}.` };
    }),
  );

  router.get("/accounts/:id", (ctx) => {
    const account = getAccount(db, ctx.params.id!);
    if (!account) throw new NotFound("That account does not exist.");

    const balances = accountBalances(db).get(account.id)!;
    const cardFilter = ctx.query.get("card");

    const raws = queryAll<{
      id: string; date: string; amount: number; cleared: number; memo: string | null;
      payee: string | null; category: string | null; transfer_pair_id: string | null;
      card_label: string | null; owner_name: string | null;
    }>(
      db,
      `SELECT t.id, t.date, t.amount, t.cleared, t.memo, t.transfer_pair_id,
              p.name AS payee, c.name AS category, cd.label AS card_label, m.name AS owner_name
         FROM transactions t
         LEFT JOIN payees p   ON p.id = t.payee_id
         LEFT JOIN categories c ON c.id = t.category_id
         LEFT JOIN cards cd   ON cd.id = t.card_id
         LEFT JOIN members m  ON m.id = t.owner_member_id
        WHERE t.account_id = ? AND t.deleted_at IS NULL
          ${cardFilter ? "AND t.card_id = ?" : ""}
        ORDER BY t.date DESC, t.created_at DESC
        LIMIT 300`,
      ...(cardFilter ? [account.id, cardFilter] : [account.id]),
    );

    // Running balance is computed from the oldest row forward, then reversed
    // back into newest-first display order.
    let running = balances.working;
    const rows: RegisterRow[] = raws.map((r) => {
      const row: RegisterRow = {
        id: r.id,
        date: r.date,
        payee: r.payee,
        category: r.category,
        memo: r.memo,
        tags: tagsFor(db, r.id),
        amount: r.amount,
        cleared: r.cleared === 1,
        isTransfer: r.transfer_pair_id !== null,
        cardLabel: r.card_label,
        ownerName: r.owner_name,
        runningBalance: running,
      };
      running -= r.amount;
      return row;
    });

    const paymentCategory = account.kind === "credit" ? paymentCategoryFor(db, account.id) : null;
    const view = paymentCategory ? buildBudgetView(db) : null;
    const funded = paymentCategory ? view?.categories.get(paymentCategory.id)?.state.balance ?? 0 : 0;

    const recon = queryOne<{ as_of: string; broken_at: string | null }>(
      db,
      `SELECT as_of, broken_at FROM reconciliations WHERE account_id = ? ORDER BY as_of DESC LIMIT 1`,
      account.id,
    );

    return render(
      ctx,
      account.nickname || account.name,
      renderAccountDetail({
        account,
        balances,
        rows,
        cards: listCards(db, account.id),
        funding:
          account.kind === "credit"
            ? cardFunding(
                account.id,
                balances.working,
                funded,
                view?.monthState.unfundedByAccount[account.id] ?? 0,
              )
            : null,
        paymentCategoryName: paymentCategory?.name ?? null,
        lastStatement: null,
        lastReconciled: recon?.as_of ?? null,
        checkpointBroken: Boolean(recon?.broken_at),
      }),
    );
  });

  // -------------------------------------------------------------------------
  // S3 · Add transaction
  // -------------------------------------------------------------------------
  router.get("/add", (ctx) => {
    const view = buildBudgetView(db);
    const accounts = listAccounts(db);
    const lastUsed = queryOne<{ account_id: string }>(
      db,
      `SELECT account_id FROM transactions WHERE deleted_at IS NULL ORDER BY created_at DESC LIMIT 1`,
    );

    return render(
      ctx,
      "Add a transaction",
      renderAddTransaction({
        accounts,
        categories: [...view.categories.values()],
        payees: listPayees(db).map((p) => {
          const stats = payeeStats(db, p.id);
          return {
            id: p.id,
            name: p.name,
            usualCategoryId: stats.usualCategoryId,
            lastAmount: stats.lastAmount,
            lastDate: stats.lastSeen,
          };
        }),
        defaultAccountId: ctx.query.get("account") ?? lastUsed?.account_id ?? accounts[0]?.id ?? null,
        today: todayIST(),
      }),
    );
  });

  router.post("/add", (ctx) =>
    mutate(ctx, (a) => {
      const magnitude = Math.abs(amountField(field(ctx.body, "amount")));
      const direction = field(ctx.body, "direction") ?? "out";
      const dateRaw = field(ctx.body, "date");
      const tags = (field(ctx.body, "tags") ?? "")
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);

      createTransaction(db, actorFor(a, "ui", ctx.req.headers["idempotency-key"] as string), {
        accountId: requiredField(ctx.body, "account_id"),
        amount: direction === "in" ? magnitude : -magnitude,
        date: dateRaw ? parseDate(dateRaw) ?? todayIST() : todayIST(),
        payeeName: field(ctx.body, "payee") || null,
        categoryId: field(ctx.body, "category_id") || null,
        memo: field(ctx.body, "memo") || null,
        tags,
        cleared: field(ctx.body, "cleared") === "1",
      });

      return { redirect: "/", message: `Saved ${formatPaise(magnitude)}.` };
    }),
  );

  router.post("/transfer", (ctx) =>
    mutate(ctx, (a) => {
      createTransfer(db, actorFor(a, "ui", ctx.req.headers["idempotency-key"] as string), {
        fromAccountId: requiredField(ctx.body, "from_account_id"),
        toAccountId: requiredField(ctx.body, "to_account_id"),
        amount: Math.abs(amountField(field(ctx.body, "amount"))),
        date: parseDate(field(ctx.body, "date") ?? "") ?? todayIST(),
      });
      return { redirect: "/accounts", message: "Transfer recorded." };
    }),
  );

  // -------------------------------------------------------------------------
  // Theme, impersonation and sessions
  // -------------------------------------------------------------------------
  router.post("/settings/theme", (ctx) =>
    mutate(ctx, (a) => {
      const theme = (field(ctx.body, "theme") ?? "system") as Theme;
      if (!["light", "dark", "system"].includes(theme)) throw new HttpError(400, "Unknown theme.");
      // Stored against the real member, not the impersonated one — a display
      // preference is the viewer's, not the person being viewed.
      setTheme(db, actorFor(a), a.member.id, theme);
      return { redirect: field(ctx.body, "return_to") || "/" };
    }),
  );

  router.post("/impersonate/start", (ctx) =>
    mutate(ctx, (a) => {
      startImpersonation(db, actorFor(a), a.session.id, requiredField(ctx.body, "member_id"));
      return { redirect: "/", message: "Now viewing as another member, read only." };
    }),
  );

  router.post("/impersonate/writes", (ctx) =>
    mutate(ctx, (a) => {
      setImpersonationWrites(db, actorFor(a), a.session.id, field(ctx.body, "allow") === "1");
      return { redirect: "/settings" };
    }),
  );

  router.post("/impersonate/exit", (ctx) => {
    const a = auth(ctx);
    stopImpersonation(db, actorFor(a), a.session.id);
    return { redirect: "/" };
  });

  router.post("/sessions/revoke", (ctx) =>
    mutate(ctx, (a) => {
      revokeSession(db, actorFor(a), requiredField(ctx.body, "session_id"));
      return { redirect: "/settings", message: "Signed that device out." };
    }),
  );

  router.get("/settings", (ctx) => {
    const a = auth(ctx);
    const members = listMembers(db);
    const sessions = listSessions(db, a.member.id);
    const overspendModel = householdSettings(db)?.overspend_model ?? "reduce-rta";
    const learning = learningEnabled(db);

    return render(
      ctx,
      "Settings",
      html`
        <h1>Settings</h1>

        <section class="card">
          <h2>Appearance</h2>
          <form method="post" action="/settings/theme">
            <div class="field">
              <label for="theme">Theme</label>
              <select id="theme" name="theme">
                ${(["system", "light", "dark"] as Theme[]).map(
                  (t) => html`
                    <option value="${t}" ${raw(a.viewingAs.theme === t ? "selected" : "")}>
                      ${t === "system" ? "Follow system" : t === "light" ? "Light" : "Dark"}
                    </option>
                  `,
                )}
              </select>
            </div>
            <button type="submit">Save</button>
          </form>
        </section>

        ${renderDigestSettings(mutedKinds(db, a.viewingAs.id))}

        <section class="card">
          <h2>Suggestions from what you do</h2>
          <p class="faint" style="margin-top:-.25rem">
            When you categorise the same payee twice, or clean up an imported name,
            the app can offer a rule for it. Suggestions always wait in Review —
            nothing is ever applied to your ledger on its own.
          </p>
          <form method="post" action="/settings/learning">
            <div class="field">
              <label>
                <input type="checkbox" name="enabled" value="1" ${raw(learning ? "checked" : "")}>
                Suggest rules from what I've been doing
              </label>
              <p class="field-hint">
                Turning this off stops new suggestions. Rules you've already
                confirmed keep working.
              </p>
            </div>
            <button type="submit">Save</button>
          </form>
        </section>

        <section class="card">
          <h2>When a category is overspent</h2>
          <p class="faint" style="margin-top:-.25rem">
            Both work. They differ only in where the shortfall lands, and you can
            switch back at any time without losing anything.
          </p>
          <form method="post" action="/settings/overspend-model">
            <div class="field">
              <label>
                <input type="radio" name="model" value="reduce-rta"
                       ${raw(overspendModel === "reduce-rta" ? "checked" : "")}>
                Take it out of next month's Ready to Assign
              </label>
              <p class="field-hint">
                The category starts the next month at zero. Keeps the pain in the one
                place you actually look, and stops a category building up invisible
                debt over several months.
              </p>
            </div>
            <div class="field">
              <label>
                <input type="radio" name="model" value="carry-negative"
                       ${raw(overspendModel === "carry-negative" ? "checked" : "")}>
                Carry the negative balance on the category
              </label>
              <p class="field-hint">
                The category starts the next month in the red and Ready to Assign is
                untouched. More locally honest — the overspend stays attached to
                whatever caused it.
              </p>
            </div>
            <button type="submit">Save</button>
            <p class="field-hint">
              Changing this recomputes every month you have data for.
            </p>
          </form>
        </section>

        <section class="card">
          <h2>Household</h2>
          <p class="faint" style="margin-top:-.25rem">
            Everyone here can do everything. There is no owner and no approval step.
          </p>
          ${members.map(
            (m) => html`
              <div class="row-between" style="padding:.5rem 0;border-top:1px solid var(--border)">
                <div>
                  <strong>${m.name}</strong>
                  <div class="faint">${m.email}</div>
                </div>
                ${m.id === a.member.id
                  ? html`<span class="chip">You</span>`
                  : html`
                      <form method="post" action="/impersonate/start">
                        <input type="hidden" name="member_id" value="${m.id}">
                        <button class="button-small" type="submit">View as</button>
                      </form>
                    `}
              </div>
            `,
          )}
          <form method="post" action="/members/invite" style="margin-top:1rem">
            <div class="field">
              <label for="invite-email">Add a household member</label>
              <input id="invite-email" name="email" type="email" required
                     placeholder="partner@example.com">
              <p class="field-hint">They'll be able to sign in with that Google account.</p>
            </div>
            <button type="submit">Add to the allow-list</button>
          </form>
        </section>

        <section class="card">
          <h2>Your devices</h2>
          ${sessions.map(
            (s) => html`
              <div class="row-between" style="padding:.5rem 0;border-top:1px solid var(--border)">
                <div>
                  <div>${s.user_agent ?? "Unknown device"}</div>
                  <div class="faint">Last seen ${s.last_seen_at.slice(0, 10)}</div>
                </div>
                ${s.id === a.session.id
                  ? html`<span class="chip chip-positive">This device</span>`
                  : html`
                      <form method="post" action="/sessions/revoke">
                        <input type="hidden" name="session_id" value="${s.id}">
                        <button class="button-small" type="submit">Sign out</button>
                      </form>
                    `}
              </div>
            `,
          )}
        </section>

        <section class="card">
          <form method="post" action="/signout">
            <button class="button-danger" type="submit">Sign out of this device</button>
          </form>
        </section>
      `,
    );
  });

  /** L4 · Learning is disableable, globally. */
  router.post("/settings/learning", (ctx) =>
    mutate(ctx, (a) => {
      const enabled = field(ctx.body, "enabled") === "1";
      setLearningEnabled(db, actorFor(a), enabled);
      return {
        redirect: "/settings",
        message: enabled
          ? "The app will suggest rules again."
          : "Rule suggestions are off. Nothing you've already confirmed changes.",
      };
    }),
  );

  router.post("/settings/overspend-model", (ctx) =>
    mutate(ctx, (a) => {
      const model = field(ctx.body, "model");
      if (model !== "reduce-rta" && model !== "carry-negative") {
        throw new HttpError(400, "Unknown overspend model.");
      }
      // R7.g.4: this is a full-history recompute, logged as its own batch.
      const result = setOverspendModel(db, actorFor(a), model);
      return {
        redirect: "/settings",
        message:
          result.changed.length === 0
            ? "No change."
            : `Recomputed ${result.changed.length} ${result.changed.length === 1 ? "month" : "months"}.`,
      };
    }),
  );

  router.post("/members/invite", (ctx) =>
    mutate(ctx, (a) => {
      const member = inviteMember(db, actorFor(a), { email: requiredField(ctx.body, "email") });
      return { redirect: "/settings", message: `${member.email} can now sign in.` };
    }),
  );

  // -------------------------------------------------------------------------
  // Transaction detail and edit — where R7.b's confirmation actually fires
  // -------------------------------------------------------------------------
  router.get("/transaction/:id", (ctx) => {
    const transaction = getTransaction(db, ctx.params.id!);
    if (!transaction) throw new NotFound("That transaction does not exist.");

    const account = getAccount(db, transaction.account_id)!;
    const view = buildBudgetView(db, monthOf(transaction.date));
    // F4.9 / F25.12: the raw imported values and the full event history.
    const history = historyFor(db, "transaction", transaction.id);
    const rules = queryAll<{ name: string }>(
      db,
      `SELECT r.name FROM rule_applications ra JOIN rules r ON r.id = ra.rule_id
        WHERE ra.transaction_id = ?`,
      transaction.id,
    );

    return render(
      ctx,
      "Transaction",
      html`
        <h1>${formatPaise(Math.abs(transaction.amount))}</h1>
        <p class="muted">${account.nickname || account.name} · ${transaction.date}</p>

        <form method="post" action="/transaction/${transaction.id}" class="card">
          <div class="grid-2">
            <div class="field">
              <label for="t-amount">Amount</label>
              <input id="t-amount" name="amount" class="amount-input" type="text" inputmode="decimal"
                     value="${(Math.abs(transaction.amount) / 100).toFixed(2)}">
            </div>
            <div class="field">
              <label for="t-direction">Direction</label>
              <select id="t-direction" name="direction">
                <option value="out" ${raw(transaction.amount < 0 ? "selected" : "")}>Money out</option>
                <option value="in" ${raw(transaction.amount >= 0 ? "selected" : "")}>Money in</option>
              </select>
            </div>
          </div>

          <div class="field">
            <label for="t-category">Category</label>
            <select id="t-category" name="category_id">
              <option value="">Uncategorised</option>
              ${[...view.categories.values()]
                .filter((c) => !c.isPaymentCategory && !c.hidden)
                .map(
                  (c) => html`
                    <option value="${c.id}" ${raw(c.id === transaction.category_id ? "selected" : "")}>
                      ${c.name}
                    </option>
                  `,
                )}
            </select>
          </div>

          <div class="grid-2">
            <div class="field">
              <label for="t-date">Date</label>
              <input id="t-date" name="date" type="text" value="${formatDateOut(transaction.date)}">
            </div>
            <div class="field">
              <label for="t-memo">Memo</label>
              <input id="t-memo" name="memo" value="${transaction.memo ?? ""}">
            </div>
          </div>

          <div class="field">
            <label>
              <input type="checkbox" name="cleared" value="1"
                     ${raw(transaction.cleared ? "checked" : "")}> Cleared the bank
            </label>
          </div>

          <button class="button-primary" type="submit">Save</button>
          <button class="button-danger" type="submit" formaction="/transaction/${transaction.id}/delete">
            Delete
          </button>
        </form>

        <!-- P4 / N4: the original record is never overwritten, and is shown. -->
        ${when(transaction.raw_narration, () => html`
          <section class="card">
            <h2>As the bank sent it</h2>
            <p class="faint" style="word-break:break-all">${transaction.raw_narration}</p>
            ${when(transaction.raw_amount, () => html`
              <p class="faint">Amount as written: ${transaction.raw_amount}</p>
            `)}
          </section>
        `)}

        ${when(rules.length > 0, () => html`
          <section class="card">
            <h2>Rules that touched this</h2>
            ${rules.map((r) => html`<span class="chip chip-info">${r.name}</span> `)}
          </section>
        `)}

        <section class="card">
          <h2>History</h2>
          <ul class="explain-list">
            ${history.map(
              (e) => html`
                <li>
                  <div>${e.summary ?? e.action}</div>
                  <div class="explain-when">
                    ${e.at.slice(0, 10)} · ${memberName(e.actorMemberId)}
                  </div>
                </li>
              `,
            )}
          </ul>
        </section>
      `,
    );
  });

  router.post("/transaction/:id", (ctx) => {
    const a = auth(ctx);
    const id = ctx.params.id!;
    const transaction = getTransaction(db, id);
    if (!transaction) throw new NotFound("That transaction does not exist.");

    const dateRaw = field(ctx.body, "date");
    const newDate = dateRaw ? parseDate(dateRaw) ?? transaction.date : transaction.date;
    const confirmed = field(ctx.body, "confirm_checkpoint") === "1";

    // R7.b: guard against *both* dates — moving a transaction out of a
    // reconciled period falsifies that period just as much as moving one in.
    const guard = guardCheckpoints(
      ctx, a, transaction.account_id, [transaction.date, newDate], confirmed,
      `/transaction/${id}`, `/transaction/${id}`,
    );
    if (guard) return guard;

    const magnitude = Math.abs(amountField(field(ctx.body, "amount")));
    const actor = actorFor(a, "ui", ctx.req.headers["idempotency-key"] as string);

    // L1 · A renamed payee is the signal. Resolved here so the rename and the
    // rest of the edit land in one update, and so the *old* name is still
    // readable when we decide whether anything actually changed.
    const newPayee = (field(ctx.body, "payee") ?? "").trim();
    const previousPayee = transaction.payee_id ? getPayee(db, transaction.payee_id)?.name ?? null : null;
    const renamed = newPayee !== "" && newPayee !== previousPayee;
    const payeeId = renamed
      ? resolvePayee(db, actor, newPayee, transaction.raw_narration).id
      : undefined;

    // Guard the earlier of the two dates: moving a transaction backwards means
    // the ripple starts where it lands, not where it was.
    const rippleFrom = monthOf(newDate < transaction.date ? newDate : transaction.date);
    const { recompute } = withForwardRecompute(
      db, actor, { month: rippleFrom, cause: "Edited a transaction" },
      () =>
        updateTransaction(db, actor, id, {
          amount: field(ctx.body, "direction") === "in" ? magnitude : -magnitude,
          date: newDate,
          categoryId: field(ctx.body, "category_id") || null,
          memo: field(ctx.body, "memo") || null,
          cleared: field(ctx.body, "cleared") === "1",
          ...(payeeId !== undefined ? { payeeId } : {}),
        }),
    );

    // L1 · Cleaning up an imported payee proposes a pre-stage rule mapping the
    // raw string to the clean name, so next month's identical narration
    // arrives already named. Only for imported rows: a manually typed
    // transaction has no bank string to key a rule on.
    let learned = "";
    if (renamed && transaction.raw_narration && learningEnabled(db)) {
      const proposal = proposePayeeRule(db, actorFor(a), {
        rawNarration: transaction.raw_narration, cleanName: newPayee,
      });
      if (proposal) {
        learned = " There's a rule to confirm in Review, so this one renames itself next time.";
      }
    }

    return {
      redirect: withNotice(
        `/accounts/${transaction.account_id}`,
        "Saved." + rippleNote(recompute) + learned,
      ),
    };
  });

  router.post("/transaction/:id/delete", (ctx) => {
    const a = auth(ctx);
    const id = ctx.params.id!;
    const transaction = getTransaction(db, id);
    if (!transaction) throw new NotFound("That transaction does not exist.");

    const confirmed = field(ctx.body, "confirm_checkpoint") === "1";
    const guard = guardCheckpoints(
      ctx, a, transaction.account_id, [transaction.date], confirmed,
      `/transaction/${id}/delete`, `/transaction/${id}`,
    );
    if (guard) return guard;

    const actor = actorFor(a, "ui", ctx.req.headers["idempotency-key"] as string);
    const { recompute } = withForwardRecompute(
      db, actor, { month: monthOf(transaction.date), cause: "Deleted a transaction" },
      () => deleteTransaction(db, actor, id),
    );
    return {
      redirect: withNotice(
        `/accounts/${transaction.account_id}`,
        "Deleted. You can restore it for the next 30 days." + rippleNote(recompute),
      ),
    };
  });

  /**
   * R7.b–R7.c in one place: demand a confirmation naming the checkpoint, then
   * break it. Returns a Response to render the confirmation, or null to carry
   * on with the edit.
   */
  function guardCheckpoints(
    ctx: RequestContext, a: AuthContext, accountId: string, dates: string[],
    confirmed: boolean, action: string, cancelHref: string,
  ): Response | null {
    const account = getAccount(db, accountId)!;
    const affected = new Map<string, ReturnType<typeof listCheckpoints>[number]>();

    for (const date of new Set(dates)) {
      try {
        for (const c of guardHistoricalEdit(db, accountId, date, confirmed)) {
          affected.set(c.id, c);
        }
      } catch (err) {
        if (!(err instanceof CheckpointConfirmationRequired)) throw err;
        const fields: Record<string, string> = {};
        for (const [key, value] of Object.entries(ctx.body)) {
          fields[key] = Array.isArray(value) ? value[0]! : value;
        }
        return render(
          ctx,
          "Already reconciled",
          renderCheckpointConfirmation({
            accountName: account.nickname || account.name,
            checkpoints: err.checkpoints,
            action,
            hiddenFields: fields,
            cancelHref,
          }),
        );
      }
    }

    // R7.c/R7.e: mark them broken, with both values in the log. R7.f: they are
    // never repaired — only a fresh reconciliation asserts the balance again.
    breakCheckpoints(
      db, actorFor(a), [...affected.values()],
      `a transaction dated on or before it was changed`,
    );
    return null;
  }

  // -------------------------------------------------------------------------
  // S2c · Reconcile (F9), with the Q5 checkpoint-breakage rule
  // -------------------------------------------------------------------------
  router.get("/accounts/:id/reconcile", (ctx) => {
    const account = getAccount(db, ctx.params.id!);
    if (!account) throw new NotFound("That account does not exist.");
    const today = todayIST();

    return render(
      ctx,
      `Reconcile ${account.name}`,
      renderReconcileStart({
        account,
        status: reconciliationStatus(db, account.id, today),
        checkpoints: listCheckpoints(db, account.id),
        today,
        clearedBalance: clearedBalanceAsOf(db, account.id, today),
      }),
    );
  });

  router.post("/accounts/:id/reconcile", (ctx) => {
    const account = getAccount(db, ctx.params.id!);
    if (!account) throw new NotFound("That account does not exist.");
    const a = auth(ctx);

    const asOfRaw = field(ctx.body, "as_of");
    const asOf = asOfRaw ? parseDate(asOfRaw) ?? todayIST() : todayIST();
    const bankBalance = amountField(field(ctx.body, "bank_balance"), "The bank's balance");
    const clearIds = fieldList(ctx.body, "clear");
    const allowAdjustment = field(ctx.body, "allow_adjustment") === "1";

    const result = reconcile(db, actorFor(a, "ui", ctx.req.headers["idempotency-key"] as string), {
      accountId: account.id,
      bankBalance,
      asOf,
      clearTransactionIds: clearIds,
      allowAdjustment,
    });

    if (result.status === "needs-decision") {
      // F9.2: never guess. Show the difference and the uncleared list, and let
      // the user pick one of the three options.
      return render(
        ctx,
        `Reconcile ${account.name}`,
        renderReconcileDifference({ account, preview: result.preview }),
      );
    }

    return render(
      ctx,
      "Reconciled",
      renderReconcileDone({ account, checkpoint: result.checkpoint, adjustment: result.adjustment }),
    );
  });

  // -------------------------------------------------------------------------
  // S4 · Review — the one destination for everything needing a human
  // -------------------------------------------------------------------------
  router.get("/review", (ctx) => {
    const month = monthParam(ctx);
    const view = buildBudgetView(db, month);
    const outstanding = creditOutstanding(db);

    const unfundedCards = [...view.categories.values()]
      .filter((c) => c.paymentAccountId)
      .map((c) => ({
        accountId: c.paymentAccountId!,
        name: c.name,
        categoryId: c.id,
        unfunded: cardFunding(
          c.paymentAccountId!,
          outstanding.get(c.paymentAccountId!) ?? 0,
          c.state.balance,
          view.monthState.unfundedByAccount[c.paymentAccountId!] ?? 0,
        ).unfunded,
      }))
      .filter((c) => c.unfunded > 0);

    return render(
      ctx,
      "Review",
      renderReview({
        staged: listStaged(db),
        uncategorised: queryAll<{
          id: string; date: string; amount: number; payee: string | null; account: string;
        }>(
          db,
          `SELECT t.id, t.date, t.amount, p.name AS payee, a.name AS account
             FROM transactions t
             JOIN accounts a ON a.id = t.account_id
             LEFT JOIN payees p ON p.id = t.payee_id
            WHERE t.deleted_at IS NULL AND t.is_split = 0 AND t.category_id IS NULL
              AND t.transfer_pair_id IS NULL AND a.kind != 'tracking'
            ORDER BY t.date DESC LIMIT 50`,
        ),
        overspent: view.overspentCategories,
        unfundedCards,
        brokenCheckpoints: queryAll<{
          accountId: string; name: string; asOf: string; reason: string | null;
        }>(
          db,
          `SELECT r.account_id AS accountId, a.name AS name, r.as_of AS asOf,
                  r.broken_reason AS reason
             FROM reconciliations r JOIN accounts a ON a.id = r.account_id
            WHERE r.broken_at IS NOT NULL ORDER BY r.as_of DESC`,
        ),
        proposedRules: queryAll<{ id: string; name: string; because: string | null }>(
          db, `SELECT id, name, because FROM rules WHERE proposed = 1 AND dismissed_at IS NULL`,
        ),
        categories: [...view.categories.values()],
        bufferReading: view.buffer.reading,
        month,
      }),
    );
  });

  router.post("/review/approve", (ctx) =>
    mutate(ctx, (a) => {
      approveStaged(db, actorFor(a, "ui", ctx.req.headers["idempotency-key"] as string),
        requiredField(ctx.body, "staged_id"),
        { categoryId: field(ctx.body, "category_id") || null },
      );

      // L2 · Categorising the same payee a second time proposes a rule. The
      // proposal goes to Review and is never applied (L3) — so this can run on
      // every approval without ever changing anything on its own.
      const proposals = learningEnabled(db) ? proposeCategoryRules(db, actorFor(a)) : [];

      return {
        redirect: "/review",
        message:
          "Added to your ledger." +
          (proposals.length > 0
            ? ` Spotted a pattern — there ${proposals.length === 1 ? "is a rule" : `are ${proposals.length} rules`} to confirm below.`
            : ""),
      };
    }),
  );

  router.post("/review/reject", (ctx) =>
    mutate(ctx, (a) => {
      rejectStaged(db, actorFor(a, "ui", ctx.req.headers["idempotency-key"] as string),
        requiredField(ctx.body, "staged_id"));
      return { redirect: "/review", message: "Dismissed." };
    }),
  );

  router.post("/review/merge", (ctx) =>
    mutate(ctx, (a) => {
      mergeStaged(db, actorFor(a, "ui", ctx.req.headers["idempotency-key"] as string),
        requiredField(ctx.body, "staged_id"));
      return { redirect: "/review", message: "Merged into the transaction you already had." };
    }),
  );

  // -------------------------------------------------------------------------
  // S10 · Import
  // -------------------------------------------------------------------------
  router.get("/import", (ctx) =>
    render(ctx, "Import", renderImport({
      accounts: listAccounts(db),
      batches: listBatches(db),
      profiles: listProfiles(db).map((p) => ({
        id: p.id, name: p.name, last_used_at: p.last_used_at,
      })),
      casEnabled: config.features.assets,
    })),
  );

  router.post("/import", (ctx) => {
    const text = requiredField(ctx.body, "csv");
    const accountId = requiredField(ctx.body, "account_id");
    const fileName = field(ctx.body, "file_name") || "pasted.csv";

    // 04 §3.2 · A saved profile first, then a guess, then the mapping UI.
    // Checked before the mutation, because an unrecognised file is a *task*
    // that renders a screen, not a write that redirects.
    const recognition = recognise(db, text, accountId);
    if (recognition.kind === "unknown") {
      auth(ctx);
      const headerRow = candidateHeaderRows(recognition.rows)[0]?.index ?? 0;
      return render(
        ctx, "Which column is which?",
        renderMapping({
          accountId, fileName, csv: text,
          rows: recognition.rows,
          candidateHeaders: candidateHeaderRows(recognition.rows),
          headerRow,
          choices: columnChoices(recognition.rows, headerRow),
        }),
      );
    }

    return mutate(ctx, (a) => {
      const mapping =
        recognition.kind === "profile" ? recognition.profile.mapping : recognition.mapping;
      if (recognition.kind === "profile") markProfileUsed(db, recognition.profile.id);

      const result = parseWith(recognition.rows, mapping);

      const outcome = ingest(db, actorFor(a, "import", ctx.req.headers["idempotency-key"] as string), {
        accountId, source: "csv", adapter: "csv", fileName,
        records: result.records, errors: result.errors, rowsRead: result.rowsRead,
      });

      // A guess that worked is worth remembering, so next month asks nothing.
      if (recognition.kind === "guessed" && result.records.length > 0) {
        saveProfile(db, actorFor(a), {
          name: `${getAccount(db, accountId)?.name ?? "Statement"} columns`,
          accountId, headers: recognition.headers, mapping,
        });
      }

      const parts = [`${outcome.staged} to review`];
      if (outcome.autoApproved) parts.push(`${outcome.autoApproved} auto-approved`);
      if (outcome.duplicates) parts.push(`${outcome.duplicates} possible duplicates`);
      if (outcome.skipped) parts.push(`${outcome.skipped} already present`);
      if (outcome.errors) parts.push(`${outcome.errors} rows I couldn't read`);

      return {
        redirect: outcome.staged > 0 ? "/review" : "/import",
        message: `Read ${outcome.batch.rows_read} rows — ${parts.join(", ")}.`,
      };
    });
  });

  /**
   * `04` §3.2 · The mapping UI. Reached when a file matches nothing known —
   * a mapping task, not an error, so nothing here reports a failure.
   */
  router.post("/import/map", (ctx) =>
    mutate(ctx, (a) => {
      const text = requiredField(ctx.body, "csv");
      const accountId = requiredField(ctx.body, "account_id");
      const fileName = field(ctx.body, "file_name") || "pasted.csv";
      const pick = (name: string) => {
        const value = Number(field(ctx.body, name));
        return Number.isInteger(value) && value >= 0 ? value : null;
      };

      const mapping = mappingFromSelections({
        headerRow: pick("header_row") ?? 0,
        date: pick("date") ?? -1,
        narration: pick("narration") ?? -1,
        amount: pick("amount"),
        debit: pick("debit"),
        credit: pick("credit"),
        balance: pick("balance"),
        reference: pick("reference"),
      });

      const problem = validateMapping(mapping);
      if (problem) throw new HttpError(400, problem);

      const recognition = recognise(db, text, accountId);
      const result = parseWith(recognition.rows, mapping);

      saveProfile(db, actorFor(a), {
        name: requiredField(ctx.body, "profile_name"),
        accountId,
        headers: recognition.rows[mapping.headerRow] ?? [],
        mapping,
      });

      const outcome = ingest(db, actorFor(a, "import"), {
        accountId, source: "csv", adapter: "csv", fileName,
        records: result.records, errors: result.errors, rowsRead: result.rowsRead,
      });

      return {
        redirect: outcome.staged > 0 ? "/review" : "/import",
        message:
          `Read ${outcome.batch.rows_read} rows, and remembered these columns — ` +
          `the next file like this will import without asking.`,
      };
    }),
  );

  router.post("/import/profiles/:id/delete", (ctx) =>
    mutate(ctx, (a) => {
      deleteProfile(db, actorFor(a), ctx.params.id!);
      return { redirect: "/import", message: "Forgotten." };
    }),
  );

  router.post("/import/undo", (ctx) =>
    mutate(ctx, (a) => {
      const result = undoBatch(db, actorFor(a, "ui", ctx.req.headers["idempotency-key"] as string),
        requiredField(ctx.body, "batch_id"));
      return {
        redirect: "/import",
        message:
          `Removed ${result.removed} transactions` +
          (result.keptBecauseEdited.length
            ? `. ${result.keptBecauseEdited.length} had been edited since and were left alone.`
            : "."),
      };
    }),
  );


  // -------------------------------------------------------------------------
  // S12 · Loans (F18). P1 per 10 §2 E9.
  // -------------------------------------------------------------------------
  function requireLoans(): void {
    // F28.2: a disabled module disappears rather than appearing greyed out.
    if (!config.features.loans) throw new NotFound();
  }

  router.get("/loans", (ctx) => {
    requireLoans();
    const projections = listLoans(db)
      .map((l) => projectLoan(db, l.id))
      .filter((p): p is NonNullable<typeof p> => p !== null);
    return render(ctx, "Loans", renderLoanList(projections, debtOverview(db)));
  });

  router.get("/loans/new", (ctx) => {
    requireLoans();
    return render(
      ctx, "Add a loan",
      renderNewLoanForm({
        accounts: listAccounts(db)
          .filter((a) => a.kind === "budget")
          .map((a) => ({ id: a.id, name: a.nickname || a.name })),
      }),
    );
  });

  router.post("/loans/new", (ctx) =>
    mutate(ctx, (a) => {
      requireLoans();
      const outstandingRaw = field(ctx.body, "current_outstanding");
      const historyFrom = field(ctx.body, "history_from");
      const firstDue = field(ctx.body, "first_instalment_date");

      const loan = createLoan(db, actorFor(a, "ui", ctx.req.headers["idempotency-key"] as string), {
        lender: requiredField(ctx.body, "lender"),
        nickname: field(ctx.body, "nickname") || null,
        loanType: requiredField(ctx.body, "loan_type") as LoanType,
        sanctioned: amountField(field(ctx.body, "sanctioned"), "Sanctioned amount"),
        sanctionDate: parseDate(field(ctx.body, "sanction_date") ?? "") ?? todayIST(),
        interestModel: (field(ctx.body, "interest_model") ?? "reducing") as "reducing" | "flat",
        annualRatePct: Number(requiredField(ctx.body, "annual_rate")),
        tenureMonths: Number(requiredField(ctx.body, "tenure_months")),
        firstInstalmentDate: firstDue ? parseDate(firstDue) : null,
        repaymentAccountId: field(ctx.body, "repayment_account_id") || null,
        currentOutstanding: outstandingRaw?.trim() ? amountField(outstandingRaw) : null,
        historyFrom: historyFrom ? parseDate(historyFrom) : null,
      });

      return { redirect: `/loans/${loan.id}`, message: `Added the ${loan.lender} loan.` };
    }),
  );

  /**
   * R19.7 · The what-if calculator, usable before any loan exists (Q14). This
   * is the feature people will open the app for, so it is not behind a loan.
   */
  router.get("/loans/what-if", (ctx) => {
    requireLoans();
    return render(
      ctx, "Prepayment calculator",
      renderPrepaymentComparison({
        comparison: comparePrepayment({
          principal: rupeesFromQuery(ctx, "principal", 50_00_000),
          annualRatePct: Number(ctx.query.get("rate") ?? 8.5),
          months: Number(ctx.query.get("months") ?? 240),
          prepayment: rupeesFromQuery(ctx, "amount", 5_00_000),
          atMonth: Number(ctx.query.get("at_month") ?? 24),
        }),
        loan: null,
        amount: rupeesFromQuery(ctx, "amount", 5_00_000),
        atMonth: Number(ctx.query.get("at_month") ?? 24),
        action: "/loans/what-if",
      }),
    );
  });

  router.post("/loans/what-if", (ctx) => {
    requireLoans();
    auth(ctx);
    const principal = amountField(field(ctx.body, "principal"), "Loan amount");
    const months = Number(requiredField(ctx.body, "months"));
    const rate = Number(requiredField(ctx.body, "rate"));
    const amount = amountField(field(ctx.body, "amount"), "Prepayment");
    const atMonth = Number(field(ctx.body, "at_month") ?? 12);

    return render(
      ctx, "Prepayment calculator",
      renderPrepaymentComparison({
        comparison: comparePrepayment({ principal, annualRatePct: rate, months, prepayment: amount, atMonth }),
        loan: null, amount, atMonth, action: "/loans/what-if",
      }),
    );
  });

  router.get("/loans/:id", (ctx) => {
    requireLoans();
    const projection = projectLoan(db, ctx.params.id!);
    if (!projection) throw new NotFound("That loan does not exist.");
    return render(
      ctx,
      projection.loan.nickname || projection.loan.lender,
      renderLoanDetail({
        projection,
        payments: listPayments(db, projection.loan.id),
        disbursements: listDisbursements(db, projection.loan.id),
        rates: listRatePeriods(db, projection.loan.id),
      }),
    );
  });

  /** R17.2 · The schedule exportable to CSV. */
  router.get("/loans/:id/schedule.csv", (ctx) => {
    requireLoans();
    auth(ctx);
    const projection = projectLoan(db, ctx.params.id!);
    if (!projection) throw new NotFound("That loan does not exist.");

    const rows = [
      "number,due_date,opening,instalment,principal,interest,closing,cumulative_interest",
      ...projection.schedule.instalments.map((i) =>
        [
          i.number, i.dueDate ?? "", i.opening / 100, i.payment / 100,
          i.principal / 100, i.interest / 100, i.closing / 100, i.cumulativeInterest / 100,
        ].join(","),
      ),
    ].join("\n");

    return {
      body: rows,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="schedule-${projection.loan.id}.csv"`,
      },
    };
  });

  router.get("/loans/:id/pay", (ctx) => {
    requireLoans();
    const projection = projectLoan(db, ctx.params.id!);
    if (!projection) throw new NotFound("That loan does not exist.");
    return render(
      ctx, "Record an instalment",
      renderRecordInstalment({
        projection,
        accounts: listAccounts(db)
          .filter((a) => a.kind === "budget")
          .map((a) => ({ id: a.id, name: a.nickname || a.name })),
        today: todayIST(),
      }),
    );
  });

  router.post("/loans/:id/pay", (ctx) =>
    mutate(ctx, (a) => {
      requireLoans();
      const loanId = ctx.params.id!;
      const principalRaw = field(ctx.body, "principal");
      const interestRaw = field(ctx.body, "interest");

      recordInstalment(db, actorFor(a, "ui", ctx.req.headers["idempotency-key"] as string), {
        loanId,
        date: parseDate(field(ctx.body, "date") ?? "") ?? todayIST(),
        amount: amountField(field(ctx.body, "amount")),
        principal: principalRaw?.trim() ? amountField(principalRaw) : null,
        interest: interestRaw?.trim() ? amountField(interestRaw) : null,
        fromAccountId: field(ctx.body, "from_account_id") || null,
      });

      return { redirect: `/loans/${loanId}`, message: "Instalment recorded." };
    }),
  );

  router.get("/loans/:id/prepay", (ctx) => {
    requireLoans();
    const projection = projectLoan(db, ctx.params.id!);
    if (!projection) throw new NotFound("That loan does not exist.");

    const amount = rupeesFromQuery(ctx, "amount", 1_00_000);
    const atMonth = Number(ctx.query.get("at_month") ?? 1);
    const view = buildBudgetView(db);

    return render(
      ctx, "Prepay",
      renderPrepaymentComparison({
        comparison: comparePrepayment({
          principal: projection.outstanding,
          annualRatePct: projection.ratePct,
          months: Math.max(1, projection.schedule.months),
          prepayment: amount,
          atMonth,
        }),
        loan: projection.loan,
        amount,
        atMonth,
        action: `/loans/${projection.loan.id}/prepay`,
        // R19.4: the funding source must be explicit.
        fundingSources: [...view.categories.values()]
          .filter((c) => !c.isPaymentCategory && c.state.balance > 0)
          .map((c) => ({ id: c.id, name: c.name, balance: c.state.balance })),
        emergencyFundWarning: emergencyFundWarning(view, amount),
      }),
    );
  });

  router.post("/loans/:id/prepay", (ctx) => {
    requireLoans();
    const a = auth(ctx);
    const loanId = ctx.params.id!;
    const projection = projectLoan(db, loanId);
    if (!projection) throw new NotFound("That loan does not exist.");

    const amount = amountField(field(ctx.body, "amount"), "Prepayment");
    const atMonth = Number(field(ctx.body, "at_month") ?? 1);

    // The preview button recalculates rather than committing.
    if (field(ctx.body, "preview") === "1") {
      return { redirect: `/loans/${loanId}/prepay?amount=${amount}&at_month=${atMonth}` };
    }

    const chargeRaw = field(ctx.body, "charge");
    const charge = chargeRaw?.trim() ? amountField(chargeRaw) : 0;
    const mode = field(ctx.body, "mode") === "emi" ? "emi" : "tenure";
    const actor = actorFor(a, "ui", ctx.req.headers["idempotency-key"] as string);

    recordInstalment(db, actor, {
      loanId,
      date: todayIST(),
      amount,
      principal: amount,
      interest: 0,
      kind: "prepayment",
      fromAccountId: projection.loan.repayment_account_id,
      note: `Prepayment, applied by reducing the ${mode === "emi" ? "instalment" : "tenure"}`,
    });

    if (charge > 0) {
      // R19.5: recorded as a separate cost, and included in the net saving.
      recordInstalment(db, actor, {
        loanId, date: todayIST(), amount: charge, principal: 0, interest: charge,
        kind: "charge", note: "Prepayment charge",
      });
    }

    return {
      redirect: withNotice(
        `/loans/${loanId}`,
        `Prepaid ${formatPaise(amount)}, applied by reducing the ${mode === "emi" ? "instalment" : "tenure"}.`,
      ),
    };
  });

  function rupeesFromQuery(ctx: RequestContext, name: string, fallbackRupees: number): number {
    const raw = ctx.query.get(name);
    if (!raw) return fallbackRupees * 100;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? Math.round(parsed) : fallbackRupees * 100;
  }

  /**
   * R19.6 · Warn when a prepayment would leave the emergency fund short, and
   * never block it (P2 — the app has no authority to prevent spending).
   */
  function emergencyFundWarning(
    view: ReturnType<typeof buildBudgetView>, amount: number,
  ): string | null {
    const fund = [...view.categories.values()].find((c) => /emergency/i.test(c.name));
    if (!fund || fund.state.balance >= amount) return null;
    return (
      `This is more than your ${fund.name} holds (${formatPaise(fund.state.balance)}). ` +
      `Paying down debt is usually right, but an emergency fund is what stops the next ` +
      `surprise going back onto a card. Your call.`
    );
  }


  // -------------------------------------------------------------------------
  // S6 Reports · S7 Query · F16 Search
  // -------------------------------------------------------------------------
  function filterFromQuery(ctx: RequestContext): { filter: TransactionFilter; period: ReturnType<typeof periodFor> } {
    const period = periodFor(ctx.query.get("period") ?? "this-month");
    const account = ctx.query.get("account");
    const category = ctx.query.get("category");

    return {
      period,
      filter: {
        from: period.from,
        to: period.to,
        text: ctx.query.get("q") ?? undefined,
        accountIds: account ? [account] : undefined,
        categoryIds: category ? [category] : undefined,
        limit: 1000,
      },
    };
  }

  function queryPage(ctx: RequestContext, title?: string) {
    const { filter, period } = filterFromQuery(ctx);
    const groupBy = (ctx.query.get("group_by") ?? "category") as GroupBy;
    const rows = queryTransactions(db, filter);

    return render(
      ctx,
      title ?? "Query",
      renderQuery({
        rows,
        groups: groupTotals(rows, groupBy),
        groupBy,
        period,
        periods: periodPresets(),
        text: ctx.query.get("q") ?? "",
        accounts: listAccounts(db).map((a) => ({ id: a.id, name: a.nickname || a.name })),
        categories: listCategories(db).map((c) => ({ id: c.id, name: c.name })),
        selectedAccounts: filter.accountIds ?? [],
        selectedCategories: filter.categoryIds ?? [],
        title,
      }),
    );
  }

  router.get("/query", (ctx) => queryPage(ctx));

  /** F16 · Search is the query screen with the text box in focus. */
  router.get("/search", (ctx) => queryPage(ctx, "Search"));

  router.get("/query.csv", (ctx) => {
    auth(ctx);
    const { filter } = filterFromQuery(ctx);
    return {
      body: rowsToCsv(queryTransactions(db, filter)),
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="query-${todayIST()}.csv"`,
      },
    };
  });

  router.get("/reports", (ctx) => {
    const period = periodFor(ctx.query.get("period") ?? "last-12");
    return render(
      ctx, "Reports",
      renderReports({
        trend: incomeVsExpense(db, period.from, period.to),
        period,
        periods: periodPresets(),
        loanInterest: config.features.loans ? loanInterestByFinancialYear(db) : [],
      }),
    );
  });

  // -------------------------------------------------------------------------
  // S8 · Schedules and the cashflow calendar (F7)
  // -------------------------------------------------------------------------
  router.get("/schedules", (ctx) => {
    const horizon = Number(ctx.query.get("days") ?? 60);
    const cashflow = projectCashflow(db, { days: horizon });
    const view = buildBudgetView(db);

    return render(
      ctx, "Schedules",
      renderSchedules({
        schedules: listSchedules(db),
        detected: detectSchedules(db),
        cashflow,
        cashflowReading: describeCashflow(cashflow),
        subscriptions: subscriptions(db),
        horizon,
        categoryNames: new Map([...view.categories].map(([id, c]) => [id, c.name])),
      }),
    );
  });

  router.post("/schedules/confirm", (ctx) =>
    mutate(ctx, (a) => {
      // F7.6: a detected schedule becomes real only when confirmed, and stops
      // being marked "detected" once it is.
      createSchedule(db, actorFor(a, "ui", ctx.req.headers["idempotency-key"] as string), {
        name: requiredField(ctx.body, "name"),
        payeeId: field(ctx.body, "payee_id") || null,
        accountId: field(ctx.body, "account_id") || null,
        categoryId: field(ctx.body, "category_id") || null,
        amount: Number(field(ctx.body, "amount") ?? 0),
        recurrence: (field(ctx.body, "recurrence") ?? "monthly") as Recurrence,
        nextDue: field(ctx.body, "next_due") ?? todayIST(),
      });
      return { redirect: "/schedules", message: "Added to your schedules." };
    }),
  );

  router.post("/schedules/dismiss", (ctx) =>
    mutate(ctx, (a) => {
      // Dismissal is remembered, so the same suggestion does not keep returning.
      execute(
        db,
        `INSERT OR REPLACE INTO review_dismissals (kind, ref, at, member_id) VALUES (?,?,?,?)`,
        "detected-schedule", requiredField(ctx.body, "payee_id"), todayIST(), a.member.id,
      );
      return { redirect: "/schedules", message: "Won't suggest that again." };
    }),
  );

  router.post("/schedules/new", (ctx) =>
    mutate(ctx, (a) => {
      createSchedule(db, actorFor(a, "ui", ctx.req.headers["idempotency-key"] as string), {
        name: requiredField(ctx.body, "name"),
        amount: -Math.abs(amountField(field(ctx.body, "amount"))),
        recurrence: (field(ctx.body, "recurrence") ?? "monthly") as Recurrence,
        nextDue: parseDate(field(ctx.body, "next_due") ?? "") ?? todayIST(),
        categoryId: field(ctx.body, "category_id") || null,
        accountId: field(ctx.body, "account_id") || null,
        isSubscription: field(ctx.body, "is_subscription") === "1",
      });
      return { redirect: "/schedules", message: "Schedule added." };
    }),
  );

  router.post("/schedules/:id/paid", (ctx) =>
    mutate(ctx, (a) => {
      markPaid(db, actorFor(a, "ui", ctx.req.headers["idempotency-key"] as string), ctx.params.id!);
      return { redirect: "/schedules", message: "Marked paid." };
    }),
  );

  router.post("/schedules/:id/skip", (ctx) =>
    mutate(ctx, (a) => {
      skipOccurrence(db, actorFor(a, "ui", ctx.req.headers["idempotency-key"] as string), ctx.params.id!);
      return { redirect: "/schedules", message: "Skipped this one." };
    }),
  );

  // -------------------------------------------------------------------------
  // S9 · Goals (F11)
  // -------------------------------------------------------------------------
  router.get("/goals", (ctx) => {
    const view = buildBudgetView(db);
    const balances = new Map(
      [...view.categories].map(([id, c]) => [id, { name: c.name, balance: c.state.balance }]),
    );

    return render(
      ctx, "Goals",
      renderGoals({
        goals: goalProgress(db, balances),
        categories: [...view.categories.values()]
          .filter((c) => !c.isPaymentCategory && !c.hidden)
          .map((c) => ({ id: c.id, name: c.name })),
      }),
    );
  });

  router.post("/goals/new", (ctx) =>
    mutate(ctx, (a) => {
      const targetDate = field(ctx.body, "target_date");
      createGoal(db, actorFor(a, "ui", ctx.req.headers["idempotency-key"] as string), {
        name: requiredField(ctx.body, "name"),
        targetAmount: amountField(field(ctx.body, "target_amount"), "Target"),
        targetDate: targetDate ? parseDate(targetDate) : null,
        categoryIds: fieldList(ctx.body, "category_ids"),
      });
      return { redirect: "/goals", message: "Goal added." };
    }),
  );

  router.post("/goals/:id/complete", (ctx) =>
    mutate(ctx, (a) => {
      const resolution = (field(ctx.body, "resolution") ?? "release") as "spend" | "roll" | "release";
      completeGoal(db, actorFor(a, "ui", ctx.req.headers["idempotency-key"] as string), ctx.params.id!, resolution);
      return { redirect: "/goals", message: "Goal completed." };
    }),
  );


  // -------------------------------------------------------------------------
  // S5 More · F5 payees · F6 rules · F3 categories · J1 first run
  // -------------------------------------------------------------------------
  router.get("/more", (ctx) =>
    render(ctx, "More", renderMore({ loans: config.features.loans, assets: config.features.assets })),
  );

  router.get("/payees", (ctx) => {
    const rows: PayeeRow[] = listPayees(db).map((p) => {
      const stats = payeeStats(db, p.id);
      return {
        id: p.id,
        name: p.name,
        count: stats.count,
        total: stats.total,
        lastSeen: stats.lastSeen,
        aliases: queryAll<{ raw: string }>(
          db, `SELECT raw FROM payee_aliases WHERE payee_id = ? LIMIT 5`, p.id,
        ).map((r) => r.raw),
        usualCategory: stats.usualCategoryId
          ? getCategory(db, stats.usualCategoryId)?.name ?? null
          : null,
      };
    });
    return render(ctx, "Payees", renderPayees(rows));
  });

  router.post("/payees/merge", (ctx) =>
    mutate(ctx, (a) => {
      const loser = requiredField(ctx.body, "loser_id");
      const winner = requiredField(ctx.body, "winner_id");
      mergePayees(db, actorFor(a, "ui", ctx.req.headers["idempotency-key"] as string), loser, winner);
      return {
        redirect: "/payees",
        message: `Merged into ${getPayee(db, winner)?.name ?? "that payee"}. Every raw string came across.`,
      };
    }),
  );

  function ruleRows(db2: DB, proposed: boolean): RuleRow[] {
    return queryAll<{
      id: string; name: string; stage: string; conditions_json: string;
      actions_json: string; enabled: number; times_applied: number; because: string | null;
    }>(
      db2,
      `SELECT * FROM rules WHERE proposed = ? AND dismissed_at IS NULL ORDER BY created_at DESC`,
      proposed ? 1 : 0,
    ).map((r) => ({
      id: r.id, name: r.name, stage: r.stage as Rule["stage"], match: "all",
      conditions: JSON.parse(r.conditions_json) as Rule["conditions"],
      actions: JSON.parse(r.actions_json) as Rule["actions"],
      enabled: r.enabled === 1,
      because: r.because,
      timesApplied: r.times_applied,
    }));
  }

  function ruleFromBody(ctx: RequestContext): Rule {
    return {
      id: "draft",
      name: requiredField(ctx.body, "name"),
      stage: "default",
      match: "all",
      conditions: [
        {
          field: requiredField(ctx.body, "field") as Rule["conditions"][number]["field"],
          op: requiredField(ctx.body, "op") as Rule["conditions"][number]["op"],
          value: requiredField(ctx.body, "value"),
        },
      ],
      actions: [{ type: "setCategory", categoryId: requiredField(ctx.body, "category_id") }],
      enabled: true,
    };
  }

  function rulesPage(
    ctx: RequestContext,
    test?: Parameters<typeof renderRules>[0]["test"],
    draft?: Parameters<typeof renderRules>[0]["draft"],
  ) {
    const view = buildBudgetView(db);
    return render(
      ctx, "Rules",
      renderRules({
        rules: ruleRows(db, false),
        proposed: ruleRows(db, true),
        categories: [...view.categories.values()]
          .filter((c) => !c.isPaymentCategory && !c.hidden)
          .map((c) => ({ id: c.id, name: c.name })),
        test,
        draft,
      }),
    );
  }

  router.get("/rules", (ctx) => rulesPage(ctx));

  /** F6.7 · Test against history before saving, with before/after and a count. */
  router.post("/rules/test", (ctx) => {
    auth(ctx);
    const rule = ruleFromBody(ctx);
    const view = buildBudgetView(db);

    const subjects: RuleSubject[] = queryAll<{
      narration: string | null; payee: string | null; account_id: string;
      amount: number; date: string; memo: string | null; category_id: string | null;
      cleared: number; source: string;
    }>(
      db,
      `SELECT t.raw_narration AS narration, p.name AS payee, t.account_id, t.amount, t.date,
              t.memo, t.category_id, t.cleared, t.source
         FROM transactions t LEFT JOIN payees p ON p.id = t.payee_id
        WHERE t.deleted_at IS NULL ORDER BY t.date DESC LIMIT 500`,
    ).map((r) => {
      const narration = r.narration ?? r.payee ?? "";
      return {
        narration, importedPayee: r.payee, payee: r.payee, accountId: r.account_id,
        amount: r.amount, date: r.date, memo: r.memo, tags: [],
        categoryId: r.category_id, cleared: r.cleared === 1, source: r.source,
        cardLast4: null, ...extractNarrationFields(narration),
      };
    });

    const result = testRule(rule, subjects);
    return rulesPage(
      ctx,
      {
        matched: result.matched,
        samples: result.samples,
        categoryNames: new Map([...view.categories].map(([id, c]) => [id, c.name])),
      },
      {
        name: rule.name,
        field: String(rule.conditions[0]!.field),
        op: String(rule.conditions[0]!.op),
        value: String(rule.conditions[0]!.value),
        categoryId: (rule.actions[0] as { categoryId: string }).categoryId,
        stage: rule.stage,
      },
    );
  });

  router.post("/rules/new", (ctx) =>
    mutate(ctx, (a) => {
      const rule = ruleFromBody(ctx);
      const id = newId();
      execute(
        db,
        `INSERT INTO rules (id,name,stage,conditions_json,actions_json,enabled,proposed,created_at,created_by)
         VALUES (?,?,?,?,?,1,0,?,?)`,
        id, rule.name, rule.stage,
        JSON.stringify(rule.conditions), JSON.stringify(rule.actions),
        nowIST(), a.member.id,
      );
      appendEvent(db, actorFor(a), {
        entity: "rule", entityId: id, action: "create", after: rule,
        summary: `Added the rule "${rule.name}"`,
      });
      return { redirect: "/rules", message: `Saved. It will apply to anything imported from now on.` };
    }),
  );

  /** F6.6 · Apply a rule to matching existing transactions, count first. */
  router.post("/rules/:id/apply", (ctx) => {
    const a = auth(ctx);
    const rules = ruleRows(db, false).concat(ruleRows(db, true));
    const rule = rules.find((r) => r.id === ctx.params.id);
    if (!rule) throw new NotFound("That rule does not exist.");

    if (field(ctx.body, "confirm") !== "1") {
      // F6.6 requires the count and a preview *before* commit.
      const preview = previewRetroactive(db, rule);
      return render(
        ctx, "Apply to existing transactions",
        html`
          <h1>Apply "${rule.name}" to what's already here?</h1>
          ${preview.count === 0
            ? html`
                <div class="card empty-state">
                  <p>Nothing in your history matches this rule. It still applies to
                     anything imported from now on.</p>
                  <p><a class="button" href="/rules">Back to rules</a></p>
                </div>
              `
            : html`
                <div class="card">
                  <p class="notice notice-info">
                    Matches <strong>${preview.count}</strong>
                    ${preview.count === 1 ? "transaction" : "transactions"};
                    <strong>${preview.changing}</strong> would actually change.
                    The rest already agree with it.
                  </p>
                  <div class="table-scroll" style="max-height:22rem;overflow-y:auto">
                    <table>
                      <thead>
                        <tr>
                          <th scope="col">Date</th>
                          <th scope="col">Payee</th>
                          <th scope="col">Now</th>
                          <th scope="col">Would become</th>
                        </tr>
                      </thead>
                      <tbody>
                        ${preview.matches.map(
                          (m) => html`
                            <tr>
                              <td>${m.date}</td>
                              <td>${m.payee ?? "—"}</td>
                              <td class="faint">${m.currentCategory ?? "Uncategorised"}</td>
                              <td><strong>${m.proposedCategory ?? "—"}</strong></td>
                            </tr>
                          `,
                        )}
                      </tbody>
                    </table>
                  </div>
                  <form method="post" action="/rules/${rule.id}/apply" style="margin-top:1rem">
                    <input type="hidden" name="confirm" value="1">
                    <button class="button-primary" type="submit">
                      Change ${preview.changing}
                      ${preview.changing === 1 ? "transaction" : "transactions"}
                    </button>
                    <a class="button button-quiet" href="/rules">Cancel</a>
                  </form>
                  <p class="field-hint">Undoable in one action for the next 30 days.</p>
                </div>
              `}
        `,
      );
    }

    const changed = applyRetroactive(db, actorFor(a, "ui", ctx.req.headers["idempotency-key"] as string), rule);
    return {
      redirect: withNotice(
        "/rules",
        `Recategorised ${changed} ${changed === 1 ? "transaction" : "transactions"}.`,
      ),
    };
  });

  router.post("/rules/confirm", (ctx) =>
    mutate(ctx, (a) => {
      const id = requiredField(ctx.body, "rule_id");
      execute(db, `UPDATE rules SET proposed = 0 WHERE id = ?`, id);
      appendEvent(db, actorFor(a), {
        entity: "rule", entityId: id, action: "confirm",
        summary: `Confirmed a proposed rule`,
      });
      return { redirect: "/rules", message: "Rule confirmed." };
    }),
  );

  router.post("/rules/dismiss", (ctx) =>
    mutate(ctx, (a) => {
      // L5: dismissing a proposal suppresses that specific proposal for good.
      const id = requiredField(ctx.body, "rule_id");
      const rule = ruleRows(db, true).find((r) => r.id === id);
      execute(db, `UPDATE rules SET dismissed_at = ? WHERE id = ?`, nowIST(), id);

      // L5 · Dismissing suppresses *that specific proposal* permanently, so
      // the same suggestion never comes back.
      if (rule) {
        const condition = rule.conditions[0];
        const action = rule.actions[0] as { categoryId?: string; payee?: string } | undefined;
        suppress(
          db,
          action?.categoryId ? "learned-rule" : "learned-payee",
          `${String(condition?.value ?? "")}:${action?.categoryId ?? action?.payee ?? ""}`,
          a.member.id,
        );
      }

      appendEvent(db, actorFor(a), {
        entity: "rule", entityId: id, action: "dismiss",
        summary: `Dismissed a proposed rule; it won't be suggested again`,
      });
      return { redirect: "/rules", message: "Won't suggest that again." };
    }),
  );

  router.post("/rules/:id/delete", (ctx) =>
    mutate(ctx, (a) => {
      const id = ctx.params.id!;
      execute(db, `UPDATE rules SET enabled = 0, dismissed_at = ? WHERE id = ?`, nowIST(), id);
      appendEvent(db, actorFor(a), {
        entity: "rule", entityId: id, action: "delete",
        summary: `Removed a rule. Transactions it already touched are unchanged.`,
      });
      return { redirect: "/rules", message: "Removed." };
    }),
  );

  router.get("/categories", (ctx) => {
    const view = buildBudgetView(db);
    return render(
      ctx, "Categories",
      renderCategories(
        listGroups(db).map((g) => ({
          id: g.id,
          name: g.name,
          kind: g.kind,
          categories: [...view.categories.values()]
            .filter((c) => c.groupId === g.id)
            .map((c) => ({
              id: c.id, name: c.name, hidden: c.hidden,
              balance: c.state.balance, isPayment: c.isPaymentCategory,
            })),
        })),
      ),
    );
  });

  router.post("/categories/new", (ctx) =>
    mutate(ctx, (a) => {
      createCategory(db, actorFor(a, "ui", ctx.req.headers["idempotency-key"] as string), {
        groupId: requiredField(ctx.body, "group_id"),
        name: requiredField(ctx.body, "name"),
      });
      return { redirect: "/categories", message: "Category added." };
    }),
  );

  router.post("/categories/:id/rename", (ctx) =>
    mutate(ctx, (a) => {
      renameCategory(db, actorFor(a, "ui", ctx.req.headers["idempotency-key"] as string),
        ctx.params.id!, requiredField(ctx.body, "name"));
      return { redirect: "/categories", message: "Renamed." };
    }),
  );

  router.post("/categories/:id/hide", (ctx) =>
    mutate(ctx, (a) => {
      const hidden = field(ctx.body, "hidden") === "1";
      setCategoryHidden(db, actorFor(a, "ui", ctx.req.headers["idempotency-key"] as string),
        ctx.params.id!, hidden);
      return {
        redirect: "/categories",
        message: hidden ? "Hidden. It keeps its balance and history." : "Unhidden.",
      };
    }),
  );

  // -------------------------------------------------------------------------
  // J1 · First run
  // -------------------------------------------------------------------------
  router.get("/setup", (ctx) => {
    const a = auth(ctx);
    return render(ctx, "Set up", renderFirstRun({ memberName: a.member.name }), { bare: true });
  });

  router.post("/setup", (ctx) =>
    mutate(ctx, (a) => {
      const result = applyStartingTemplate(db, actorFor(a), {
        monthlyIncome: amountField(field(ctx.body, "monthly_income"), "Monthly income"),
        hasEmis: field(ctx.body, "has_emis") === "1",
        hasSchoolFees: field(ctx.body, "has_school_fees") === "1",
        hasDomesticHelp: field(ctx.body, "has_domestic_help") === "1",
      });
      return {
        redirect: "/accounts/new",
        message:
          `${result.categories} categories ready. Now add the account your salary ` +
          `lands in — that's when Ready to Assign becomes a real number.`,
      };
    }),
  );

  router.post("/setup/blank", (ctx) =>
    mutate(ctx, (a) => {
      startBlank(db, actorFor(a));
      return { redirect: "/accounts/new", message: "Starting blank. Add your first account." };
    }),
  );


  // -------------------------------------------------------------------------
  // S13 · Portfolio · S14 · Net worth (F19, F20). P2.
  // -------------------------------------------------------------------------
  function requireAssets(): void {
    // F28.2: a disabled module disappears rather than appearing greyed out.
    if (!config.features.assets) throw new NotFound();
  }

  // -------------------------------------------------------------------------
  // `08` S5 · The month-close ritual. P1 per Q26.
  // -------------------------------------------------------------------------

  router.get("/months", (ctx) => {
    auth(ctx);
    return render(ctx, "Month closes", renderClosedMonths({
      months: closedMonths(db),
      awaiting: monthAwaitingClose(db),
    }));
  });

  router.get("/months/:month/close", (ctx) => {
    auth(ctx);
    const month = ctx.params.month!;
    if (!isMonthKey(month)) throw new NotFound("That is not a month.");
    return render(
      ctx, `Closing ${formatMonth(month)}`, renderMonthClose(monthCloseView(db, month)),
    );
  });

  router.post("/months/:month/close", (ctx) =>
    mutate(ctx, (a) => {
      const month = ctx.params.month!;
      if (!isMonthKey(month)) throw new NotFound("That is not a month.");

      const result = closeMonth(
        db, actorFor(a, "ui", ctx.req.headers["idempotency-key"] as string),
        month, field(ctx.body, "note") || null,
      );

      return {
        redirect: `/?month=${addMonths(month, 1)}`,
        message:
          `${formatMonth(month)} is closed` +
          (result.snapshotTaken ? ", and net worth is snapshotted" : "") +
          `. Here is ${formatMonth(addMonths(month, 1))}.`,
      };
    }),
  );

  router.post("/months/:month/reopen", (ctx) =>
    mutate(ctx, (a) => {
      const month = ctx.params.month!;
      if (!isMonthKey(month)) throw new NotFound("That is not a month.");
      reopenMonth(db, actorFor(a), month);
      return { redirect: "/months", message: `${formatMonth(month)} is open again.` };
    }),
  );

  /** F14.2 · Individually toggleable per member. */
  router.post("/settings/digest", (ctx) =>
    mutate(ctx, (a) => {
      // The form posts what the member *wants*; the table stores what they do
      // not, so a member who has never opened settings still gets told.
      const wanted = new Set(fieldList(ctx.body, "kind"));
      const muted = DIGEST_KINDS.filter((k) => !wanted.has(k)) as DigestKind[];
      setMutedKinds(db, actorFor(a), muted);
      return { redirect: "/settings#notifications", message: "Saved." };
    }),
  );

  router.get("/portfolio", (ctx) => {
    requireAssets();
    const accounts = new Map(listAssetAccounts(db).map((a) => [a.id, a.name]));

    const rows: PortfolioRow[] = listHoldings(db)
      .map((h) => {
        const view = viewHolding(db, h.id);
        return view ? { view, accountName: accounts.get(view.holding.account_id) ?? "" } : null;
      })
      .filter((r): r is PortfolioRow => r !== null);

    // F19.16 · A portfolio-level XIRR, labelled money-weighted.
    const flows = rows.flatMap((r) => [
      ...r.view.lots.map((l) => ({ date: l.tradeDate, amount: -l.cost })),
      { date: todayIST(), amount: r.view.marketValue },
    ]);

    const manualAssets = listAssetAccounts(db)
      .filter((a) => listHoldings(db, a.id).length === 0)
      .map((a) => {
        const valuation = latestValuation(db, a.id);
        return valuation
          ? {
              id: a.id, name: a.name, subtype: a.subtype,
              value: valuation.value, asOf: valuation.asOf, stale: valuation.stale,
            }
          : null;
      })
      .filter((a): a is NonNullable<typeof a> => a !== null);

    return render(
      ctx, "Portfolio",
      renderPortfolio({
        rows, manualAssets,
        portfolioXirr: flows.length >= 2 ? xirr(flows) : null,
      }),
    );
  });

  // -------------------------------------------------------------------------
  // `07` F19.14 · CAS import. A MUST at P1 per Q17 and errata E10.
  // -------------------------------------------------------------------------

  router.get("/portfolio/cas", (ctx) => {
    requireAssets();
    auth(ctx);
    return render(ctx, "Import a CAS", renderCasUpload({
      accounts: casDestinations(db),
      error: ctx.query.get("error"),
    }));
  });

  router.post("/portfolio/cas", (ctx) => {
    requireAssets();
    const a = auth(ctx);

    const upload = fileField(ctx.req, "statement");
    if (!upload) {
      return render(ctx, "Import a CAS", renderCasUpload({
        accounts: casDestinations(db),
        error: "Choose the statement PDF first.",
      }));
    }

    // PR5 · The password lives exactly this long. It is read from the request,
    // handed to the parser, and never assigned to anything that outlives the
    // call — not the plan, not the stash, not the event log.
    const password = field(ctx.body, "password") ?? "";
    const accountId = requiredField(ctx.body, "account_id");

    let statement;
    try {
      statement = parseCasPdf(upload.bytes, password);
    } catch (error) {
      // A wrong password is the one failure worth naming precisely; everything
      // else is a file this app could not read, which is the same to the user.
      const message = error instanceof WrongPassword
        ? "That password did not open the statement. It is usually your PAN, in capitals."
        : `That file could not be read as a CAS. ${(error as Error).message}`;
      return render(ctx, "Import a CAS", renderCasUpload({
        accounts: casDestinations(db), error: message,
      }));
    }

    if (statement.schemes.length === 0) {
      return render(ctx, "Import a CAS", renderCasUpload({
        accounts: casDestinations(db),
        error:
          "That PDF opened, but no folios were found in it. If it is a CAS, " +
          "it may be a format this app has not seen — nothing was imported.",
      }));
    }

    const plan = planCasImport(db, statement, accountId);
    const token = newId();
    stashPlan(token, plan, a.member.id);

    const accountNames = new Map(listAssetAccounts(db).map((acc) => [acc.id, acc.name]));

    return render(ctx, "What this statement says", renderCasReview({
      period: plan.period,
      unparsed: plan.unparsed,
      totals: plan.totals,
      token,
      schemes: plan.schemes.map((scheme, index): CasReviewScheme => ({
        index,
        name: scheme.scheme.name,
        folio: scheme.scheme.folio,
        amc: scheme.scheme.amc,
        isin: scheme.scheme.isin,
        newInstrument: scheme.newInstrument,
        destination: scheme.accountId ? accountNames.get(scheme.accountId) ?? null : null,
        newLots: scheme.newLots,
        invested: scheme.invested,
        unitsDisagreement: scheme.unitsDisagreement,
        rows: scheme.rows.map((r) => ({
          date: r.row.date,
          kind: r.row.kind,
          description: r.row.description,
          amount: r.row.amount,
          units: r.row.units,
          nav: r.row.nav,
          status: r.status,
          note: r.note,
        })),
      })),
    }));
  });

  router.post("/portfolio/cas/confirm", (ctx) =>
    mutate(ctx, (a) => {
      requireAssets();

      const plan = takePlan(requiredField(ctx.body, "token"), a.member.id);
      if (!plan) {
        return {
          redirect: "/portfolio/cas?error=" + encodeURIComponent(
            "That statement is no longer open — read it again and confirm within half an hour.",
          ),
        };
      }

      const chosen = fieldList(ctx.body, "scheme").map(Number).filter(Number.isInteger);
      if (chosen.length === 0) {
        return { redirect: "/portfolio", message: "Nothing was ticked, so nothing was imported." };
      }

      const result = applyCasPlan(
        db, actorFor(a, "ui", ctx.req.headers["idempotency-key"] as string), plan, chosen,
      );

      const parts = [`${result.lots} ${result.lots === 1 ? "lot" : "lots"}`];
      if (result.sales > 0) {
        parts.push(`${result.sales} ${result.sales === 1 ? "redemption" : "redemptions"}`);
      }
      if (result.dividends > 0) {
        parts.push(`${result.dividends} ${result.dividends === 1 ? "payout" : "payouts"}`);
      }
      if (result.instruments > 0) {
        parts.push(`${result.instruments} new ${result.instruments === 1 ? "scheme" : "schemes"}`);
      }

      return {
        redirect: "/portfolio",
        message:
          `Recorded ${parts.join(", ")}. ` +
          `New schemes start on manual pricing — set a NAV source when you want live values.`,
      };
    }),
  );

  router.get("/portfolio/add", (ctx) => {
    requireAssets();
    const query = ctx.query.get("q") ?? "";
    const view = buildBudgetView(db);

    // The search is a server-side call (P7) and needs no key (§6.2).
    return Promise.resolve(
      query ? searchSchemes(query) : Promise.resolve([]),
    ).then((results) =>
      render(
        ctx, "Add a holding",
        renderAddHolding({
          assetAccounts: listAssetAccounts(db).map((a) => ({ id: a.id, name: a.name })),
          budgetAccounts: listAccounts(db)
            .filter((a) => a.kind === "budget")
            .map((a) => ({ id: a.id, name: a.nickname || a.name })),
          categories: [...view.categories.values()]
            .filter((c) => !c.isPaymentCategory && !c.hidden)
            .map((c) => ({ id: c.id, name: c.name })),
          searchResults: results,
          query,
          today: todayIST(),
        }),
      ),
    );
  });

  router.post("/portfolio/add", (ctx) =>
    mutate(ctx, (a) => {
      requireAssets();
      const actor = actorFor(a, "ui", ctx.req.headers["idempotency-key"] as string);

      const schemeCode = field(ctx.body, "scheme_code");
      const instrument = findOrCreateInstrument(db, actor, {
        name: requiredField(ctx.body, "name"),
        kind: (field(ctx.body, "kind") ?? "mutual-fund") as InstrumentKind,
        symbol: schemeCode ?? field(ctx.body, "symbol") ?? null,
        currency: field(ctx.body, "currency") || "INR",
        provider: schemeCode ? "mfapi" : "manual",
      });

      // Choosing a scheme from the search is step one; the purchase follows.
      if (field(ctx.body, "step") === "details") {
        return {
          redirect: `/portfolio/add?q=${encodeURIComponent(field(ctx.body, "name") ?? "")}`,
          message: `${instrument.name} is ready — enter the purchase below.`,
        };
      }

      const amountRaw = field(ctx.body, "amount");
      const unitPrice = Number(requiredField(ctx.body, "unit_price"));
      if (!Number.isFinite(unitPrice) || unitPrice <= 0) {
        throw new HttpError(400, "That price is not a number I can use.");
      }

      const feesRaw = field(ctx.body, "fees");
      const lot = recordPurchase(db, actor, {
        accountId: requiredField(ctx.body, "account_id"),
        instrumentId: instrument.id,
        tradeDate: parseDate(field(ctx.body, "trade_date") ?? "") ?? todayIST(),
        price: toUnitPrice(unitPrice),
        amount: amountRaw?.trim() ? amountField(amountRaw) : undefined,
        units: amountRaw?.trim() ? undefined : toUnits(Number(field(ctx.body, "units") ?? 0)),
        fees: feesRaw?.trim() ? amountField(feesRaw) : 0,
        fromAccountId: field(ctx.body, "from_account_id") || null,
        categoryId: field(ctx.body, "category_id") || null,
      });

      // R26.7: the purchase price seeds the history, so a holding is never
      // valueless just because no refresh has run yet.
      recordPrice(db, {
        instrumentId: instrument.id, price: lot.price,
        asOf: lot.tradeDate, source: "purchase",
      });

      return {
        redirect: "/portfolio",
        message: `Added ${formatUnits(lot.units)} units of ${instrument.name}.`,
      };
    }),
  );

  router.get("/portfolio/:id", (ctx) => {
    requireAssets();
    const view = viewHolding(db, ctx.params.id!);
    if (!view) throw new NotFound("That holding does not exist.");
    const account = listAssetAccounts(db).find((a) => a.id === view.holding.account_id);

    return render(
      ctx, view.instrument.name,
      renderHoldingDetail({
        view,
        accountName: account?.name ?? "",
        history: priceHistory(db, view.instrument.id, 40),
        today: todayIST(),
      }),
    );
  });

  router.get("/portfolio/:id/sell", (ctx) => {
    requireAssets();
    const view = viewHolding(db, ctx.params.id!);
    if (!view) throw new NotFound("That holding does not exist.");

    const unitsRaw = ctx.query.get("units") ?? "";
    const priceRaw = ctx.query.get("price") ?? (view.quote ? String(view.quote.price / 1_000_000) : "");

    let preview = null;
    if (unitsRaw && priceRaw) {
      const quantity = toUnits(Number(unitsRaw));
      const unitPrice = toUnitPrice(Number(priceRaw));
      if (quantity > 0 && unitPrice > 0 && quantity <= view.units) {
        preview = previewHoldingSale(db, view.holding.id, quantity, unitPrice, {
          saleDate: todayIST(),
        });
      }
    }

    return render(
      ctx, `Sell ${view.instrument.name}`,
      renderSalePreview({
        view, preview,
        unitsToSell: unitsRaw,
        priceInput: priceRaw,
        accounts: listAccounts(db)
          .filter((a) => a.kind === "budget")
          .map((a) => ({ id: a.id, name: a.nickname || a.name })),
        today: todayIST(),
      }),
    );
  });

  router.post("/portfolio/:id/sell", (ctx) =>
    mutate(ctx, (a) => {
      requireAssets();
      const holdingId = ctx.params.id!;
      const preview = recordSale(db, actorFor(a, "ui", ctx.req.headers["idempotency-key"] as string), {
        holdingId,
        units: toUnits(Number(requiredField(ctx.body, "units"))),
        price: toUnitPrice(Number(requiredField(ctx.body, "price"))),
        date: todayIST(),
        toAccountId: field(ctx.body, "to_account_id") || null,
      });

      return {
        redirect: "/portfolio",
        message:
          `Sold for ${formatPaise(preview.proceeds)} — realised ` +
          `${preview.realisedGain >= 0 ? "gain" : "loss"} ` +
          `${formatPaise(Math.abs(preview.realisedGain))}.`,
      };
    }),
  );

  /** F19.6 / P6 · A manual refresh, subject to the same ceiling. */
  router.post("/portfolio/refresh", async (ctx) => {
    requireAssets();
    const a = auth(ctx);
    let updated = 0;
    const problems: string[] = [];

    for (const instrument of listInstruments(db)) {
      if (instrument.manual_only === 1 || instrument.provider !== "mfapi" || !instrument.symbol) {
        continue;
      }
      const outcome = await mfapi.fetchPrice(instrument.symbol);
      execute(
        db,
        `INSERT INTO price_fetches (instrument_id, provider, requested_at, status, detail)
         VALUES (?,?,?,?,?)`,
        instrument.id, "mfapi", nowIST(),
        outcome.ok ? "ok" : outcome.reason,
        outcome.ok ? `${outcome.price} as of ${outcome.asOf}` : outcome.message,
      );

      if (outcome.ok) {
        // R26.5: a failure never overwrites a good cached price.
        recordPrice(db, {
          instrumentId: instrument.id, price: outcome.price,
          asOf: outcome.asOf, source: "mfapi",
        });
        updated++;
      } else {
        problems.push(`${instrument.name}: ${outcome.message}`);
      }
    }

    // R32: FX alongside, since a foreign holding needs both to be current.
    const usd = await fetchFxRate("USD", "INR");
    if (usd.ok) {
      execute(
        db,
        `INSERT INTO fx_rates (base, quote, as_of, rate, source, fetched_at) VALUES (?,?,?,?,?,?)
           ON CONFLICT(base, quote, as_of) DO UPDATE SET rate = excluded.rate`,
        "USD", "INR", usd.asOf, usd.price / 1_000_000, "frankfurter", nowIST(),
      );
    }

    appendEvent(db, actorFor(a, "job"), {
      entity: "prices", entityId: todayIST(), action: "refresh",
      after: { updated, problems: problems.length },
      summary: `Refreshed ${updated} prices` + (problems.length ? `, ${problems.length} failed` : ""),
    });

    return {
      redirect: withNotice(
        "/portfolio",
        problems.length === 0
          ? `Refreshed ${updated} prices.`
          : `Refreshed ${updated}. ${problems.length} couldn't be fetched — cached prices are still shown, with their dates.`,
      ),
    };
  });

  router.get("/net-worth", (ctx) => {
    requireAssets();
    const statement = netWorthStatement(db);
    const history = netWorthHistory(db);
    const previous = history.at(-2);

    return render(
      ctx, "Net worth",
      renderNetWorth({
        statement,
        change: previous ? netWorthChange(db, previous.as_of, todayIST()) : null,
        history,
      }),
    );
  });

  router.post("/net-worth/snapshot", (ctx) =>
    mutate(ctx, (a) => {
      requireAssets();
      const snapshot = snapshotNetWorth(db, actorFor(a));
      return {
        redirect: "/net-worth",
        message: `Recorded ${formatPaise(snapshot.net_worth)} as of ${snapshot.as_of}.`,
      };
    }),
  );

  router.post("/assets/new", (ctx) =>
    mutate(ctx, (a) => {
      requireAssets();
      const valueRaw = field(ctx.body, "value");
      const account = createAssetAccount(db, actorFor(a), {
        name: requiredField(ctx.body, "name"),
        subtype: requiredField(ctx.body, "subtype") as "physical",
        openingValue: valueRaw?.trim() ? amountField(valueRaw) : undefined,
        asOf: parseDate(field(ctx.body, "as_of") ?? "") ?? todayIST(),
      });
      return { redirect: "/portfolio", message: `Added ${account.name}.` };
    }),
  );

  // -------------------------------------------------------------------------
  // F27 · Health, F26 · backup, F15 · export
  // -------------------------------------------------------------------------
  function healthGroups(): HealthGroup[] {
    const backup = lastJobRun(db, "backup");
    const verification = lastJobRun(db, "restore-verification");
    const heartbeat = lastJobRun(db, "heartbeat");
    const backups = listBackups(config.backupDir);
    const errors24h =
      queryOne<{ n: number }>(
        db,
        `SELECT COUNT(*) AS n FROM job_runs WHERE status = 'failed' AND started_at >= ?`,
        addDays(todayIST(), -1),
      )?.n ?? 0;
    const queue = reviewCount(db);

    return [
      {
        name: "Application",
        checks: [
          {
            name: "Version",
            state: "healthy",
            reason: `0.1.0, running in ${config.environment}.`,
          },
          {
            // F23.13: in production this must always read "not present".
            name: "Development login bypass",
            state: devLoginModulePresent() ? (config.devLogin ? "failed" : "degraded") : "healthy",
            reason: devLoginModulePresent()
              ? config.devLogin
                ? "Present AND enabled — authentication is bypassed on this instance."
                : "Present in this build but disabled. A production image should not contain it at all."
              : "Not present in this build.",
          },
          {
            name: "Modules",
            state: "healthy",
            reason:
              `Loans ${config.features.loans ? "on" : "off"}, ` +
              `assets ${config.features.assets ? "on" : "off"}, ` +
              `multi-currency ${config.features.multiCurrency ? "on" : "off"}.`,
          },
        ],
      },
      {
        name: "Data",
        checks: [
          {
            name: "Database",
            state: "healthy",
            reason: `Connected. ${queryOne<{ n: number }>(db, `SELECT COUNT(*) AS n FROM transactions WHERE deleted_at IS NULL`)?.n ?? 0} transactions, ` +
              `${queryOne<{ n: number }>(db, `SELECT COUNT(*) AS n FROM events`)?.n ?? 0} events.`,
          },
          {
            name: "Review queue",
            state: queue === 0 ? "healthy" : queue > 25 ? "degraded" : "healthy",
            reason:
              queue === 0
                ? "Nothing waiting."
                : `${queue} item${queue === 1 ? "" : "s"} waiting for a decision.`,
            action: queue > 0 ? { label: "Open", href: "/review" } : null,
          },
        ],
      },
      {
        name: "Backup",
        checks: [
          {
            name: "Last backup",
            state: backup.status === "ok" ? "healthy" : backup.status === null ? "unknown" : "failed",
            reason:
              backup.status === null
                ? "No backup has run on this instance yet."
                : `${backups.length} kept. ${backup.detail ?? ""}`,
            lastRun: backup.lastRun,
            action: { label: "Back up now", href: "/health/backup" },
          },
          {
            // R40.3: the figure `08` J24 reads on a Sunday morning.
            name: "Last verified restore",
            state:
              verification.status === "ok" ? "healthy"
              : verification.status === null ? "unknown"
              : "failed",
            reason:
              verification.status === null
                ? "Never verified. Taking a backup is not the same as being able to recover — run this before real data lands."
                : verification.detail ?? "",
            lastRun: verification.lastRun,
            action: { label: "Verify now", href: "/health/verify" },
          },
          {
            name: "Failure alerts",
            state: config.backupWebhookUrl ? "healthy" : "degraded",
            reason: config.backupWebhookUrl
              ? "A webhook is configured, so a failed backup or verification will reach you."
              : "No webhook configured. A failed backup would only appear on this page.",
          },
          {
            // R40.8.3: shown beside the last verified restore, because it
            // covers the failure that one structurally cannot report.
            name: "Heartbeat to the outside world",
            state: !config.heartbeatUrl
              ? "degraded"
              : heartbeat.status === "ok" ? "healthy"
              : heartbeat.status === null ? "unknown"
              : "failed",
            reason: !config.heartbeatUrl
              ? "Not configured. If this machine goes down, nothing here survives to tell you — " +
                "an external monitor that alerts on a missing ping is the only thing that can."
              : heartbeat.detail ?? "Configured, but no verification has run yet.",
            lastRun: heartbeat.lastRun,
          },
        ],
      },
      {
        name: "Jobs",
        checks: [
          {
            name: "Errors in the last 24 hours",
            state: errors24h === 0 ? "healthy" : "degraded",
            reason: errors24h === 0 ? "None." : `${errors24h} job run${errors24h === 1 ? "" : "s"} failed.`,
          },
          {
            name: "Idempotency keys",
            state: "healthy",
            reason:
              `${queryOne<{ n: number }>(db, `SELECT COUNT(*) AS n FROM idempotency_keys`)?.n ?? 0} held. ` +
              `A high count is the fingerprint of a flaky network or a client retry bug.`,
          },
        ],
      },
    ];
  }

  router.get("/health", (ctx) => render(ctx, "Health", renderHealth(healthGroups())));

  router.post("/health/backup", (ctx) =>
    mutate(ctx, (a) => {
      const backup = createBackup(db, config.backupDir);
      recordJobRun(db, "backup", "ok", `${backup.path} (${backup.bytes} bytes)`);
      appendEvent(db, actorFor(a, "job"), {
        entity: "backup", entityId: backup.path, action: "create",
        summary: `Backed up to ${backup.path}`,
      });
      return { redirect: "/health", message: `Backed up ${backup.bytes} bytes.` };
    }),
  );

  router.post("/health/verify", (ctx) =>
    mutate(ctx, () => {
      const result = verifyRestore(db, config.backupDir);
      recordJobRun(db, "restore-verification", result.ok ? "ok" : "failed", result.summary);

      // Fired without awaiting: a slow monitor must not hold up the page, and
      // a ping that never arrives is itself the alert (R40.8.2).
      if (result.ok && config.heartbeatUrl) {
        void pingHeartbeat(config.heartbeatUrl).then((beat) =>
          recordJobRun(
            db, "heartbeat", beat.ok ? "ok" : "failed",
            beat.ok
              ? "Acknowledged by the external monitor."
              : "The monitor could not be reached. It will alert on the missing ping.",
          ),
        );
      }

      return { redirect: "/health", message: result.summary };
    }),
  );

  /** F15.1: the complete budget, in one action, in an open documented format. */
  router.get("/export.json", (ctx) => {
    auth(ctx);
    return {
      body: JSON.stringify(exportEverything(db), null, 2),
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename="budget-${todayIST()}.json"`,
      },
    };
  });

  router.get("/export.csv", (ctx) => {
    auth(ctx);
    return {
      body: exportTransactionsCsv(db),
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="transactions-${todayIST()}.csv"`,
      },
    };
  });

  /**
   * F27.3 · A machine-readable endpoint for external monitoring: one overall
   * status plus per-check detail.
   */
  router.get("/healthz", () => {
    const groups = healthGroups();
    const overall = overallState(groups);
    return {
      status: overall === "failed" ? 503 : 200,
      json: {
        status: overall,
        version: "0.1.0",
        checks: groups.flatMap((g) =>
          g.checks.map((c) => ({ group: g.name, name: c.name, state: c.state, reason: c.reason })),
        ),
      },
    };
  });

  return { router, middleware };

  function asset(body: string, type: string): Response {
    return {
      body,
      headers: {
        "Content-Type": `${type}; charset=utf-8`,
        // Static assets are code, not data — ordinary HTTP caching is
        // explicitly permitted by R35.
        "Cache-Control": "public, max-age=3600",
      },
    };
  }
}

/**
 * R7.g.3 · Say so when an edit rippled into later months, rather than leaving
 * the user to notice that a figure elsewhere moved.
 */
function rippleNote(recompute: RecomputeResult): string {
  const later = recompute.changed.filter((c) => c.readyToAssignBefore !== c.readyToAssignAfter);
  if (later.length === 0) return "";
  return ` This also changed ${later.length} later ${later.length === 1 ? "month" : "months"}.`;
}

/** DD-MM-YYYY for a date input, matching what parseDate accepts back (L3). */
function formatDateOut(date: string): string {
  return `${date.slice(8, 10)}-${date.slice(5, 7)}-${date.slice(0, 4)}`;
}

function numberOrNull(value: string | undefined): number | null {
  if (!value || value.trim() === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function renderErrorPage(status: number, message: string, theme: Theme = "system"): string {
  return page(
    { title: status === 404 ? "Not found" : "Something went wrong", theme, bare: true },
    status === 404
      ? renderNotFound()
      : html`
          <div class="card empty-state">
            <h2>Something went wrong</h2>
            <p>${message}</p>
            <p><a class="button" href="/">Back to the budget</a></p>
          </div>
        `,
  );
}
