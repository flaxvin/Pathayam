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
  revokeSession, recordAuthAttempt, isRateLimited, findMemberByEmail, getMember,
  type AuthContext,
} from "./auth/sessions.ts";
import {
  authenticateToken, tokenMayReach, checkTokenRateLimit,
  mintToken, listTokens, revokeToken, type TokenScope,
} from "./auth/tokens.ts";
import { beginOAuth, exchangeCode } from "./auth/google.ts";
import {
  beginGmailConnect, exchangeGmailCode, revokeToken as revokeGmailToken,
} from "./gmail/oauth.ts";
import {
  saveConnection, deleteConnection, connectionView, getConnection,
} from "./gmail/connection.ts";
import { fetchGmail } from "./gmail/fetch.ts";
import { withIdempotency, IdempotencyConflict } from "./core/idempotency.ts";
import { parseAmount, evaluateAmountExpression, formatPaise, type Paise } from "./core/money.ts";
import { parseDate, todayIST, nowIST, addDays, addMonths, monthOf, isMonthKey, formatMonth, type MonthKey } from "./core/dates.ts";
import { buildBudgetView, reviewCount } from "./web/viewmodel.ts";
import { renderBudget } from "./web/pages/budget.ts";
import {
  renderAccountList, renderAccountDetail, renderNewAccountForm, renderManageCards,
  renderCardStatementForm,
  type AccountRow, type RegisterRow,
} from "./web/pages/accounts.ts";
import {
  renderAddTransaction, renderTransfer, renderMoveMoney, renderAutoAssignPreview, renderHold,
  renderExplain, explainLineFor, renderNotFound,
} from "./web/pages/actions.ts";
import { renderReview, renderImport, renderMapping } from "./web/pages/review.ts";
import {
  parseStatementPdf, openStatement, BANKS,
  WrongPassword as StatementWrongPassword,
} from "./import/pdf-statements.ts";
import { passwordCandidates, describeCandidate } from "./import/statement-passwords.ts";
import { getIdentity, setIdentity, clearIdentity, maskedIdentity } from "./import/identity.ts";
import {
  recognise, saveProfile, listProfiles, markProfileUsed, deleteProfile,
  mappingFromSelections, validateMapping, columnChoices, candidateHeaderRows, looksMappable,
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
  createAccount, listAccounts, getAccount, listCards, createCard, closeCard,
  recordCardStatement, lastCardStatement, paymentCategoryFor,
  MANAGED_SUBTYPES, SUBTYPE_LABELS,
  type AccountKind,
} from "./domain/accounts.ts";
import {
  setAssigned, addAssigned, copyAssignmentsFromMonth, moveMoney, setHeld, getHeld,
  listCategories, getCategory,
} from "./domain/budget.ts";
import {
  createTransaction, createTransfer, updateTransaction, deleteTransaction,
  getTransaction, getSplits, listPayees, payeeStats, tagsFor,
} from "./domain/transactions.ts";
import {
  accountBalances, creditOutstanding, householdSettings,
} from "./engine/repository.ts";
import {
  suggestCoverSources, cardFunding,
  type AutoAssignPlan, type AutoAssignProposal,
} from "./engine/engine.ts";
import {
  historyFor, queryEvents, appendEvent, checkUndo, undoEvent, DEFAULT_UNDO_WINDOW_DAYS,
  type Actor,
} from "./core/events.ts";
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
  renderPrepaymentComparison, renderLoanStatementForm,
} from "./web/pages/loans.ts";
import {
  createLoan, listLoans, getLoan, projectLoan, recordInstalment, listPayments,
  recordDisbursement, recordLoanStatement,
  listDisbursements, listRatePeriods, debtOverview, type LoanType,
} from "./domain/loans.ts";
import { comparePrepayment, NegativeAmortisation } from "./loans/amortisation.ts";
import {
  renderQuery, renderReports, renderSchedules, renderNewScheduleForm, renderGoals,
} from "./web/pages/analysis.ts";
import { renderOverview } from "./web/pages/overview.ts";
import {
  queryTransactions, groupTotals, periodPresets, periodFor, incomeVsExpense,
  loanInterestByFinancialYear, categoryTrend, spendingCalendar, spendByTag, rowsToCsv,
  type GroupBy, type TransactionFilter,
} from "./domain/reports.ts";
import { spendingInsights, type Insight } from "./domain/insights.ts";
import {
  listSchedules, createSchedule, markPaid, skipOccurrence, detectSchedules,
  projectCashflow, describeCashflow, subscriptions, type Recurrence,
} from "./domain/schedules.ts";
import { listGoals, createGoal, updateGoal, deleteGoal, goalCategoryIds, goalProgress, completeGoal } from "./domain/goals.ts";
import {
  renderMore, renderPayees, renderRules, renderCategories, renderFirstRun,
  renderTokens,
  type PayeeRow, type RuleRow,
} from "./web/pages/manage.ts";
import { renderPrivacy, renderTerms } from "./web/pages/legal.ts";
import { renderActivity } from "./web/pages/activity.ts";
import { countRequestFailures, recentRequestFailures } from "./ops/errors.ts";

/**
 * The date shown on the legal pages. It is a constant rather than "today"
 * because a policy that claims to have been updated every time it is rendered
 * tells the reader nothing. Bump it when the text changes.
 */
const LEGAL_UPDATED = "11 September 2026";
import { loadRules } from "./import/pipeline.ts";
import { testRule, type Rule, type RuleSubject, extractNarrationFields } from "./import/rules.ts";
import {
  applyStartingTemplate, startBlank,
} from "./domain/starting-budget.ts";
import {
  mergePayees, getPayee, resolvePayee, UndoRefused,
} from "./domain/transactions.ts";
import {
  createCategory, renameCategory, moveCategoryToGroup, setCategoryHidden, deleteCategory,
  setTarget, clearTarget, getTarget, createGroup, renameGroup, listGroups,
  reorderCategory, reorderGroup,
} from "./domain/budget.ts";
import {
  monthCloseView, closeMonth, reopenMonth, closedMonths, monthAwaitingClose, isClosed,
} from "./domain/month-close.ts";
import {
  addAttachment, listAttachments, deleteAttachment,
  getBytes as getAttachmentBytes,
} from "./domain/attachments.ts";
import {
  createFamilyLoan, recordAdvance, recordRepayment, viewFamilyLoan,
  writeOffFamilyLoan, closeFamilyLoan, listFamilyLoans,
} from "./domain/family-loans.ts";
import { renderFamilyLoans, renderFamilyLoan } from "./web/pages/family-loans.ts";
import {
  digestFor, mutedKinds, setMutedKinds, DIGEST_KINDS, type DigestKind,
} from "./domain/digest.ts";
import {
  renderMonthClose, renderClosedMonths, renderDigest, renderDigestSettings,
  renderStatementIdentity, renderGmailConnection,
} from "./web/pages/month-close.ts";
import {
  renderPortfolio, renderHoldingDetail, renderSalePreview, renderNetWorth,
  renderAllocation,
  renderAddHolding, renderCasUpload, renderCasReview,
  renderNewAssetForm, renderRevalueAsset, renderManualPrice,
  type PortfolioRow, type CasReviewScheme,
} from "./web/pages/portfolio.ts";
import { parseCasPdf, WrongPassword } from "./import/cas.ts";
import {
  planCasImport, applyCasPlan, casDestinations, stashPlan, takePlan,
} from "./import/cas-plan.ts";
import {
  createAssetAccount, listAssetAccounts, findOrCreateInstrument, recordPurchase,
  recordSale, recordPrice, recordValuation, latestValuation, listHoldings, viewHolding,
  priceHistory, previewHoldingSale, getInstrument, listInstruments,
  classifyInstrument, ASSET_CLASSES, ASSET_CLASS_LABELS,
  exportHoldingsCsv, exportLotsCsv, exportPriceHistoryCsv, exportNetWorthCsv,
  type InstrumentKind,
} from "./domain/assets.ts";
import {
  netWorthStatement, snapshotNetWorth, netWorthChange, netWorthHistory,
  assetAllocation,
} from "./domain/networth.ts";
import {
  units as toUnits, price as toUnitPrice, xirr, formatUnits,
} from "./portfolio/holdings.ts";
import { searchSchemes } from "./portfolio/providers.ts";
import { refreshPrices } from "./portfolio/refresh.ts";

export interface AppDeps {
  db: DB;
  config: Config;
  /** Injected so tests can drive the OAuth exchange without a network call. */
  fetchImpl?: typeof fetch;
}

// `/privacy` and `/terms` are public because Google's OAuth reviewer fetches
// both while signed out; a sign-in redirect there fails verification for the
// restricted `gmail.readonly` scope.
const PUBLIC_PATHS = new Set([
  "/signin", "/auth/google", "/auth/google/callback", "/auth/dev", "/healthz",
  "/privacy", "/terms",
]);
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
      let auth = authenticate(db, cookies[SESSION_COOKIE] ?? null);

      // F30 · A bearer token authenticates as its member, but is a narrower
      // thing than a session: it cannot reach the routes in F30.6's list, it
      // is rate-limited separately (F30.7), and a read-only one cannot write.
      const bearer = authenticateToken(db, ctx.req.headers.authorization);
      if (bearer && !auth) {
        if (!tokenMayReach(path)) {
          return {
            status: 403,
            json: {
              error:
                "An API token cannot reach this. Tokens cannot sign in, impersonate, " +
                "mint other tokens, or change who is allowed in.",
            },
          };
        }

        const limit = checkTokenRateLimit(bearer.token.id);
        if (!limit.allowed) {
          return {
            status: 429,
            headers: { "Retry-After": String(limit.retryAfterSeconds) },
            json: { error: "That token is going too fast. Try again shortly." },
          };
        }

        if (ctx.method !== "GET" && bearer.scope === "read") {
          return { status: 403, json: { error: "That token is read-only." } };
        }

        const member = getMember(db, bearer.token.member_id);
        if (member) {
          // F30.5 · Attributed to the member, naming the token.
          ctx.locals.token = bearer.token;
          auth = {
            session: {
              id: `token:${bearer.token.id}`, member_id: member.id,
              created_at: bearer.token.created_at, last_seen_at: nowIST(),
              expires_at: bearer.token.expires_at ?? "9999-12-31",
              user_agent: null, ip_hint: null, revoked_at: null,
              impersonating_member_id: null, impersonation_writes: 0,
              impersonation_expires_at: null,
            } as never,
            member,
            viewingAs: member,
            impersonating: false,
            canWrite: bearer.scope === "read-write",
          };
        }
      }

      ctx.locals.auth = auth;

      if (PUBLIC_PATHS.has(path)) return;
      if (!auth) {
        if (wantsJson(ctx)) return { status: 401, json: { error: "Your session has expired." } };
        return { redirect: `/signin?next=${encodeURIComponent(path)}` };
      }

      // R38.10: impersonation is read-only unless the toggle was set. The
      // check lives here so no handler can be the one that forgets it.
      // B51: `/impersonate/writes` must pass even in read-only mode — it *is*
      // the toggle. Blocking it (as this did) made read-only impersonation a
      // one-way door, contradicting the error's own "Enable writes first".
      const IMPERSONATION_CONTROLS = new Set(["/impersonate/exit", "/impersonate/writes"]);
      if (ctx.method !== "GET" && !auth.canWrite && !IMPERSONATION_CONTROLS.has(path)) {
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
  /** F30.5 · Names the token on every event a token request causes. */
  function actorSource(ctx: RequestContext): { source: "ui" | "api"; detail: string | null } {
    const token = ctx.locals.token as { name: string } | undefined;
    return token ? { source: "api", detail: token.name } : { source: "ui", detail: null };
  }

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
  const pendingGmail = new Map<string, { verifier: string; memberId: string; at: number }>();

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
          <p class="faint" style="margin-top:1.5rem;text-align:center">
            <a href="/terms">Terms of service</a> · <a href="/privacy">Privacy policy</a>
          </p>
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

  // -------------------------------------------------------------------------
  // R37 · Activity, and the only route to universal undo
  //
  // The undo machinery — a registered handler per entity, the supersession
  // check, the append-only inverse — has been complete and tested since early
  // on, but nothing in the web layer called it, so the only thing a household
  // could actually undo was a whole import batch. This is the door.
  // -------------------------------------------------------------------------
  router.get("/activity", (ctx) => {
    auth(ctx);
    const entity = ctx.query.get("entity");
    const events = queryEvents(db, { entity: entity ?? undefined, limit: 100 });

    const entities = queryAll<{ entity: string }>(
      db, `SELECT DISTINCT entity FROM events ORDER BY entity`,
    ).map((r) => r.entity);

    return render(
      ctx, "Activity",
      renderActivity({
        entity,
        entities,
        windowDays: DEFAULT_UNDO_WINDOW_DAYS,
        rows: events.map((e) => {
          const check = checkUndo(db, e.id);
          return {
            id: e.id,
            at: e.at,
            summary: e.summary ?? "",
            entity: e.entity,
            action: e.action,
            actor: memberName(e.actorMemberId),
            onBehalfOf: e.realMemberId && e.realMemberId !== e.actorMemberId
              ? memberName(e.realMemberId)
              : null,
            source: e.source,
            blockedReason: check.ok ? null : check.reason ?? "This cannot be undone.",
            supersededBy: check.supersededBy.map((s) => ({
              at: s.at,
              summary: s.summary ?? `${s.action} ${s.entity}`,
            })),
            isUndo: Boolean(e.undoOfEventId),
            undone: Boolean(e.undoneByEventId),
          };
        }),
      }),
    );
  });

  router.post("/activity/:id/undo", (ctx) =>
    mutate(ctx, (a) => {
      const force = field(ctx.body, "force") === "1";
      let result;
      try {
        result = undoEvent(
          db, ctx.params.id!, actorFor(a, "ui", ctx.req.headers["idempotency-key"] as string),
          { force },
        );
      } catch (err) {
        // B65 · A handler refuses when the record is load-bearing for something
        // derived. That is an answer, not a fault — 422, so the client shows it
        // instead of retrying it as a server error.
        if (err instanceof UndoRefused) throw new HttpError(422, err.message);
        throw err;
      }
      // R37.9 · A refusal is the app protecting later work. It is deliberately
      // *not* 409: the client treats 409 as "the first attempt may still be in
      // flight" and retries it, which turned a clear refusal into five silent
      // retries and a network error.
      if (!result.ok) {
        throw new HttpError(422, result.reason ?? "That change could not be undone.");
      }
      return {
        redirect: "/activity",
        message: result.undoEvent?.summary ?? "Undone.",
      };
    }),
  );

  // Required by Google's OAuth consent screen, and linked from sign-in and
  // Settings so a member can read them without hunting for a URL.
  router.get("/privacy", (ctx) =>
    render(ctx, "Privacy policy", renderPrivacy({ appName: "Budget", updated: LEGAL_UPDATED }), { bare: true }),
  );

  router.get("/terms", (ctx) =>
    render(ctx, "Terms of service", renderTerms({ appName: "Budget", updated: LEGAL_UPDATED }), { bare: true }),
  );

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
        readyToAssign: view.monthState.readyToAssign,
      }),
    );
  });

  router.post("/move", (ctx) =>
    mutate(ctx, (a) => {
      const month = monthParam(ctx);
      const actor = actorFor(a, "ui", ctx.req.headers["idempotency-key"] as string);
      const from = requiredField(ctx.body, "from_category_id");
      const to = requiredField(ctx.body, "to_category_id");
      const amount = amountField(field(ctx.body, "amount"));

      // B55: "Ready to Assign" is a valid source. Funding a category from it is
      // just assigning income that had no job yet — so it adds to the target's
      // assignment (which reduces RTA), rather than moving between two envelopes.
      if (from === "rta") {
        if (amount <= 0) throw new HttpError(400, "Enter an amount greater than zero.");
        const { recompute } = withForwardRecompute(
          db, actor, { month, cause: "Assigned from Ready to Assign" },
          () => addAssigned(db, actor, month, to, amount),
        );
        return { redirect: `/?month=${month}`, message: "Assigned from Ready to Assign." + rippleNote(recompute) };
      }

      const { recompute } = withForwardRecompute(
        db, actor, { month, cause: "Moved money between categories" },
        () =>
          moveMoney(db, actor, {
            month,
            fromCategoryId: from,
            toCategoryId: to,
            amount,
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

  // F3.9 · Fill this month's empty categories from last month's assignments.
  router.post("/copy-last-month", (ctx) =>
    mutate(ctx, (a) => {
      const month = monthParam(ctx);
      const actor = actorFor(a, "ui", ctx.req.headers["idempotency-key"] as string);
      const { recompute, result } = withForwardRecompute(
        db, actor, { month, cause: "Filled from last month's budget" },
        () => copyAssignmentsFromMonth(db, actor, month, addMonths(month, -1)),
      );
      const msg = result.filled === 0
        ? "Nothing to fill — last month had no assignments the empty categories could take."
        : `Filled ${result.filled} ${result.filled === 1 ? "category" : "categories"} with ${formatPaise(result.total)} from last month.`;
      return { redirect: `/?month=${month}`, message: msg + rippleNote(recompute) };
    }),
  );

  // B58 · Auto-assign funds each category to its target (the "budget"), in order,
  // from Ready to Assign until it runs out. It reads the targets set on the
  // Categories screen — there is no separate, hidden rules system to configure.
  function buildAutoAssignPlan(month: MonthKey): AutoAssignPlan {
    const view = buildBudgetView(db, month);
    const rtaBefore = view.monthState.readyToAssign;
    let remaining = rtaBefore;
    const proposals: AutoAssignProposal[] = [];
    for (const c of view.categories.values()) {
      if (remaining <= 0) break;
      // Hidden categories are out (F3.2); payment categories are funded by the
      // card mechanic, not a target.
      if (c.hidden || c.isPaymentCategory) continue;
      const underfunded = c.progress?.underfunded ?? 0;
      if (underfunded <= 0) continue;
      const grant = Math.min(underfunded, remaining) as Paise;
      remaining -= grant;
      proposals.push({
        categoryId: c.id,
        from: c.state.assigned,
        to: (c.state.assigned + grant) as Paise,
        delta: grant,
        reason: "to its target",
        limitedByAvailableFunds: grant < underfunded,
      });
    }
    const totalAssigned = proposals.reduce((s, p) => s + p.delta, 0) as Paise;
    return { proposals, totalAssigned, rtaBefore, rtaAfter: (rtaBefore - totalAssigned) as Paise };
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
        // S15 · A recent running-balance series for an inline sparkline. Walk
        // the last few dozen transactions back from the current balance.
        balanceSeries: (() => {
          const recent = queryAll<{ amount: number }>(
            db,
            `SELECT amount FROM transactions WHERE account_id = ? AND deleted_at IS NULL
              ORDER BY date DESC, created_at DESC LIMIT 24`,
            account.id,
          );
          if (recent.length < 2) return undefined;
          let bal = balances.get(account.id)!.working;
          const series = [bal];
          for (const t of recent) { bal -= t.amount; series.push(bal); }
          return series.reverse();
        })(),
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
      const subtype = requiredField(ctx.body, "subtype");

      // B56: a family loan or a loan is created through its own screen, which
      // also writes the companion record the Lending / Loans pages read. Making
      // one here would be an orphan account, so refuse and point the way.
      const managed = MANAGED_SUBTYPES[subtype];
      if (managed) {
        throw new HttpError(
          400,
          `A ${SUBTYPE_LABELS[subtype] ?? subtype} is set up on ${managed.label} ` +
          `(${managed.where}), which records more than a balance. Add it there instead.`,
        );
      }

      let opening = openingRaw?.trim() ? amountField(openingRaw, "Current balance") : 0;

      // F2.6: a credit card's balance is what you owe. Entering it as a
      // positive figure is the obvious slip, so take it as intended rather
      // than rejecting it.
      if (kind === "credit" && opening > 0) opening = -opening;

      const account = createAccount(db, actorFor(a, "ui", ctx.req.headers["idempotency-key"] as string), {
        name: requiredField(ctx.body, "name"),
        kind,
        subtype,
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
        lastStatement: (() => {
          if (account.kind !== "credit") return null;
          const st = lastCardStatement(db, account.id);
          return st ? { amount: st.amount, date: st.statement_date, due: st.due_date } : null;
        })(),
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

  // B51: the form that was missing — POST /transfer shipped, but no GET
  // rendered a form and the only link 405'd. Transfers underpin card payments,
  // asset purchases and family lending.
  router.get("/transfer", (ctx) => {
    auth(ctx);
    const accounts = listAccounts(db);
    return render(
      ctx,
      "Record a transfer",
      renderTransfer({
        accounts,
        defaultFrom: ctx.query.get("from"),
        defaultTo: ctx.query.get("to"),
        today: todayIST(),
      }),
    );
  });

  router.post("/transfer", (ctx) =>
    mutate(ctx, (a) => {
      const fromAccountId = requiredField(ctx.body, "from_account_id");
      const toAccountId = requiredField(ctx.body, "to_account_id");
      if (fromAccountId === toAccountId) {
        throw new HttpError(400, "A transfer needs two different accounts.");
      }
      createTransfer(db, actorFor(a, "ui", ctx.req.headers["idempotency-key"] as string), {
        fromAccountId,
        toAccountId,
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

  // B51: the command palette's "Toggle theme" linked here, but no route
  // existed, so it 404'd. A quick flip between light and dark (anything not
  // already dark becomes dark), stored against the real member, returning to
  // where the user was.
  router.get("/settings/theme-toggle", (ctx) => {
    const a = auth(ctx);
    const next: Theme = a.viewingAs.theme === "dark" ? "light" : "dark";
    setTheme(db, actorFor(a), a.member.id, next);
    const referer = ctx.req.headers.referer;
    return { redirect: referer && referer.startsWith(config.baseUrl) ? referer : "/" };
  });

  router.post("/impersonate/start", (ctx) =>
    mutate(ctx, (a) => {
      startImpersonation(db, actorFor(a), a.session.id, requiredField(ctx.body, "member_id"));
      return { redirect: "/", message: "Now viewing as another member, read only." };
    }),
  );

  router.post("/impersonate/writes", (ctx) =>
    mutate(ctx, (a) => {
      const allow = field(ctx.body, "allow") === "1";
      setImpersonationWrites(db, actorFor(a), a.session.id, allow);
      // B51: return to where the toggle was clicked (the banner is on every
      // page), not always /settings.
      const returnTo = field(ctx.body, "return_to");
      return {
        redirect: returnTo && returnTo.startsWith("/") ? returnTo : "/settings",
        message: allow ? "Writes enabled while viewing as them." : "Back to read-only.",
      };
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

        ${renderGmailConnection(connectionView(db, a.member.id), config.google.clientId !== null)}

        ${renderStatementIdentity(maskedIdentity(db, a.member.id))}

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
          <h2>About</h2>
          <p class="faint">
            <a href="/terms">Terms of service</a> ·
            <a href="/privacy">Privacy policy</a>
          </p>
          <p class="faint">
            The privacy policy is what Google's consent screen points at, and it
            describes exactly what the Gmail connection reads and keeps.
          </p>
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
          <h2>Receipts</h2>
          ${listAttachments(db, transaction.id).map(
            (att) => html`
              <div class="row-between" style="padding:.4rem 0;border-top:1px solid var(--border)">
                <a href="/attachment/${att.id}" target="_blank" rel="noopener">
                  ${att.mime.startsWith("image/") ? "🖼" : "📄"} ${att.filename}
                  <span class="faint">${Math.round(att.size / 1024)} KB</span>
                </a>
                <form method="post" action="/attachment/${att.id}/delete">
                  <button class="button-small button-danger" type="submit">Remove</button>
                </form>
              </div>
            `,
          )}
          <form method="post" action="/transaction/${transaction.id}/attach"
                enctype="multipart/form-data" style="margin-top:.6rem">
            <div class="field">
              <label for="receipt">Add a photo or PDF</label>
              <input id="receipt" name="receipt" type="file"
                     accept="image/*,application/pdf" capture="environment" required>
              <p class="field-hint">
                Stored on your server only — never on this device, and fetched
                fresh each time you look.
              </p>
            </div>
            <button type="submit">Attach</button>
          </form>
        </section>

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

  // -------------------------------------------------------------------------
  // Q10 · Receipt attachments.
  // -------------------------------------------------------------------------

  router.post("/transaction/:id/attach", (ctx) => {
    const a = auth(ctx);
    const id = ctx.params.id!;
    const upload = fileField(ctx.req, "receipt");
    if (!upload) {
      return { redirect: withNotice(`/transaction/${id}`, "Choose a photo or PDF first.") };
    }
    addAttachment(db, actorFor(a, "ui", ctx.req.headers["idempotency-key"] as string), {
      transactionId: id, filename: upload.filename, bytes: upload.bytes,
    });
    return { redirect: withNotice(`/transaction/${id}`, "Receipt attached.") };
  });

  /**
   * R35 · Served with no-store, so no device ever caches a receipt. There is
   * no client copy; every look is a fresh fetch from the server.
   */
  router.get("/attachment/:id", (ctx) => {
    auth(ctx);
    const found = getAttachmentBytes(db, ctx.params.id!);
    if (!found) throw new NotFound("That attachment does not exist.");
    return {
      body: Buffer.from(found.bytes),
      headers: {
        "Content-Type": found.meta.mime,
        "Content-Disposition": `inline; filename="${found.meta.filename.replace(/"/g, "")}"`,
        "Cache-Control": "no-store, private",
        "Content-Length": String(found.bytes.length),
      },
    };
  });

  router.post("/attachment/:id/delete", (ctx) =>
    mutate(ctx, (a) => {
      const transactionId = deleteAttachment(db, actorFor(a), ctx.params.id!);
      return {
        redirect: transactionId ? `/transaction/${transactionId}` : "/",
        message: "Receipt removed.",
      };
    }),
  );

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

  // B51: manage the cards on an account, including add-on cards (F2.9). The
  // "Manage cards" button linked here, but no route existed.
  router.get("/accounts/:id/cards", (ctx) => {
    auth(ctx);
    const account = getAccount(db, ctx.params.id!);
    if (!account) throw new NotFound("That account does not exist.");
    return render(
      ctx, `Cards on ${account.name}`,
      renderManageCards({
        account,
        cards: listCards(db, account.id, { includeClosed: false }),
        members: listMembers(db).map((m) => ({ id: m.id, name: m.name })),
      }),
    );
  });

  router.post("/accounts/:id/cards", (ctx) =>
    mutate(ctx, (a) => {
      const account = getAccount(db, ctx.params.id!);
      if (!account) throw new NotFound("That account does not exist.");
      const last4 = (field(ctx.body, "last4") ?? "").replace(/\D/g, "") || null;
      createCard(db, actorFor(a), {
        accountId: account.id,
        label: requiredField(ctx.body, "label"),
        last4,
        isPrimary: false,
        holderMemberId: field(ctx.body, "holder_member_id") || null,
      });
      return { redirect: `/accounts/${account.id}/cards`, message: "Card added." };
    }),
  );

  router.post("/accounts/:id/cards/:cardId/close", (ctx) =>
    mutate(ctx, (a) => {
      const account = getAccount(db, ctx.params.id!);
      if (!account) throw new NotFound("That account does not exist.");
      closeCard(db, actorFor(a), ctx.params.cardId!);
      return { redirect: `/accounts/${account.id}/cards`, message: "Card closed." };
    }),
  );

  // F2.3 · Record a credit-card statement, so funding advice keys off the real
  // billing cycle rather than the calendar month.
  router.get("/accounts/:id/statement", (ctx) => {
    auth(ctx);
    const account = getAccount(db, ctx.params.id!);
    if (!account) throw new NotFound("That account does not exist.");
    if (account.kind !== "credit") throw new NotFound("Only a credit card has a statement.");
    return render(
      ctx, `Statement — ${account.name}`,
      renderCardStatementForm({
        account,
        last: lastCardStatement(db, account.id),
        today: todayIST(),
      }),
    );
  });

  router.post("/accounts/:id/statement", (ctx) =>
    mutate(ctx, (a) => {
      const account = getAccount(db, ctx.params.id!);
      if (!account) throw new NotFound("That account does not exist.");
      const minRaw = field(ctx.body, "minimum_due");
      recordCardStatement(db, actorFor(a), {
        accountId: account.id,
        statementDate: parseDate(field(ctx.body, "statement_date") ?? "") ?? todayIST(),
        dueDate: parseDate(requiredField(ctx.body, "due_date")) ?? todayIST(),
        amount: Math.abs(amountField(requiredField(ctx.body, "amount"))),
        minimumDue: minRaw?.trim() ? Math.abs(amountField(minRaw)) : null,
      });
      return { redirect: `/accounts/${account.id}`, message: "Statement recorded." };
    }),
  );

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
      banks: BANKS.map((b) => ({ id: b.id, name: b.name, passwordHint: b.passwordHint })),
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
   * `04` §3.3 · A statement PDF.
   *
   * It converges on `ingest()` like every other source, so dedupe, rules, the
   * review queue and the auto-approve gate are shared rather than reimplemented
   * — `04` §1's whole point.
   */
  router.post("/import/pdf", (ctx) => {
    const a = auth(ctx);
    const accountId = requiredField(ctx.body, "account_id");
    const upload = fileField(ctx.req, "statement");

    const importPage = (error: string) =>
      render(ctx, "Import", renderImport({
        accounts: listAccounts(db),
        batches: listBatches(db),
        profiles: listProfiles(db).map((p) => ({
          id: p.id, name: p.name, last_used_at: p.last_used_at,
        })),
        casEnabled: config.features.assets,
        banks: BANKS.map((b) => ({ id: b.id, name: b.name, passwordHint: b.passwordHint })),
        error,
      }));

    if (!upload) return importPage("Choose the statement PDF first.");

    /*
     * A typed password wins; otherwise the stored identity derives candidates
     * (`10` §3.6). Typing one is still the path for a household that has not
     * opted in, and PR5's original shape — used once, never persisted — is
     * exactly what happens on that path.
     */
    const typed = field(ctx.body, "password") ?? "";
    const identity = getIdentity(db, a.member.id);

    let parsed;
    let opened = "";
    try {
      if (typed !== "") {
        parsed = parseStatementPdf(upload.bytes, typed);
      } else if (identity) {
        // F2.9 · The destination account already stores the card/account's
        // last four digits (for SMS matching), which is exactly what Canara's
        // and SBI Card's passwords need. Hand them to the derivation.
        const account = getAccount(db, accountId);
        const result = openStatement(
          upload.bytes,
          passwordCandidates(identity, undefined, { cardDigits: [account?.last4] }),
        );
        if (!result) throw new StatementWrongPassword();
        parsed = result.parse;
        opened = ` It opened with ${describeCandidate(result.candidate, identity)}.`;
      } else {
        parsed = parseStatementPdf(upload.bytes, "");
      }
    } catch (error) {
      return importPage(
        error instanceof StatementWrongPassword
          ? (identity
              ? "None of the passwords worked out from your saved details opened this. " +
                "Type it below, or check the details in Settings."
              : "That statement needs a password. The hints below say what each bank uses — " +
                "or save your details in Settings and the app will work it out.")
          : `That file could not be read. ${(error as Error).message}`,
      );
    }

    // `04` §3.2's rule, applied to PDFs: a file this app cannot read is a
    // mapping task, not an error. The extracted rows go to the same screen an
    // unrecognised CSV goes to.
    if (parsed.records.length === 0) {
      const rows = parsed.text.split("\n").map((line) => line.split(/\s{2,}/));

      // B64 · A mapping task needs columns to map. A scanned statement has
      // none, and the mapping screen would offer "Column 1" for every field
      // above a table of nothing. Say what is actually wrong instead.
      if (!looksMappable(rows)) {
        return importPage(
          "There is no text in that PDF to read — it is almost certainly a scan " +
          "or an image rather than a statement with selectable text. Ask the bank " +
          "for the text version (net banking usually offers one), or import the " +
          "CSV instead.",
        );
      }

      const headerRow = candidateHeaderRows(rows)[0]?.index ?? 0;
      return render(
        ctx, "Which column is which?",
        renderMapping({
          accountId,
          fileName: upload.filename,
          csv: rows.map((r) => r.join("\t")).join("\n"),
          rows,
          candidateHeaders: candidateHeaderRows(rows),
          headerRow,
          choices: columnChoices(rows, headerRow),
        }),
      );
    }

    const outcome = ingest(db, actorFor(a, "ui", ctx.req.headers["idempotency-key"] as string), {
      accountId,
      source: "pdf",
      adapter: parsed.bank?.id ?? "pdf",
      fileName: upload.filename,
      records: parsed.records,
      errors: parsed.errors,
      rowsRead: parsed.rowsRead,
    });

    const parts: string[] = [];
    if (outcome.staged > 0) parts.push(`${outcome.staged} to review`);
    if (outcome.autoApproved > 0) parts.push(`${outcome.autoApproved} auto-approved`);
    if (outcome.duplicates > 0) parts.push(`${outcome.duplicates} suspected duplicates`);
    if (outcome.skipped > 0) parts.push(`${outcome.skipped} already present`);
    if (parsed.errors.length > 0) parts.push(`${parsed.errors.length} unreadable rows`);

    // The statement's own closing balance, which is the strongest confirmation
    // available that every row was read and read correctly.
    const reconciled = parsed.reconciliation?.ok
      ? " It reconciles against the statement's own closing balance."
      : parsed.reconciliation
        ? ` It does not reconcile — off by ${formatPaise(Math.abs(parsed.reconciliation.difference))}, ` +
          `so a row is probably missing. Check before approving.`
        : "";

    // Not wrapped in `mutate()` — this handler renders a page on failure, and
    // `mutate` can only redirect — so the notice is built here.
    return {
      redirect: withNotice(
        outcome.staged > 0 ? "/review" : "/import",
        `Read ${parsed.bank ? `your ${parsed.bank.name} statement` : "the statement"} — ` +
          `${parts.join(", ")}.${opened}${reconciled}`,
      ),
    };
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
        interestModel: (field(ctx.body, "interest_model") ?? "reducing") as
          "reducing" | "flat" | "moratorium-serviced" | "moratorium-capitalised",
        annualRatePct: Number(requiredField(ctx.body, "annual_rate")),
        tenureMonths: Number(requiredField(ctx.body, "tenure_months")),
        moratoriumMonths: Number(field(ctx.body, "moratorium_months") ?? "0") || 0,
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
        budgetAccounts: listAccounts(db)
          .filter((acc) => acc.kind === "budget" && !acc.closed_at)
          .map((acc) => ({ id: acc.id, name: acc.name })),
      }),
    );
  });

  /** R15 · Record a tranche. */
  router.post("/loans/:id/disburse", (ctx) =>
    mutate(ctx, (a) => {
      const loanId = ctx.params.id!;
      const dateRaw = field(ctx.body, "date");
      const destination = field(ctx.body, "destination") === "budget-account"
        ? "budget-account" : "third-party";
      recordDisbursement(db, actorFor(a, "ui", ctx.req.headers["idempotency-key"] as string), {
        loanId,
        amount: Math.abs(amountField(requiredField(ctx.body, "amount"))),
        date: dateRaw ? parseDate(dateRaw) ?? todayIST() : todayIST(),
        destination,
        destinationAccountId: destination === "budget-account"
          ? field(ctx.body, "destination_account_id") || null : null,
      });
      return {
        redirect: `/loans/${loanId}`,
        message: destination === "third-party"
          ? "Recorded — your liability rose and your budget is untouched."
          : "Recorded — the money is in your account and waiting to be assigned.",
      };
    }),
  );

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

  // B51: record a lender statement to resolve drift (R18.8). The drift
  // warning's "Resolve it" link pointed here, but no route existed.
  router.get("/loans/:id/statement", (ctx) => {
    requireLoans();
    auth(ctx);
    const projection = projectLoan(db, ctx.params.id!);
    if (!projection) throw new NotFound("That loan does not exist.");
    return render(
      ctx, "Record a lender statement",
      renderLoanStatementForm({ projection, today: todayIST() }),
    );
  });

  router.post("/loans/:id/statement", (ctx) =>
    mutate(ctx, (a) => {
      requireLoans();
      const loanId = ctx.params.id!;
      const ytdRaw = field(ctx.body, "interest_paid_ytd");
      const remainingRaw = field(ctx.body, "instalments_remaining");
      recordLoanStatement(db, actorFor(a, "ui", ctx.req.headers["idempotency-key"] as string), {
        loanId,
        asOf: parseDate(field(ctx.body, "as_of") ?? "") ?? todayIST(),
        lenderOutstanding: amountField(requiredField(ctx.body, "lender_outstanding")),
        interestPaidYtd: ytdRaw?.trim() ? amountField(ytdRaw) : null,
        instalmentsRemaining: remainingRaw?.trim() ? Number(remainingRaw) : null,
      });
      return { redirect: `/loans/${loanId}`, message: "Statement recorded." };
    }),
  );

  router.get("/loans/:id/prepay", (ctx) => {
    requireLoans();
    const projection = projectLoan(db, ctx.params.id!);
    if (!projection) throw new NotFound("That loan does not exist.");

    /*
     * B69 · R14 keeps sanctioned, disbursed and undrawn apart, and a loan that
     * is sanctioned but not yet drawn is an ordinary state — an education loan
     * released in tranches sits there for years. The amortisation builder
     * rightly refuses a principal of zero, and this page handed it one, so the
     * prepayment screen answered 500 for a loan the rest of the app renders
     * happily. There is nothing to prepay, and that is what it should say.
     */
    if (projection.outstanding <= 0) {
      return render(
        ctx, "Prepay",
        html`
          <h1>Prepay ${projection.loan.nickname ?? projection.loan.lender}</h1>
          <div class="card empty-state">
            <p>Nothing is outstanding on this loan, so there is nothing to prepay.</p>
            <p class="faint">
              ${projection.disbursed <= 0
                ? "None of the sanctioned amount has been drawn yet."
                : "It is fully repaid."}
            </p>
            <p><a class="button" href="/loans/${projection.loan.id}">Back to the loan</a></p>
          </div>
        `,
      );
    }

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

  // S16 · Overview — the read-only home that gathers the five most-checked
  // numbers from the budget, cashflow, net worth and insight engine.
  router.get("/overview", (ctx) => {
    const view = buildBudgetView(db);
    const month = view.month;
    const cashflow = projectCashflow(db, { days: 60 });
    const outstanding = creditOutstanding(db);
    const unfundedCards = [...view.categories.values()]
      .filter((c) => c.paymentAccountId)
      .map((c) => ({
        name: c.name,
        amount: cardFunding(
          c.paymentAccountId!,
          outstanding.get(c.paymentAccountId!) ?? 0,
          c.state.balance,
          view.monthState.unfundedByAccount[c.paymentAccountId!] ?? 0,
        ).unfunded,
      }))
      .filter((c) => c.amount > 0);
    const monthTrend = incomeVsExpense(db, `${month}-01`, todayIST());
    const monthSpend = (monthTrend.at(-1)?.spending ?? 0) as Paise;

    // #12 · Months of runway = liquid cash ÷ typical monthly spend (mean of the
    // three complete months before this one, so a partial month doesn't skew it).
    const bals = accountBalances(db);
    const cash = listAccounts(db)
      .filter((acc) => acc.kind === "budget")
      .reduce((sum, acc) => sum + Math.max(0, bals.get(acc.id)?.working ?? 0), 0);
    const priorMonths = incomeVsExpense(db, `${addMonths(month, -3)}-01`, `${month}-01`);
    const avgMonthlySpend = priorMonths.length
      ? priorMonths.reduce((s, m) => s + m.spending, 0) / priorMonths.length
      : 0;
    const runwayMonths = avgMonthlySpend > 0 ? cash / avgMonthlySpend : null;

    // #13 · Bills due in the next fortnight, each with a one-tap "mark paid".
    const soon = addDays(todayIST(), 14);
    const dueSoon = listSchedules(db)
      .filter((s) => s.next_due && s.next_due <= soon && (s.amount ?? 0) < 0)
      .sort((x, y) => (x.next_due ?? "").localeCompare(y.next_due ?? ""))
      .slice(0, 6)
      .map((s) => ({ id: s.id, name: s.name, amount: Math.abs(s.amount ?? 0) as Paise, nextDue: s.next_due! }));

    return render(
      ctx, "Overview",
      renderOverview({
        month,
        rta: view.monthState.readyToAssign,
        rtaState: view.monthState.rtaState,
        netWorth: config.features.assets ? netWorthStatement(db).netWorth : (0 as Paise),
        netWorthHistory: config.features.assets ? netWorthHistory(db) : [],
        cashflow,
        cashflowReading: describeCashflow(cashflow),
        unfundedCards,
        insights: spendingInsights(db, todayIST(), 4),
        monthSpend,
        cash: cash as Paise,
        runwayMonths,
        dueSoon,
      }),
    );
  });

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
    const categorySpend = groupTotals(
      queryTransactions(db, { from: period.from, to: period.to, direction: "out" }),
      "category",
    )
      .map((g) => ({ key: g.key, label: g.label, value: Math.abs(g.total) }))
      .filter((g) => g.value > 0)
      .sort((a, b) => b.value - a.value);
    // S15 · A 12-month spend sparkline per top category — the shape of each,
    // not just this period's size.
    const categoryTrends = categorySpend.slice(0, 12).map((g) => ({
      name: g.label,
      spent: categoryTrend(db, g.key, 12).map((m) => m.spent / 100),
    }));

    // S15 · The money-flow Sankey uses this month: income in, and where it went
    // by group → category. Built from the budget view's own group structure.
    const bview = buildBudgetView(db);
    const monthIncome = (incomeVsExpense(db, `${bview.month}-01`, todayIST()).at(-1)?.income ?? 0) as Paise;
    const sankeyGroups = bview.groups
      .map((g) => ({
        name: g.name,
        categories: g.categories
          .map((c) => ({ name: c.name, value: -c.state.activity as Paise }))
          .filter((c) => c.value > 0),
      }))
      .filter((g) => g.categories.length > 0);

    return render(
      ctx, "Reports",
      renderReports({
        insights: spendingInsights(db),
        trend: incomeVsExpense(db, period.from, period.to),
        categorySpend: categorySpend.map((g) => ({ label: g.label, value: g.value })),
        categoryTrends,
        tagSpend: spendByTag(db, period.from, period.to),
        spendingCalendar: spendingCalendar(db, addDays(todayIST(), -119), todayIST()),
        sankey: { income: monthIncome, month: bview.month, groups: sankeyGroups },
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

  // B51: the manual form the "Add one" button pointed at (it 405'd before).
  router.get("/schedules/new", (ctx) => {
    const view = buildBudgetView(db);
    return render(
      ctx, "Add a schedule",
      renderNewScheduleForm({
        accounts: listAccounts(db).map((a) => ({ id: a.id, name: a.name, nickname: a.nickname })),
        categories: [...view.categories.values()]
          .filter((c) => !c.isPaymentCategory && !c.hidden)
          .map((c) => ({ id: c.id, name: c.name })),
        today: todayIST(),
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
      }),
    );
  });

  router.post("/goals/new", (ctx) =>
    mutate(ctx, (a) => {
      const actor = actorFor(a, "ui", ctx.req.headers["idempotency-key"] as string);
      const targetDate = field(ctx.body, "target_date");
      const name = requiredField(ctx.body, "name");

      // B58 · A goal owns exactly one savings envelope, created and managed by
      // the app in the "Savings goals" group — never hand-picked, never shared.
      const category = ensureSavingsCategory(actor, name);
      createGoal(db, actor, {
        name,
        targetAmount: amountField(field(ctx.body, "target_amount"), "Target"),
        targetDate: targetDate ? parseDate(targetDate) : null,
        categoryIds: [category.id],
      });
      return { redirect: "/goals", message: "Goal added, with its own savings category." };
    }),
  );

  // B58 · Create (or reuse) the app-managed "Savings goals" group and a fresh
  // category in it for a goal. The group is `internal`, so its categories carry
  // no manual controls on the Categories screen — the goal owns them.
  /**
   * B61 · The app-managed group that holds one envelope per goal.
   *
   * It used to be called "Savings goals", which is also what the starting
   * template calls its ordinary savings group — so a household that ran the
   * template and then added a goal saw *two* sections with the same heading on
   * the Categories page, one editable and one not. The managed group is called
   * "Goals" instead, and an existing one is renamed rather than abandoned,
   * because abandoning it would split goal envelopes across two groups.
   */
  const GOAL_GROUP = "Goals";
  const LEGACY_GOAL_GROUP = "Savings goals";

  function goalGroup(actor: Actor) {
    const groups = listGroups(db);
    const existing = groups.find(
      (g) => g.kind === "internal" && (g.name === GOAL_GROUP || g.name === LEGACY_GOAL_GROUP),
    );
    if (!existing) return createGroup(db, actor, GOAL_GROUP, "internal");
    if (existing.name !== GOAL_GROUP) return renameGroup(db, actor, existing.id, GOAL_GROUP);
    return existing;
  }

  function ensureSavingsCategory(actor: Actor, goalName: string) {
    return createCategory(db, actor, { groupId: goalGroup(actor).id, name: goalName });
  }

  router.post("/goals/:id/edit", (ctx) =>
    mutate(ctx, (a) => {
      const actor = actorFor(a, "ui", ctx.req.headers["idempotency-key"] as string);
      const targetDate = field(ctx.body, "target_date");
      const name = requiredField(ctx.body, "name");
      updateGoal(db, actor, ctx.params.id!, {
        name,
        targetAmount: amountField(field(ctx.body, "target_amount"), "Target"),
        targetDate: targetDate?.trim() ? parseDate(targetDate) : null,
      });
      // Keep the owned category's name in step with the goal's.
      for (const catId of goalCategoryIds(db, ctx.params.id!)) {
        const cat = getCategory(db, catId);
        if (cat && cat.name !== name) renameCategory(db, actor, catId, name);
      }
      return { redirect: "/goals", message: "Goal updated." };
    }),
  );

  router.post("/goals/:id/delete", (ctx) =>
    mutate(ctx, (a) => {
      const actor = actorFor(a, "ui", ctx.req.headers["idempotency-key"] as string);
      const id = ctx.params.id!;
      const view = buildBudgetView(db);
      // B58 · The goal owns its category. On delete, hand the envelope back as a
      // normal category (moved to a "Savings" group) so its money is never lost
      // and the household can manage or empty it afterwards.
      const catIds = goalCategoryIds(db, id);
      const kept = catIds.reduce((sum, cid) => sum + (view.categories.get(cid)?.state.balance ?? 0), 0) as Paise;
      deleteGoal(db, actor, id);
      // B61: prefer a savings group the household already has — the starting
      // template's "Savings goals" is exactly the right home — over minting a
      // third group nobody asked for.
      const groups = listGroups(db);
      const normal =
        groups.find((g) => g.kind === "normal" && g.name === LEGACY_GOAL_GROUP)
        ?? groups.find((g) => g.kind === "normal" && g.name === "Savings")
        ?? (catIds.length > 0 ? createGroup(db, actor, "Savings", "normal") : null);
      for (const catId of catIds) {
        if (normal) moveCategoryToGroup(db, actor, catId, normal.id);
      }
      const where = normal?.name ?? "Savings";
      return {
        redirect: "/goals",
        message: kept > 0
          ? `Goal removed. Its ${formatPaise(kept)} is now a category you manage, under "${where}".`
          : `Goal removed. Its empty savings category moved to "${where}".`,
      };
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
            .map((c) => {
              const t = c.isPaymentCategory ? null : getTarget(db, c.id);
              return {
                id: c.id, name: c.name, hidden: c.hidden,
                balance: c.state.balance, isPayment: c.isPaymentCategory,
                target: t ? { amount: t.amount ?? 0, date: t.target_date } : null,
              };
            }),
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

  // F3.4 · Set, change or clear a category's target (what it should hold).
  router.post("/categories/:id/target", (ctx) =>
    mutate(ctx, (a) => {
      const actor = actorFor(a, "ui", ctx.req.headers["idempotency-key"] as string);
      const amountRaw = field(ctx.body, "amount");
      if (!amountRaw?.trim()) {
        clearTarget(db, actor, ctx.params.id!);
        return { redirect: "/categories", message: "Target removed." };
      }
      const dateRaw = field(ctx.body, "target_date");
      const type = dateRaw?.trim() ? "by-date" : "monthly";
      setTarget(db, actor, ctx.params.id!, {
        type,
        amount: Math.abs(amountField(amountRaw, "Target")),
        targetDate: dateRaw?.trim() ? parseDate(dateRaw) : null,
      });
      return { redirect: "/categories", message: "Target set." };
    }),
  );

  // F3.6 · Reorder a category within its group, or a group among groups.
  router.post("/categories/:id/reorder", (ctx) =>
    mutate(ctx, (a) => {
      const dir = field(ctx.body, "direction") === "up" ? "up" : "down";
      reorderCategory(db, actorFor(a, "ui", ctx.req.headers["idempotency-key"] as string),
        ctx.params.id!, dir);
      return { redirect: "/categories", message: "Moved." };
    }),
  );

  router.post("/groups/:id/reorder", (ctx) =>
    mutate(ctx, (a) => {
      const dir = field(ctx.body, "direction") === "up" ? "up" : "down";
      reorderGroup(db, actorFor(a, "ui", ctx.req.headers["idempotency-key"] as string),
        ctx.params.id!, dir);
      return { redirect: "/categories", message: "Moved." };
    }),
  );

  // F3.5 · Delete a category (must be empty; its history can be remapped).
  router.post("/categories/:id/delete", (ctx) =>
    mutate(ctx, (a) => {
      const id = ctx.params.id!;
      const view = buildBudgetView(db);
      const balance = view.categories.get(id)?.state.balance ?? 0;
      deleteCategory(db, actorFor(a, "ui", ctx.req.headers["idempotency-key"] as string), id, {
        currentBalance: balance,
        remapTo: field(ctx.body, "remap_to") || null,
      });
      return { redirect: "/categories", message: "Category deleted." };
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
  // `10` §3.5 · F2.10 · Private lending within the family.
  // -------------------------------------------------------------------------

  /** Budget accounts money can actually move from. */
  function cashAccounts() {
    return listAccounts(db)
      .filter((a) => a.kind === "budget" && !a.closed_at)
      .map((a) => ({ id: a.id, name: a.name }));
  }

  router.get("/family", (ctx) => {
    auth(ctx);
    const loans = listFamilyLoans(db, { includeClosed: true })
      .map((l) => viewFamilyLoan(db, l.id))
      .filter((v): v is NonNullable<typeof v> => v !== null);

    return render(ctx, "Lending in the family", renderFamilyLoans({
      loans, accounts: cashAccounts(),
    }));
  });

  router.post("/family/new", (ctx) =>
    mutate(ctx, (a) => {
      const agreed = field(ctx.body, "agreed_total");
      const loan = createFamilyLoan(db, actorFor(a), {
        counterparty: requiredField(ctx.body, "counterparty"),
        agreedTotal: agreed ? amountField(agreed) : null,
        note: field(ctx.body, "note") || null,
      });
      return {
        redirect: `/family/${loan.id}`,
        message: "Now record what has actually moved — the balance comes from that.",
      };
    }),
  );

  router.get("/family/:id", (ctx) => {
    auth(ctx);
    const view = viewFamilyLoan(db, ctx.params.id!);
    if (!view) throw new NotFound("That arrangement does not exist.");

    const entries = queryAll<{ date: string; amount: number; memo: string | null }>(
      db,
      `SELECT date, amount, memo FROM transactions
        WHERE account_id = ? AND deleted_at IS NULL ORDER BY date DESC, created_at DESC`,
      view.loan.account_id,
    );

    const budgetView = buildBudgetView(db);
    return render(ctx, view.loan.counterparty, renderFamilyLoan({
      view,
      accounts: cashAccounts(),
      categories: [...budgetView.categories.values()]
        .filter((c) => !c.isPaymentCategory && !c.hidden)
        .map((c) => ({ id: c.id, name: c.name })),
      entries: entries.map((e) => ({ ...e, amount: e.amount as never })),
      confirmingWriteOff: ctx.query.get("confirm") === "write-off",
    }));
  });

  router.post("/family/:id/advance", (ctx) =>
    mutate(ctx, (a) => {
      const dateRaw = field(ctx.body, "date");
      recordAdvance(db, actorFor(a, "ui", ctx.req.headers["idempotency-key"] as string), {
        loanId: ctx.params.id!,
        amount: Math.abs(amountField(requiredField(ctx.body, "amount"))),
        date: dateRaw ? parseDate(dateRaw) ?? todayIST() : todayIST(),
        fromAccountId: requiredField(ctx.body, "account_id"),
      });
      return { redirect: `/family/${ctx.params.id}`, message: "Recorded." };
    }),
  );

  router.post("/family/:id/repayment", (ctx) =>
    mutate(ctx, (a) => {
      const dateRaw = field(ctx.body, "date");
      recordRepayment(db, actorFor(a, "ui", ctx.req.headers["idempotency-key"] as string), {
        loanId: ctx.params.id!,
        amount: Math.abs(amountField(requiredField(ctx.body, "amount"))),
        date: dateRaw ? parseDate(dateRaw) ?? todayIST() : todayIST(),
        accountId: requiredField(ctx.body, "account_id"),
      });
      return { redirect: `/family/${ctx.params.id}`, message: "Recorded." };
    }),
  );

  router.post("/family/:id/write-off", (ctx) => {
    const a = auth(ctx);
    const id = ctx.params.id!;

    // FL7 is irreversible-looking even though it undoes, so it is confirmed
    // with the amount and the consequence stated.
    if (field(ctx.body, "confirm") !== "1") {
      return { redirect: `/family/${id}?confirm=write-off` };
    }

    // Read which way the balance pointed before closing it, so the message
    // matches: a debt to you is written off, a debt of yours is forgiven (B54).
    const before = viewFamilyLoan(db, id);
    const owedByYou = before?.owedByYou ?? false;

    const amount = writeOffFamilyLoan(db, actorFor(a, "ui", ctx.req.headers["idempotency-key"] as string), {
      loanId: id,
      categoryId: requiredField(ctx.body, "category_id"),
    });

    return {
      redirect: withNotice(
        "/family",
        (owedByYou
          ? `Recorded ${formatPaise(amount)} forgiven. `
          : `Wrote off ${formatPaise(amount)}. `) +
          "Every line is still there.",
      ),
    };
  });

  router.post("/family/:id/close", (ctx) =>
    mutate(ctx, (a) => {
      closeFamilyLoan(db, actorFor(a), ctx.params.id!);
      return { redirect: "/family", message: "Closed, with the history kept." };
    }),
  );

  // -------------------------------------------------------------------------
  // `08` F30 · Personal API tokens.
  // -------------------------------------------------------------------------

  router.get("/tokens", (ctx) => {
    const a = auth(ctx);
    return render(ctx, "API tokens", renderTokens({
      tokens: listTokens(db, a.member.id),
      minted: null,
    }));
  });

  router.post("/tokens", (ctx) => {
    const a = auth(ctx);
    const days = field(ctx.body, "expires_in_days");
    const scope = field(ctx.body, "scope") === "read-write" ? "read-write" : "read";

    const minted = mintToken(db, actorFor(a), {
      name: requiredField(ctx.body, "name"),
      scope: scope as TokenScope,
      expiresInDays: days ? Number(days) : null,
    });

    // F30.4 · Rendered rather than redirected, because a redirect would have to
    // carry the secret in a URL — where it would land in logs and history.
    return render(ctx, "API tokens", renderTokens({
      tokens: listTokens(db, a.member.id),
      minted: { name: minted.token.name, secret: minted.secret },
    }));
  });

  router.post("/tokens/:id/revoke", (ctx) =>
    mutate(ctx, (a) => {
      revokeToken(db, actorFor(a), ctx.params.id!);
      return { redirect: "/tokens", message: "Revoked. Anything using it stops now." };
    }),
  );

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

  // -------------------------------------------------------------------------
  // `04` §3.4 · Gmail ingestion — a separate, opt-in connection.
  // -------------------------------------------------------------------------

  router.get("/gmail/connect", (ctx) => {
    const a = auth(ctx);
    if (!config.google.clientId) throw new HttpError(500, "Google is not configured.");
    const start = beginGmailConnect({
      clientId: config.google.clientId,
      redirectUri: `${config.baseUrl}/gmail/callback`,
    });
    pendingGmail.set(start.state, { verifier: start.codeVerifier, memberId: a.member.id, at: Date.now() });
    for (const [k, v] of pendingGmail) if (Date.now() - v.at > 10 * 60_000) pendingGmail.delete(k);
    return { redirect: start.url };
  });

  router.get("/gmail/callback", async (ctx) => {
    const a = auth(ctx);
    const state = ctx.query.get("state") ?? "";
    const pending = pendingGmail.get(state);
    pendingGmail.delete(state);
    if (!pending || pending.memberId !== a.member.id) {
      throw new HttpError(400, "That Gmail connection link has expired. Try again.");
    }
    const code = ctx.query.get("code");
    if (!code) return { redirect: "/settings#gmail" };

    const tokens = await exchangeGmailCode({
      clientId: config.google.clientId!,
      clientSecret: config.google.clientSecret!,
      redirectUri: `${config.baseUrl}/gmail/callback`,
      code, codeVerifier: pending.verifier, fetchImpl: deps.fetchImpl,
    });

    saveConnection(db, actorFor(a), {
      email: a.member.email, refreshToken: tokens.refreshToken, scope: tokens.scope,
    });
    return { redirect: withNotice("/settings#gmail", "Gmail connected. Fetch when you're ready.") };
  });

  router.post("/gmail/disconnect", (ctx) =>
    mutate(ctx, (a) => {
      const connection = getConnection(db, a.member.id);
      if (connection) {
        // Best-effort remote revoke; the local token is deleted regardless.
        void revokeGmailToken(connection.refresh_token, deps.fetchImpl);
      }
      deleteConnection(db, actorFor(a));
      return { redirect: "/settings#gmail", message: "Disconnected. The stored access was deleted." };
    }),
  );

  router.post("/gmail/fetch", async (ctx) => {
    const a = auth(ctx);
    if (!getConnection(db, a.member.id)) throw new HttpError(400, "Gmail is not connected.");

    const result = await fetchGmail(db, actorFor(a, "import"), {
      clientId: config.google.clientId!,
      clientSecret: config.google.clientSecret!,
      fetchImpl: deps.fetchImpl,
    });

    const parts: string[] = [];
    if (result.alerts.staged) parts.push(`${result.alerts.staged} alerts`);
    if (result.statements.staged) parts.push(`${result.statements.staged} statement rows`);
    if (result.alerts.unmatched) parts.push(`${result.alerts.unmatched} to an unknown account`);
    const summary = parts.length
      ? `Read ${result.scanned} messages — ${parts.join(", ")}, all in Review.`
      : `Read ${result.scanned} messages — nothing new.`;

    return { redirect: withNotice(result.alerts.staged || result.statements.staged ? "/review" : "/settings#gmail", summary) };
  });

  /** `10` §3.6 · What statement passwords are worked out from. */
  router.post("/settings/identity", (ctx) =>
    mutate(ctx, (a) => {
      if (field(ctx.body, "clear") === "1") {
        clearIdentity(db, actorFor(a));
        return { redirect: "/settings#statements", message: "Removed. You'll be asked for a password each time." };
      }
      setIdentity(db, actorFor(a), {
        name: requiredField(ctx.body, "name"),
        pan: field(ctx.body, "pan") || null,
        dob: field(ctx.body, "dob") || null,
        mobile: field(ctx.body, "mobile") || null,
      });
      return {
        redirect: "/settings#statements",
        message: "Saved. Statements should now open without you typing anything.",
      };
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

  router.get("/portfolio/allocation", (ctx) => {
    requireAssets();
    auth(ctx);
    const a = assetAllocation(db);
    const foreign = a.byCurrency.some((c) => c.key !== "INR") || a.byRegion.length > 1;
    return render(ctx, "Allocation", renderAllocation({
      byClass: a.byClass,
      byRegion: a.byRegion,
      byCurrency: a.byCurrency,
      total: a.total,
      unclassified: a.unclassified,
      classes: ASSET_CLASSES.map((k) => ({ key: k, label: ASSET_CLASS_LABELS[k] })),
      hasForeign: foreign,
    }));
  });

  router.post("/portfolio/instrument/:id/classify", (ctx) =>
    mutate(ctx, (a) => {
      requireAssets();
      const raw = field(ctx.body, "asset_class");
      const assetClass = raw && (ASSET_CLASSES as readonly string[]).includes(raw)
        ? (raw as (typeof ASSET_CLASSES)[number])
        : null;
      classifyInstrument(db, actorFor(a), ctx.params.id!, { assetClass });
      return { redirect: "/portfolio/allocation", message: assetClass ? "Classified." : "Cleared." };
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

  // B51: enter a price by hand — the holding page's "Enter one" link 404'd.
  router.get("/portfolio/:id/price", (ctx) => {
    requireAssets();
    auth(ctx);
    const view = viewHolding(db, ctx.params.id!);
    if (!view) throw new NotFound("That holding does not exist.");
    return render(
      ctx, `Price ${view.instrument.name}`,
      renderManualPrice({
        holdingId: view.holding.id,
        instrumentName: view.instrument.name,
        currentPrice: view.quote ? String(view.quote.price / 1_000_000) : "",
        today: todayIST(),
      }),
    );
  });

  router.post("/portfolio/:id/price", (ctx) =>
    mutate(ctx, (a) => {
      requireAssets();
      actorFor(a); // write-guard via mutate
      const view = viewHolding(db, ctx.params.id!);
      if (!view) throw new NotFound("That holding does not exist.");
      recordPrice(db, {
        instrumentId: view.instrument.id,
        price: toUnitPrice(Number(requiredField(ctx.body, "price"))),
        asOf: parseDate(field(ctx.body, "as_of") ?? "") ?? todayIST(),
        source: "manual",
      });
      return { redirect: `/portfolio/${view.holding.id}`, message: "Price saved." };
    }),
  );

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

  /**
   * F19.6 / P6 · A manual refresh, "subject to the same ceiling, with the
   * remaining daily quota shown".
   *
   * `force` skips P4's cadence but not P5's ceiling — the cadence exists
   * because a NAV published at 23:00 does not exist at noon, and a human who
   * pressed the button knows that better than the schedule does. The ceiling
   * exists because the provider does not care who pressed what.
   */
  router.post("/portfolio/refresh", async (ctx) => {
    requireAssets();
    const a = auth(ctx);

    const outcome = await refreshPrices(db, actorFor(a, "ui"), {
      force: true,
      alphaVantageKey: config.alphaVantageKey,
    });

    appendEvent(db, actorFor(a, "ui"), {
      entity: "prices", entityId: todayIST(), action: "refresh",
      after: { updated: outcome.updated, failed: outcome.failed },
      summary:
        `Refreshed ${outcome.updated} prices` +
        (outcome.failed ? `, ${outcome.failed} failed` : ""),
    });

    const quota = outcome.quota
      .filter((q: { ceiling: number | null }) => q.ceiling !== null)
      .map((q: { provider: string; remaining: number | null; ceiling: number | null }) =>
        `${q.provider}: ${q.remaining} of ${q.ceiling} left today`)
      .join(", ");

    return {
      redirect: withNotice(
        "/portfolio",
        (outcome.failed === 0
          ? `Refreshed ${outcome.updated} prices.`
          : `Refreshed ${outcome.updated}. ${outcome.failed} couldn't be fetched — ` +
            `cached prices are still shown, with their dates.`) +
        (quota ? ` (${quota})` : ""),
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

  // B51: the manual-asset routes. They used to live under `/assets/`, where the
  // static-asset guard (`path.startsWith("/assets/")`) 404'd them before the
  // router ever saw them — so hand-valued assets could not be created or
  // revalued through the UI at all. Moved under `/portfolio/`.
  router.get("/portfolio/asset/new", (ctx) => {
    requireAssets();
    auth(ctx);
    return render(ctx, "Add an asset", renderNewAssetForm({ today: todayIST() }));
  });

  router.post("/portfolio/asset/new", (ctx) =>
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

  router.get("/portfolio/asset/:id/revalue", (ctx) => {
    requireAssets();
    auth(ctx);
    const account = listAssetAccounts(db).find((acc) => acc.id === ctx.params.id);
    if (!account) throw new NotFound("That asset does not exist.");
    const valuation = latestValuation(db, account.id);
    return render(
      ctx, `Revalue ${account.name}`,
      renderRevalueAsset({
        asset: {
          id: account.id, name: account.name,
          value: valuation?.value ?? 0, asOf: valuation?.asOf ?? todayIST(),
        },
        today: todayIST(),
      }),
    );
  });

  router.post("/portfolio/asset/:id/revalue", (ctx) =>
    mutate(ctx, (a) => {
      requireAssets();
      const account = listAssetAccounts(db).find((acc) => acc.id === ctx.params.id);
      if (!account) throw new NotFound("That asset does not exist.");
      recordValuation(db, actorFor(a), {
        accountId: account.id,
        value: amountField(requiredField(ctx.body, "value")),
        asOf: parseDate(field(ctx.body, "as_of") ?? "") ?? todayIST(),
      });
      return { redirect: "/portfolio", message: `Revalued ${account.name}.` };
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
    const requestFailures24h = countRequestFailures(db);
    const recentFailures = requestFailures24h > 0 ? recentRequestFailures(db, 3) : [];
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
            name: "Job failures in the last 24 hours",
            state: errors24h === 0 ? "healthy" : "degraded",
            reason: errors24h === 0 ? "None." : `${errors24h} job run${errors24h === 1 ? "" : "s"} failed.`,
          },
          {
            // B66 · Until this existed, a route that threw was counted nowhere:
            // the check above only ever looked at scheduled jobs, so the page
            // you open at 2am could read entirely healthy while every request
            // to one screen was returning a 500.
            name: "Request failures in the last 24 hours",
            state: requestFailures24h === 0 ? "healthy" : "failed",
            reason:
              requestFailures24h === 0
                ? "None."
                : `${requestFailures24h} request${requestFailures24h === 1 ? "" : "s"} failed. ` +
                  `Most recent: ${recentFailures
                    .map((f) => `${f.method} ${f.path} — ${f.message ?? "no message"}`)
                    .slice(0, 3)
                    .join("; ")}`,
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

  /** F19.13 · Portfolio CSVs — one shape each. */
  function csvDownload(name: string, body: string): Response {
    return {
      body,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${name}-${todayIST()}.csv"`,
      },
    };
  }
  router.get("/portfolio/holdings.csv", (ctx) => { requireAssets(); auth(ctx); return csvDownload("holdings", exportHoldingsCsv(db)); });
  router.get("/portfolio/lots.csv", (ctx) => { requireAssets(); auth(ctx); return csvDownload("lots", exportLotsCsv(db)); });
  router.get("/portfolio/prices.csv", (ctx) => { requireAssets(); auth(ctx); return csvDownload("prices", exportPriceHistoryCsv(db)); });
  router.get("/net-worth.csv", (ctx) => { requireAssets(); auth(ctx); return csvDownload("net-worth", exportNetWorthCsv(db)); });

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
