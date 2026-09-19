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
import { APP_ICON_SVG, APP_ICON_SMALL_SVG } from "./web/icon.ts";
import { ICON_FILES } from "./web/icon-files.ts";
import {
  authenticate, parseCookies, sessionCookie, clearedSessionCookie, SESSION_COOKIE,
  actorFor, setTheme, listMembers, memberCount, inviteMember, createSession,
  startImpersonation, stopImpersonation, setImpersonationWrites, listSessions,
  revokeSession, recordAuthAttempt, isRateLimited, findMemberByEmail, getMember,
  removeMember,
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
import { parseDate, todayIST, nowIST, addDays, addMonths, monthOf, isMonthKey, formatMonth, lastDayOfMonth, daysBetween, fiscalYearOf, formatFiscalYear, statementPeriodOf, type MonthKey, type IsoDate } from "./core/dates.ts";
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
  parseStatementPdf, openStatement, BANKS, bankForInstitution,
  WrongPassword as StatementWrongPassword,
} from "./import/pdf-statements.ts";
import {
  passwordCandidates, describeCandidate, missingDetailFor,
} from "./import/statement-passwords.ts";
import { getIdentity, setIdentity, clearIdentity, maskedIdentity } from "./import/identity.ts";
import {
  recognise, saveProfile, listProfiles, markProfileUsed, deleteProfile,
  mappingFromSelections, validateMapping, columnChoices, candidateHeaderRows, looksMappable,
  parseWith,
} from "./import/profiles.ts";
import {
  proposeCategoryRules, proposePayeeRule, previewRetroactive, applyRetroactive,
  suppress, learningEnabled, setLearningEnabled, confirmRule, dismissRule,
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
  householdBudgetId, budgetsFor, lastBudget, rememberBudget, ensurePersonalBudget, listBudgets, getBudget,
  personalBudgetFor,
} from "./domain/budgets.ts";
import {
  ensureCommitmentEnvelope, commitmentEnvelope, guardCommitmentEnvelope, anyCommitments,
} from "./domain/commitments.ts";
import { buildHouseholdView } from "./domain/household-view.ts";
import { eventVisibility } from "./domain/event-visibility.ts";
import { callItEven } from "./domain/squaring-up.ts";
import { describeDeparture, settleDeparture, type DepartureResolution } from "./domain/departure.ts";
import { convertToEmi } from "./domain/card-emi.ts";
import { renderDeparture } from "./web/pages/departure.ts";
import { renderHousehold } from "./web/pages/household.ts";
import {
  createAccount, updateAccount, closeAccount, reopenAccount, listAccounts, getAccount, listCards, createCard, closeCard, recordCardStatement, lastCardStatement, paymentCategoryFor, MANAGED_SUBTYPES, SUBTYPE_LABELS, type AccountKind, hiddenAccountIds, type HolderScope,
 creditedSinceStatement, type Account,  DERIVED_VALUE_SUBTYPES,
  REVALUABLE_SUBTYPES,
} from "./domain/accounts.ts";
import {
  setAssigned, addAssigned, copyAssignmentsFromMonth, moveMoney, setHeld, getHeld,
  listCategories, getCategory, startPersonalBudget, deleteGroup, visibleBudgetIds,
  mergeCategories,
} from "./domain/budget.ts";
import {
  createTransaction, createTransfer, updateTransaction, deleteTransaction,
  getTransaction, getSplits, listPayees, payeeStats, tagsFor, type Transaction,
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
  renderPrepaymentComparison, renderLoanStatementForm, renderRateReset,
} from "./web/pages/loans.ts";
import {
  createLoan, listLoans, getLoan, projectLoan, recordInstalment, listPayments, closeLoan,
  recordDisbursement, recordLoanStatement, recordRateChange, recordPrepayment, canSeeLoan,
  listDisbursements, listRatePeriods, debtOverview, type LoanType,
} from "./domain/loans.ts";
import { comparePrepayment, rateResetOptions, NegativeAmortisation } from "./loans/amortisation.ts";
import {
  renderQuery, renderReports, renderSchedules, renderNewScheduleForm, renderGoals,
} from "./web/pages/analysis.ts";
import { renderOverview } from "./web/pages/overview.ts";
import {
  queryTransactions, groupTotals, periodPresets, periodFor, incomeVsExpense,
  envelopeSpendByMonth, outstandingReimbursements, capitalGainsByYear,
  loanInterestByFinancialYear, categoryTrend, spendingCalendar, spendByTag, rowsToCsv,
  type GroupBy, type TransactionFilter,
} from "./domain/reports.ts";
import { spendingInsights, type Insight } from "./domain/insights.ts";
import {
  listSchedules, createSchedule, updateSchedule, deleteSchedule, markPaid, skipOccurrence,
  detectSchedules, projectCashflow, describeCashflow, subscriptions, type Recurrence,
  setScheduleSplits, getScheduleSplits,
} from "./domain/schedules.ts";
import {
  listGoals, createGoal, updateGoal, deleteGoal, goalCategoryIds, goalProgress, completeGoal,
  LEGACY_GOAL_GROUP,
} from "./domain/goals.ts";
import {
  renderMore, renderPayees, renderRules, renderCategories, renderFirstRun,
  renderTokens,
  type PayeeRow, type RuleRow,
} from "./web/pages/manage.ts";
import { renderPrivacy, renderTerms, type LegalMode } from "./web/pages/legal.ts";
import { Refusal } from "./core/refusal.ts";
import { checkPassword, setPassword, anyPasswordSet, hasPassword } from "./auth/passwords.ts";
import { beginOidc, exchangeOidcCode } from "./auth/oidc.ts";
import {
  staleRatesWarning, RATES_VERIFIED_ON, RATES_SOURCE, RULES,
  estimateTax, advanceTaxSchedule, getDeclaration, saveDeclaration,
  incomeInFinancialYear, type AdvanceInstalment,
} from "./domain/tax.ts";
import { renderTax } from "./web/pages/tax.ts";
import { renderDisposeAsset, renderAddToAsset } from "./web/pages/portfolio.ts";
import { capitalGainsTaxFor } from "./domain/capital-gains-tax.ts";
import { renderFire } from "./web/pages/fire.ts";
import { fireProjection, DEFAULT_ASSUMPTIONS } from "./domain/fire.ts";
import { renderActivity } from "./web/pages/activity.ts";
import { renderCards, type CardDue } from "./web/pages/cards.ts";
import { countRequestFailures, recentRequestFailures } from "./ops/errors.ts";

/**
 * The date shown on the legal pages. It is a constant rather than "today"
 * because a policy that claims to have been updated every time it is rendered
 * tells the reader nothing. Bump it when the text changes.
 */
/**
 * B93 · How many uncategorised rows one sitting is worth.
 *
 * It was fifty, and with an inline category picker on each that made the Review
 * page 195KB — 69% of it the same nineteen options repeated. On the phone this
 * app is mostly used on, that is a slow page for a queue nobody clears in one
 * go anyway. Fifteen is a sitting; the rest are still counted in the heading.
 */
const UNCATEGORISED_PAGE = 15;

// Kept in step with the dates on website/privacy.html and website/terms.html,
// which are the canonical pages and cover the same ground for the public site.
/*
 * Whether to show the password form at all.
 *
 * LOCAL_LOGIN turns it on, but an existing password keeps it on regardless:
 * unsetting the flag on a household that signs in this way would otherwise
 * lock everybody out of their own ledger, and a single environment variable
 * should not be able to do that.
 */
/** Whether an OpenID Connect provider is fully configured. */
function oidcConfigured(config: Config): boolean {
  return Boolean(config.oidc.issuer && config.oidc.clientId && config.oidc.clientSecret);
}

/**
 * What an account is actually worth, when that is not its transaction balance.
 *
 * A loan's balance is whatever has been posted to the account, which is usually
 * nothing — the debt lives in its amortisation schedule. A demat account is the
 * same: the holdings carry the value. So a list of accounts showed "₹0" against
 * eighteen lakh of debt, next to a button offering to add a transaction that
 * would then appear on no screen.
 *
 * Returns null for accounts worth exactly what their transactions say, which is
 * most of them.
 */
function derivedWorth(
  db: DB, account: { id: string; subtype: string },
  viewerMemberId: string | null,
): { value: Paise; label: string; href: string } | null {
  if (!DERIVED_VALUE_SUBTYPES.has(account.subtype)) return null;

  if (account.subtype === "loan" || account.subtype === "emi") {
    // Scoped, though the account itself is already one this viewer can see —
    // an unscoped read here would still be a read of the whole household.
    const loan = listLoans(db, { viewerMemberId }).find((l) => l.account_id === account.id);
    const projection = loan ? projectLoan(db, loan.id) : null;
    return {
      value: (projection ? -projection.outstanding : 0) as Paise,
      label: "Open the loan",
      href: loan ? `/loans/${loan.id}` : "/loans",
    };
  }

  if (account.subtype === "family-loan") {
    return { value: 0 as Paise, label: "Open lending", href: "/family" };
  }

  if (account.subtype === "investment") {
    const total = listHoldings(db, account.id).reduce((sum, h) => {
      const view = viewHolding(db, h.id);
      return sum + (view?.marketValue ?? 0);
    }, 0);
    return { value: total as Paise, label: "Open the portfolio", href: "/portfolio" };
  }

  const valuation = latestValuation(db, account.id);
  return {
    value: (valuation?.value ?? 0) as Paise,
    label: "Open the portfolio",
    href: "/portfolio",
  };
}

function passwordSignInOffered(db: DB, config: Config): boolean {
  return config.localLogin || anyPasswordSet(db);
}

const LEGAL_UPDATED = "17 September 2026";
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
  getBytes as getAttachmentBytes, getMeta as attachmentMeta,
} from "./domain/attachments.ts";
import {
  createFamilyLoan, recordAdvance, recordRepayment, viewFamilyLoan,
  writeOffFamilyLoan, closeFamilyLoan, listFamilyLoans, canSeeFamilyLoan,
} from "./domain/family-loans.ts";
import { renderFamilyLoans, renderFamilyLoan } from "./web/pages/family-loans.ts";
import {
  digestFor, mutedKinds, setMutedKinds, DIGEST_KINDS, type DigestKind,
} from "./domain/digest.ts";
import { cameWithTheCard } from "./domain/card-shortfall.ts";
import {
  renderMonthClose, renderClosedMonths, renderDigest, renderDigestSettings,
  renderStatementIdentity, renderGmailConnection,
} from "./web/pages/month-close.ts";
import {
  renderPortfolio, renderHoldingDetail, renderSalePreview, renderNetWorth,
  renderAllocation,
  renderAddHolding, renderCasUpload, renderCasReview,
  renderNewAssetForm, renderRevalueAsset, renderManualPrice, renderSplitForm, renderMergerForm, renderValuations,
  type PortfolioRow, type CasReviewScheme,
} from "./web/pages/portfolio.ts";
import { parseCasPdf, WrongPassword } from "./import/cas.ts";
import {
  planCasImport, applyCasPlan, casDestinations, stashPlan, takePlan,
} from "./import/cas-plan.ts";
import {
  createAssetAccount, listAssetAccounts, listValuableAccounts, findOrCreateInstrument, recordPurchase,
  recordSale, recordPrice, recordSplit, recordMerger, recordValuation, latestValuation, listHoldings, viewHolding,
  priceHistory, previewHoldingSale, getInstrument, listInstruments,
  classifyInstrument, ASSET_CLASSES, ASSET_CLASS_LABELS,
  exportHoldingsCsv, exportLotsCsv, exportPriceHistoryCsv, exportNetWorthCsv,
  type InstrumentKind,
  signedValuation,
  assetHistory,
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
  "/auth/oidc", "/auth/oidc/callback",
  "/privacy", "/terms",
  // F1.6 · Password sign-in, and the first password on an empty household.
  // Both are doors: a person using them has no session yet, by definition.
  // Each route refuses on its own terms — /auth/password when no password
  // sign-in is offered, /auth/first-run once the household has any member.
  "/auth/password", "/auth/first-run",
  // The demo front door has to be reachable by somebody with no session — that
  // is its whole purpose. The route itself refuses unless DEMO_MODE is on.
  "/demo/enter",
]);
const STATIC_PREFIX = "/assets/";

/**
 * R38 · Things a public demonstration must not do. Each is refused with an
 * explanation rather than a 404, because on a demo the honest answer is "not
 * here", not "no such page". A no-op when demo mode is off, which is always,
 * on a household's own deployment.
 */
function refuseInDemo(config: Config, what: string): void {
  if (!config.demoMode) return;
  throw new HttpError(403, `${what} is disabled on the demo. Run your own copy to use it.`);
}

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
      if (path === "/assets/icon-small.svg") {
        return asset(APP_ICON_SMALL_SVG, "image/svg+xml");
      }
      /*
       * F21.1 · The manifest has named these since it was written and nothing
       * served them, so every one 404'd and Chrome never offered to install.
       */
      if (path.startsWith("/assets/") && path.endsWith(".png")) {
        const file = ICON_FILES[path.slice("/assets/".length)];
        if (file) {
          return {
            body: file,
            headers: {
              "Content-Type": "image/png",
              "Cache-Control": "public, max-age=3600",
            },
          };
        }
      }
      if (path === "/manifest.webmanifest") {
        return asset(MANIFEST, "application/manifest+json");
      }
      if (path.startsWith(STATIC_PREFIX)) throw new NotFound();
    },

    /*
     * A write has to come from this app's own pages.
     *
     * The cookie is already `SameSite=Lax`, which a browser honours by not
     * sending it on a cross-site POST, and no GET in this router changes
     * anything — a test walks every handler to keep that true. So CSRF was
     * covered. It was covered by **one property of one cookie attribute**, and
     * the day somebody adds a state-changing GET, or a browser is configured
     * oddly, it stops being covered silently.
     *
     * This is the second lock. Every unsafe method must carry an Origin (or a
     * Referer to fall back on) belonging to this app. A cross-site form post
     * always sends an Origin naming the attacker, so it is rejected on the
     * value; a request with neither header is rejected for having neither.
     *
     * Chosen over a hidden token in every form deliberately: there are 105
     * forms and the 106th is the one somebody forgets. A rule enforced in one
     * place cannot be forgotten, and it protects routes added tomorrow.
     *
     * Bearer-authenticated calls are exempt. They carry no cookie, so a browser
     * cannot be tricked into making one on somebody's behalf — which is the
     * whole mechanism CSRF depends on.
     */
    function sameOriginWrites(ctx: RequestContext): Response | void {
      const method = ctx.method.toUpperCase();
      if (method === "GET" || method === "HEAD" || method === "OPTIONS") return;
      if (/^Bearer\s/i.test(String(ctx.req.headers.authorization ?? ""))) return;

      /*
       * Where this request believes it arrived. The configured base URL is one
       * answer, and the Host it was actually addressed by is the other — a
       * self-hosted app is reached on its LAN address as readily as its name,
       * and both are itself.
       */
      const here = new Set(
        [originOf(config.baseUrl), hostOrigin(ctx)].filter(Boolean),
      );
      const origin = String(ctx.req.headers.origin ?? "");
      if (origin !== "") {
        if (here.has(originOf(origin))) return;
        throw new HttpError(403, "That request came from somewhere else.");
      }

      // No Origin: some browsers omit it on same-origin form posts. Referer is
      // the fallback — `Referrer-Policy: same-origin` means a same-origin post
      // carries one and a cross-origin post does not — and one of the two has
      // to be there.
      const referer = String(ctx.req.headers.referer ?? "");
      if (referer !== "" && here.has(originOf(referer))) return;
      throw new HttpError(403, "That request came from somewhere else.");
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
          demoMode: config.demoMode,
          path: ctx.url.pathname,
          reviewCount: a ? reviewCount(db) : 0,
          notice: opts.notice ?? noticeFrom(ctx),
          bare: opts.bare,
          features: {
            loans: config.features.loans,
            assets: config.features.assets,
            /*
             * Visible once there is more than one person, not once somebody has
             * already committed — it is the page that explains the choice and
             * offers to open a budget of your own, so gating it on having done so
             * made the feature undiscoverable.
             */
            separateBudgets: a ? listMembers(db).length > 1 : false,
          },
          // 15 · In the chrome, so switching budget works from every screen that
          // shows one budget's money rather than only from the grid.
          budgets: a
            ? budgetsFor(db, a.member.id).map((b) => ({ id: b.id, name: b.name, kind: b.kind }))
            : [],
          /*
           * What this request is looking at, not what was last remembered. A
           * screen reached with ?budget= must highlight that one even before the
           * route has had a chance to remember it — otherwise the first click
           * appears to do nothing.
           */
          currentBudgetId: a ? currentBudget(ctx, a.member.id) : null,
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
  /**
   * H2.2 · Who is looking, for filtering private accounts.
   *
   * Deliberately the authenticated member rather than the one being viewed as.
   * Reading `viewingAs` here would make "view as" a way to see exactly what the
   * other person marked private, which is the thing the flag exists to prevent.
   */
  /** H2.3 · Whose figures the reader asked for: household, mine, or joint. */
  function holderScopeParam(ctx: RequestContext): HolderScope {
    const raw = ctx.query.get("whose");
    return raw === "mine" || raw === "joint" ? raw : "household";
  }

  /**
   * 15 · Which budget the reader is looking at.
   *
   * Defaults to the household's, so a household that never opens a personal
   * budget sees exactly the app it had. A budget that is not theirs to see
   * falls back rather than erroring: a stale bookmark should land somewhere
   * sensible, not on a wall.
   */
  function budgetParam(ctx: RequestContext): string {
    const asked = ctx.query.get("budget");
    if (asked) {
      const mine = budgetsFor(db, viewer(ctx));
      const found = mine.find((b) => b.id === asked);
      if (found) {
        rememberBudget(db, viewer(ctx), found.id);
        return found.id;
      }
    }
    return lastBudget(db, viewer(ctx)) ?? householdBudgetId(db);
  }

  /** Which budget this request is about: the one asked for, else the last used. */
  function currentBudget(ctx: RequestContext, memberId: string): string {
    const asked = ctx.query.get("budget");
    if (asked && budgetsFor(db, memberId).some((b) => b.id === asked)) return asked;
    return lastBudget(db, memberId) ?? householdBudgetId(db);
  }

  /**
   * 15 · An envelope you were not offered is an envelope you may not use.
   *
   * Closing the read side — the pickers no longer list another member's
   * categories — left the write side open, and a form field is only a
   * suggestion: posting the id by hand filed a household transaction into one
   * member's private envelope, moved the household's money into it, and
   * confirmed it existed by succeeding. A control that filters what it offers
   * and not what it accepts has not been fixed, only tidied.
   *
   * Not-found rather than a refusal, for the same reason the private loan
   * routes answer not-found: "you may not use this" confirms there is something
   * to use.
   */
  function requireVisibleCategory(ctx: RequestContext, id: string | null): string | null {
    if (!id) return null;
    const seen = listCategories(db, { includeHidden: true, viewerMemberId: viewer(ctx) });
    if (!seen.some((c) => c.id === id)) throw new NotFound("That envelope does not exist.");
    return id;
  }

  /**
   * 15 / H2.2 · The same rule, for the other three things a URL can name.
   *
   * `requireVisibleCategory` closed the write side for envelopes. A sweep of
   * every parameterised route as the wrong member found eighteen more that were
   * never closed at all — an account's whole register, a transaction, and the
   * bytes of the receipt attached to it, readable by anybody signed in who had
   * the id, and closable, categorisable and deletable by them too.
   *
   * They were invisible to both existing guards. The string sweep skips a route
   * that addresses one thing, because it has no id to give it; and the rule that
   * every function *able* to take a viewer is given one cannot see a function
   * that never took one. `getBytes(db, id)` had nothing missing.
   *
   * Not-found in every case, never a refusal: "you may not read this" confirms
   * there is something to read.
   */
  function requireVisibleAccount(ctx: RequestContext, id: string): Account {
    const account = listAccounts(db, { viewerMemberId: viewer(ctx), includeClosed: true })
      .find((a) => a.id === id);
    if (!account) throw new NotFound("That account does not exist.");
    return account;
  }

  function requireVisibleTransaction(ctx: RequestContext, id: string): Transaction {
    const transaction = getTransaction(db, id);
    if (!transaction) throw new NotFound("That transaction does not exist.");
    // Its account, and its envelope: a household transaction filed into a
    // private envelope is as much a disclosure as a private account's is.
    requireVisibleAccount(ctx, transaction.account_id);
    if (transaction.category_id) requireVisibleCategory(ctx, transaction.category_id);
    return transaction;
  }

  function requireVisibleAttachment(ctx: RequestContext, id: string): string {
    const meta = attachmentMeta(db, id);
    if (!meta) throw new NotFound("That attachment does not exist.");
    requireVisibleTransaction(ctx, meta.transaction_id);
    return id;
  }

  /** A group belongs to a budget, the same as the categories inside it. */
  function requireVisibleGroup(ctx: RequestContext, id: string): string {
    const visible = new Set(budgetsFor(db, viewer(ctx)).map((b) => b.id));
    const row = queryOne<{ budget_id: string | null }>(
      db, `SELECT budget_id FROM category_groups WHERE id = ?`, id,
    );
    if (!row) throw new NotFound("That group does not exist.");
    if (row.budget_id !== null && !visible.has(row.budget_id)) {
      throw new NotFound("That group does not exist.");
    }
    return id;
  }

  /**
   * Somewhere inside this app, and nowhere else.
   *
   * Four places took a redirect target from the request and used it as given:
   * the theme toggle and the review queue return to where you were, the
   * impersonation banner does the same, and sign-in returns to the page that
   * asked for a password. The last is the one that matters — an open redirect on
   * a sign-in flow lands the victim on somebody else's site at the exact moment
   * they have just proved who they are and are expecting to be somewhere
   * familiar.
   *
   * One of the four did check, with `startsWith("/")`, which reads as safe and
   * is not: "//evil.example" starts with a slash and is a protocol-relative URL
   * the browser resolves to another host. A backslash does the same thing in
   * some browsers. Both are rejected here.
   */
  /** The origin this request was addressed by, from its own Host header. */
  function hostOrigin(ctx: RequestContext): string {
    const host = String(
      (config.trustProxy ? ctx.req.headers["x-forwarded-host"] : null)
      ?? ctx.req.headers.host ?? "",
    );
    if (host === "") return "";
    const scheme = config.trustProxy && ctx.req.headers["x-forwarded-proto"]
      ? String(ctx.req.headers["x-forwarded-proto"]).split(",")[0]!.trim()
      : (ctx.req.socket as { encrypted?: boolean }).encrypted ? "https" : "http";
    return `${scheme}://${host}`;
  }

  /** Scheme and host, or "" when the value is not a URL this can compare. */
  function originOf(value: string): string {
    try {
      const url = new URL(value);
      return `${url.protocol}//${url.host}`;
    } catch {
      return "";
    }
  }

  function safePath(value: string | null | undefined, fallback: string): string {
    if (!value) return fallback;
    // A path, not a URL: no scheme, no host, no control characters.
    if (!value.startsWith("/")) return fallback;
    if (value.startsWith("//") || value.startsWith("/\\")) return fallback;
    if (/[\u0000-\u001f\u007f]/.test(value)) return fallback;
    return value;
  }

  function viewer(ctx: RequestContext): string | null {
    const a = ctx.locals.auth as AuthContext | null;
    return a?.member.id ?? null;
  }

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

  /**
   * A date the user typed. Empty means today; anything else must actually
   * read as a date. `parseDate(raw) ?? todayIST()` was the pattern here, and
   * it filed "31-02-2026" — a typo — on today's date without a word.
   */
  function dateField(raw: string | undefined, name = "Date"): IsoDate {
    if (raw === undefined || raw.trim() === "") return todayIST();
    const parsed = parseDate(raw);
    if (parsed === null) throw new HttpError(400, `"${raw}" isn't a date I can read — DD-MM-YYYY works.`);
    return parsed;
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
          <h1>Pathayam</h1>
          <p class="muted">Envelope budgeting for your household.</p>
          ${when(
            config.demoMode,
            () => html`
              <div class="card">
                <form method="post" action="/demo/enter">
                  <!--
                    Whose eyes to look through. Most of what is interesting about
                    this app is per-member — a private account, a commitment, a
                    budget of your own — and all of it is invisible if the demo
                    can only ever be one person. Only members who are still in
                    the household are offered: one of them has left, and signing
                    in as somebody who is gone would open the app on a person the
                    household no longer has.
                  -->
                  ${when(listMembers(db).length > 1, () => {
                    /*
                     * Ordered by name, but opening on whoever pressing the button
                     * alone would give you — the oldest member still here. The two
                     * paths landing on two different people is the kind of small
                     * inconsistency that makes a demo feel unfinished.
                     */
                    const fallback = queryOne<{ id: string }>(
                      db,
                      `SELECT id FROM members WHERE removed_at IS NULL
                        ORDER BY created_at LIMIT 1`,
                    )?.id;
                    return html`
                      <div class="field">
                        <label for="demo-member">Look around as</label>
                        <select id="demo-member" name="member_id">
                          ${listMembers(db).map((m) => html`
                            <option value="${m.id}" ${raw(m.id === fallback ? "selected" : "")}>
                              ${m.name}
                            </option>
                          `)}
                        </select>
                      </div>
                    `;
                  })}
                  <button class="button button-primary" style="width:100%" type="submit">
                    Enter the demo
                  </button>
                </form>
                <p class="field-hint" style="margin-top:.75rem">
                  Three years of invented transactions across every part of the app.
                  Change whatever you like — it resets, and none of it is real.
                </p>
              </div>
            `,
          )}
          ${when(
            passwordSignInOffered(db, config),
            () => html`
              <div class="card">
                <form method="post" action="/auth/password">
                  <input type="hidden" name="next" value="${next}">
                  <div class="field">
                    <label for="pw-email">Email</label>
                    <input id="pw-email" type="email" name="email" required
                           autocomplete="username" autocapitalize="none" spellcheck="false">
                  </div>
                  <div class="field">
                    <label for="pw-password">Password</label>
                    <input id="pw-password" type="password" name="password" required
                           autocomplete="current-password">
                  </div>
                  <button class="button button-primary" style="width:100%" type="submit">
                    Sign in
                  </button>
                </form>
                ${when(
                  memberCount(db) === 0,
                  () => html`
                    <p class="field-hint" style="margin-top:.75rem">
                      This household has no members yet. The first person to set
                      a password becomes one and can invite the rest —
                      <a href="/auth/first-run">set it here</a>.
                    </p>
                  `,
                )}
              </div>
            `,
          )}
          ${when(
            oidcConfigured(config),
            () => html`
              <div class="card">
                <a class="button button-primary" style="width:100%"
                   href="/auth/oidc?next=${encodeURIComponent(next)}">
                  Continue with ${config.oidc.label}
                </a>
                <p class="field-hint" style="margin-top:.75rem">
                  ${memberCount(db) === 0
                    ? "This household has no members yet, so whoever signs in first becomes one."
                    : "Only household members on the allow-list can sign in."}
                </p>
              </div>
            `,
          )}
          ${googleConfigured
            ? html`
                <div class="card">
                  <a class="button button-primary" style="width:100%"
                     href="/auth/google?next=${encodeURIComponent(next)}">
                    Continue with Google
                  </a>
                  <p class="field-hint" style="margin-top:.75rem">
                    ${memberCount(db) === 0
                      ? "This household has no members yet, so whoever signs in first " +
                        "becomes one and can invite the rest (F1.3)."
                      : "Only household members on the allow-list can sign in."}
                  </p>
                </div>
              `
            : when(
                !config.demoMode,
                () => html`
                  ${when(!oidcConfigured(config), () => html`
                    <p class="notice notice-warning">
                      No way to sign in is configured. Set LOCAL_LOGIN=1 and create
                      the first password, or point OIDC_ISSUER at an identity
                      provider, or set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.
                    </p>
                  `)}
                `,
              )}
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
    /*
     * Not configured is a *deployment* state, not a server fault — a demo
     * instance never configures Google at all. A 500 here says the app broke;
     * it did not, and the person reading it can do nothing about a 500.
     */
    if (!config.google.clientId) {
      throw new HttpError(503, "Google sign-in is not configured on this deployment.");
    }
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

  /*
   * F1.7 · Any OpenID Connect provider.
   *
   * Same shape as the Google pair above, with the endpoints discovered from
   * the issuer rather than hard-coded. The pending map is shared, so a state
   * value minted for one flow cannot be replayed into the other.
   */
  router.get("/auth/oidc", async (ctx) => {
    if (!oidcConfigured(config)) throw new NotFound();
    const start = await beginOidc(
      {
        issuer: config.oidc.issuer!,
        clientId: config.oidc.clientId!,
        clientSecret: config.oidc.clientSecret!,
      },
      `${config.baseUrl}/auth/oidc/callback`,
      deps.fetchImpl,
    );
    pendingOAuth.set(start.state, {
      verifier: start.codeVerifier,
      next: safePath(ctx.query.get("next"), "/"),
      at: Date.now(),
    });
    return { redirect: start.url };
  });

  router.get("/auth/oidc/callback", async (ctx) => {
    const source = clientIp(ctx, config.trustProxy);
    if (isRateLimited(db, source)) {
      throw new HttpError(429, "Too many sign-in attempts. Try again in a few minutes.");
    }
    if (!oidcConfigured(config)) throw new NotFound();

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
      throw new HttpError(400, "The identity provider did not return a sign-in code.");
    }

    const profile = await exchangeOidcCode({
      config: {
        issuer: config.oidc.issuer!,
        clientId: config.oidc.clientId!,
        clientSecret: config.oidc.clientSecret!,
      },
      redirectUri: `${config.baseUrl}/auth/oidc/callback`,
      code,
      codeVerifier: pending.verifier,
      fetchImpl: deps.fetchImpl,
    });

    let member = findMemberByEmail(db, profile.email);

    // F1.3, as for Google: the first person in is the household's first member.
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

    /*
     * The avatar and name are refreshed, but `google_sub` is deliberately not
     * touched: this member did not sign in with Google, and writing another
     * provider's subject into that column would make the two indistinguishable.
     */
    db.prepare(`UPDATE members SET avatar_url = COALESCE(?, avatar_url), name = COALESCE(NULLIF(name,''), ?) WHERE id = ?`)
      .run(profile.picture, profile.name, member.id);

    const { token } = createSession(db, member.id, {
      userAgent: ctx.req.headers["user-agent"] ?? null,
      ipHint: source,
      days: config.sessionDays,
    });
    recordAuthAttempt(db, source, "success", profile.email);

    return {
      redirect: safePath(pending.next, "/"),
      headers: {
        "Set-Cookie": sessionCookie(token, {
          secure: config.baseUrl.startsWith("https"),
          days: config.sessionDays,
        }),
      },
    };
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
      // Sign-in is the worst place in the app for an open redirect: it lands
      // somebody on another site at the moment they have just authenticated.
      redirect: safePath(pending.next, "/"),
      headers: { "Set-Cookie": sessionCookie(token, { secure: config.baseUrl.startsWith("https"), days: config.sessionDays }) },
    };
  });

  /*
   * The demo front door. Unlike the development bypass this is meant to run on
   * a public hostname, so it is guarded by `DEMO_MODE` alone and signs everyone
   * into the same fictional member — there is nothing to choose between and
   * nothing real behind it.
   */
  router.post("/demo/enter", (ctx) => {
    if (!config.demoMode) throw new NotFound();
    /*
     * Whoever was picked, as long as they are still in the household — a removed
     * member is not somebody you can sign in as, here or anywhere. With nothing
     * picked (the one-button path, and every script that drives the demo) it is
     * the oldest member still here, which is what it always was.
     */
    const chosen = field(ctx.body, "member_id");
    const member =
      (chosen
        ? queryOne<{ id: string }>(
            db, `SELECT id FROM members WHERE id = ? AND removed_at IS NULL`, chosen,
          )
        : null)
      ?? queryOne<{ id: string }>(
        db, `SELECT id FROM members WHERE removed_at IS NULL ORDER BY created_at LIMIT 1`,
      );
    if (!member) throw new NotFound();

    const { token } = createSession(db, member.id, {
      userAgent: ctx.req.headers["user-agent"] ?? null,
      ipHint: clientIp(ctx, config.trustProxy),
      days: 1,
    });
    return {
      redirect: "/",
      headers: {
        "Set-Cookie": sessionCookie(token, {
          secure: config.baseUrl.startsWith("https"),
          days: 1,
        }),
      },
    };
  });

  /*
   * F1.6 · Password sign-in.
   *
   * Offered when LOCAL_LOGIN is set, and also whenever a password already
   * exists — so that turning the flag off cannot lock out a household that is
   * relying on it, which would otherwise be a one-character way to lose access
   * to your own ledger.
   */
  router.post("/auth/password", (ctx) => {
    const source = clientIp(ctx, config.trustProxy);
    if (isRateLimited(db, source)) {
      throw new HttpError(429, "Too many sign-in attempts. Try again in a few minutes.");
    }
    if (!passwordSignInOffered(db, config)) throw new NotFound();

    const email = String(field(ctx.body, "email") ?? "").trim().toLowerCase();
    const password = String(field(ctx.body, "password") ?? "");
    const member = email ? (findMemberByEmail(db, email) ?? null) : null;

    /*
     * One message for "no such member", "no password set" and "wrong
     * password". Telling them apart tells an attacker which addresses are
     * members of this household, which is worth more than it looks on an app
     * whose whole point is that the membership is a family.
     */
    const refuse = () => {
      recordAuthAttempt(db, source, "bad-password", email || undefined);
      throw new HttpError(401, "That email and password do not match.");
    };

    if (!member || member.removed_at || !member.allowed) refuse();

    const result = checkPassword(db, member!.id, password);
    if (!result.ok) {
      if (result.reason === "locked") {
        recordAuthAttempt(db, source, "locked", email);
        throw new HttpError(
          429,
          "Too many wrong passwords for that account. It is locked for a few minutes.",
        );
      }
      refuse();
    }

    const { token } = createSession(db, member!.id, {
      userAgent: ctx.req.headers["user-agent"] ?? null,
      ipHint: source,
      days: config.sessionDays,
    });
    recordAuthAttempt(db, source, "success", email);

    return {
      redirect: result.ok && result.mustChange
        ? "/settings/password"
        : safePath(field(ctx.body, "next") ?? "/", "/"),
      headers: {
        "Set-Cookie": sessionCookie(token, {
          secure: config.baseUrl.startsWith("https"),
          days: config.sessionDays,
        }),
      },
    };
  });

  /*
   * The first password on an empty household, which is the only way in when
   * Google is not configured. Guarded by there being no members at all — the
   * same door F1.3 opens for the first Google sign-in, and it closes the moment
   * anybody walks through it.
   */
  router.get("/auth/first-run", (ctx) => {
    if (!config.localLogin || memberCount(db) !== 0) throw new NotFound();
    return render(
      ctx,
      "Set the first password",
      html`
        <div style="max-width:26rem;margin:3rem auto">
          <h1>Set the first password</h1>
          <p class="muted">
            This household has no members. Whoever sets this becomes the first
            one, and can invite the rest.
          </p>
          <form class="card" method="post" action="/auth/first-run">
            <div class="field">
              <label for="fr-name">Your name</label>
              <input id="fr-name" type="text" name="name" required autocomplete="name">
            </div>
            <div class="field">
              <label for="fr-email">Email</label>
              <input id="fr-email" type="email" name="email" required
                     autocomplete="username" autocapitalize="none" spellcheck="false">
            </div>
            <div class="field">
              <label for="fr-password">Password</label>
              <input id="fr-password" type="password" name="password" required
                     autocomplete="new-password" minlength="12">
              <p class="field-hint">
                At least 12 characters. Length is what makes a password hard to
                guess — three or four words beats a short one with symbols in it.
              </p>
            </div>
            <button class="button button-primary" style="width:100%" type="submit">
              Create the household
            </button>
          </form>
        </div>
      `,
      { bare: true },
    );
  });

  router.post("/auth/first-run", (ctx) => {
    if (!config.localLogin || memberCount(db) !== 0) throw new NotFound();
    const source = clientIp(ctx, config.trustProxy);

    const email = String(requiredField(ctx.body, "email")).trim().toLowerCase();
    const name = String(requiredField(ctx.body, "name")).trim();
    const password = String(requiredField(ctx.body, "password"));

    const member = inviteMember(db, { memberId: null, source: "system" }, { email, name });
    setPassword(db, member.id, password);

    const { token } = createSession(db, member.id, {
      userAgent: ctx.req.headers["user-agent"] ?? null,
      ipHint: source,
      days: config.sessionDays,
    });
    recordAuthAttempt(db, source, "success", email);

    return {
      redirect: "/",
      message: "Household created. Invite the others from Settings.",
      headers: {
        "Set-Cookie": sessionCookie(token, {
          secure: config.baseUrl.startsWith("https"),
          days: config.sessionDays,
        }),
      },
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
      headers: {
        "Set-Cookie": sessionCookie(token, {
          secure: config.baseUrl.startsWith("https"),
          days: config.sessionDays,
        }),
      },
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
    /*
     * 15 · The log narrates everything in words, so it has to be told whose
     * money it is narrating. Fetch more than the page needs and filter, so the
     * page still fills when some of it is somebody else's.
     */
    const canSee = eventVisibility(db, viewer(ctx));
    const events = queryEvents(db, { entity: entity ?? undefined, limit: 400 })
      .filter(canSee)
      .slice(0, 100);

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
  /*
   * The demo is a public instance somebody operates, and a self-hosted install
   * is not, so they cannot truthfully say the same things about who is
   * responsible for the data. Each renders what is true of itself.
   */
  const legalMode: LegalMode = config.demoMode ? "demo" : "self-hosted";

  router.get("/privacy", (ctx) =>
    render(
      ctx,
      "Privacy policy",
      renderPrivacy({ appName: "Pathayam", updated: LEGAL_UPDATED, mode: legalMode }),
      { bare: true },
    ),
  );

  router.get("/terms", (ctx) =>
    render(
      ctx,
      "Terms of service",
      renderTerms({ appName: "Pathayam", updated: LEGAL_UPDATED, mode: legalMode }),
      { bare: true },
    ),
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
    const scope = budgetParam(ctx);
    const view = buildBudgetView(db, month, scope, viewer(ctx));

    // The digest belongs to the person reading, not to the month being read,
    // so it only shows on the current month.
    const digest = month === view.currentMonth
      ? renderDigest(digestFor(db, a.viewingAs.id))
      : undefined;

    // 15 · The switcher lives in the sidebar now, on every screen that shows one
    // budget's money. A second copy at the top of this one was the same control
    // twice, and the sidebar's is the one that is always there.
    return render(ctx, formatMonth(month), renderBudget(view, digest));
  });

  /*
   * 15 · Your own budget, created on request.
   *
   * Not created for everybody up front: an empty personal budget nobody asked
   * for is a second grid to ignore, and the household one is the right default
   * for a household that pools its money.
   */
  router.post("/budgets/personal", (ctx) => {
    return mutate(ctx, (a) => {
      const budget = ensurePersonalBudget(db, a.member.id, a.member.name);
      rememberBudget(db, a.member.id, budget.id);
      /*
       * 15 §3 · The envelope for the household comes with the budget.
       *
       * Making it on demand would mean a screen that says "set this up first"
       * between the member and the thing they were trying to do, and there is
       * only ever one right answer to that question.
       */
      const actor = actorFor(a, "ui", ctx.req.headers["idempotency-key"] as string);
      ensureCommitmentEnvelope(db, actor, budget.id);
      // `03` J1 · Never an empty grid. A few envelopes to start from, which can
      // all be renamed or deleted.
      startPersonalBudget(db, actor, budget.id);
      return {
        redirect: `/?budget=${budget.id}`,
        message: `${budget.name}'s budget is ready. Move an account into it to give it money.`,
      };
    });
  });

  /*
   * P3 · What each of us has put toward the shared money.
   *
   * Reachable whether or not anybody keeps a separate budget: for a household
   * that pools everything it explains the choice rather than 404ing on it.
   */
  /*
   * 15 §4A.3 · Picking it up. An ordinary assignment into your own commitment
   * envelope, and it is a route of its own only so the household screen can say
   * what it means rather than sending somebody to the grid to work it out.
   */
  router.post("/household/pick-up", (ctx) =>
    mutate(ctx, (a) => {
      const month = monthParam(ctx);
      const envelopeId = requireVisibleCategory(ctx, requiredField(ctx.body, "envelope_id"))!;
      const extra = amountField(requiredField(ctx.body, "amount"), "Amount");
      const actor = actorFor(a, "ui", ctx.req.headers["idempotency-key"] as string);

      const own = personalBudgetFor(db, a.member.id);
      const envelope = getCategory(db, envelopeId);
      if (!own || envelope?.budget_id !== own.id) {
        throw new HttpError(403, "You can only commit from your own budget.");
      }

      // On top of what is already committed, not instead of it.
      const view = buildBudgetView(db, month, own.id, viewer(ctx));
      const already = view.categories.get(envelopeId)?.state.assigned ?? 0;
      setAssigned(db, actor, month, envelopeId, (already + extra) as Paise);

      return {
        redirect: "/household",
        message: `You have picked up ${formatPaise(extra as Paise)}.`,
      };
    }),
  );

  /*
   * 15 §4A.4 · Calling it even. The only one of the three that lets something go,
   * and the amount lands in a real envelope on the giving side — because the money
   * still has to come from somewhere, and the card bill is owed either way.
   */
  router.post("/household/call-it-even", (ctx) =>
    mutate(ctx, (a) => {
      const call = callItEven(db, actorFor(a, "ui", ctx.req.headers["idempotency-key"] as string), {
        envelopeId: requireVisibleCategory(ctx, requiredField(ctx.body, "envelope_id"))!,
        amount: amountField(requiredField(ctx.body, "amount"), "Amount") as Paise,
        givingCategoryId: requireVisibleCategory(ctx, field(ctx.body, "giving_category_id") || null) || undefined,
        month: monthParam(ctx),
        note: field(ctx.body, "note") || null,
      });
      return {
        redirect: "/household",
        message:
          `Called ${formatPaise(call.amount)} even. It is now spending on the ` +
          `giving side, so give that envelope the money it needs.`,
      };
    }),
  );

  router.get("/household", (ctx) => {
    const month = monthParam(ctx);
    const view = buildHouseholdView(db, month);
    const me = viewer(ctx);
    const own = me ? personalBudgetFor(db, me) : null;
    const canOpenOwn = Boolean(me) && !own;

    // Only your own plan is editable here. Another member's figure is theirs to
    // set, and the page shows it without offering to change it.
    const envelope = own ? commitmentEnvelope(db, own.id) : null;
    const mine = envelope
      ? {
          categoryId: envelope.id,
          target: getTarget(db, envelope.id)?.amount ?? null,
          available: view.members.find((m) => m.categoryId === envelope.id)?.available ?? 0,
        }
      : undefined;

    return render(ctx, "The household's money", renderHousehold(view, canOpenOwn, mine));
  });

  router.post("/assign", (ctx) =>
    mutate(ctx, (a) => {
      const month = monthParam(ctx);
      const categoryId = requireVisibleCategory(ctx, requiredField(ctx.body, "category_id"))!;
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
    const view = buildBudgetView(db, month, undefined, viewer(ctx));
    const to = ctx.query.get("to");
    /*
     * Rupees, as typed. It used to be paise, because every caller was a generated
     * link — and then a form that a person fills in started pointing here, and
     * "36640.00" was read as ₹366.40. Parsing it the way every other amount field
     * is parsed makes the two kinds of caller agree, and makes the URL readable.
     */
    const amountRaw = ctx.query.get("amount");
    const amountParam = amountRaw?.trim() ? amountField(amountRaw, "Amount") : null;

    /*
     * 15 · Only envelopes this viewer can see.
     *
     * `monthState.categories` is the engine's map and holds every category in
     * the household, including another member's private ones; `view.categories`
     * is the filtered one. Handing the first to the suggester offered somebody
     * else's envelope as a place to take money from, with its balance printed
     * on the chip — the leak the budget picker on this same page was already
     * fixed for. It showed up as a raw id rather than a name only because the
     * name map was built from the filtered view, so the disclosure the names
     * would have completed was half-hidden by accident rather than on purpose.
     *
     * POST /move refuses an invisible category on both ends, so nobody could
     * act on the suggestion. Seeing the balance was the whole of the harm, and
     * it was enough.
     */
    const visibleStates = new Map(
      [...view.monthState.categories].filter(([id]) => view.categories.has(id)),
    );

    const suggestions = to
      ? suggestCoverSources(to, visibleStates, {
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
        amount: amountParam,
        suggestions,
        readyToAssign: view.monthState.readyToAssign,
      }),
    );
  });

  router.post("/move", (ctx) =>
    mutate(ctx, (a) => {
      const month = monthParam(ctx);
      const actor = actorFor(a, "ui", ctx.req.headers["idempotency-key"] as string);
      const from = requireVisibleCategory(ctx, requiredField(ctx.body, "from_category_id"))!;
      const to = requireVisibleCategory(ctx, requiredField(ctx.body, "to_category_id"))!;
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
    const view = buildBudgetView(db, month, undefined, viewer(ctx));
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
    const view = buildBudgetView(db, month, undefined, viewer(ctx));
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
    // No viewer: this is the budget's own plan, not a list somebody is shown.
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
    const view = buildBudgetView(db, month, undefined, viewer(ctx));
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
    const view = buildBudgetView(db, month, undefined, viewer(ctx));
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
    /*
     * 15 · The accounts of the budget being looked at, plus the tracking accounts,
     * which fund no budget and so belong to the household's picture whichever one
     * is selected (FW1).
     */
    const scope = budgetParam(ctx);
    const view = buildBudgetView(db, undefined, scope, viewer(ctx));

    const memberNames = new Map(listMembers(db).map((m) => [m.id, m.name]));
    const rows: AccountRow[] = listAccounts(db, { viewerMemberId: viewer(ctx) })
      .filter((account) => account.kind === "tracking" || account.budget_id === scope)
      .map((account) => {
      const recon = queryOne<{ as_of: string; broken_at: string | null }>(
        db,
        `SELECT as_of, broken_at FROM reconciliations WHERE account_id = ? ORDER BY as_of DESC LIMIT 1`,
        account.id,
      );
      const paymentCategory = account.kind === "credit" ? paymentCategoryFor(db, account.id) : null;
      const funded = paymentCategory ? view.categories.get(paymentCategory.id)?.state.balance ?? 0 : 0;

      return {
        account,
        holderName: account.holder_member_id ? memberNames.get(account.holder_member_id) ?? null : null,
        balances: balances.get(account.id)!,
        derived: derivedWorth(db, account, viewer(ctx)),
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

    return render(
      ctx, "Accounts",
      renderAccountList(
        rows,
        budgetsFor(db, viewer(ctx)).map((b) => ({ id: b.id, name: b.name, kind: b.kind })),
      ),
    );
  });

  router.get("/accounts/new", (ctx) =>
    render(ctx, "Add an account", renderNewAccountForm({
      members: listMembers(db).map((m) => ({ id: m.id, name: m.name })),
      budgets: budgetsFor(db, viewer(ctx)).map((b) => ({ id: b.id, name: b.name, kind: b.kind })),
    })));

  /*
   * B70 · F2.7 · Rename or close an account.
   *
   * `updateAccount`, `closeAccount` and `reopenAccount` were all written long
   * ago and none of them had a route, so an account could be created and never
   * touched again. Closing is not deletion: the history, the balances and the
   * reconciliations all stay, and only the pick-lists lose it.
   */
  router.post("/accounts/:id/edit", (ctx) =>
    mutate(ctx, (a) => {
      const id = requireVisibleAccount(ctx, ctx.params.id!).id;
      const text = (name: string) => {
        const value = field(ctx.body, name)?.trim();
        return value === undefined ? undefined : value === "" ? null : value;
      };
      updateAccount(db, actorFor(a, "ui", ctx.req.headers["idempotency-key"] as string), id, {
        name: requiredField(ctx.body, "name"),
        nickname: text("nickname"),
        institution: text("institution"),
        last4: text("last4"),
        holder_member_id: text("holder_member_id"),
        statement_day: numberOrNull(field(ctx.body, "statement_day")),
        due_day: numberOrNull(field(ctx.body, "due_day")),
        // 15 · Moving an account between budgets is one undoable step, recorded
        // like any other edit, because it moves money's home.
        budget_id: text("budget_id"),
        visibility: field(ctx.body, "visibility") === "private" ? "private"
          : field(ctx.body, "visibility") === "household" ? "household" : undefined,
      });
      return { redirect: `/accounts/${id}`, message: "Saved." };
    }),
  );

  router.post("/accounts/:id/close", (ctx) =>
    mutate(ctx, (a) => {
      const id = ctx.params.id!;
      const account = requireVisibleAccount(ctx, id);
      closeAccount(db, actorFor(a, "ui", ctx.req.headers["idempotency-key"] as string), id);
      return {
        redirect: `/accounts/${id}`,
        message: `${account.nickname || account.name} is closed. Its history is untouched.`,
      };
    }),
  );

  router.post("/accounts/:id/reopen", (ctx) =>
    mutate(ctx, (a) => {
      const id = requireVisibleAccount(ctx, ctx.params.id!).id;
      reopenAccount(db, actorFor(a, "ui", ctx.req.headers["idempotency-key"] as string), id);
      return { redirect: `/accounts/${id}`, message: "Reopened." };
    }),
  );

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
        openingDate: dateField(openingDateRaw, "Opening date"),
        statementDay: numberOrNull(field(ctx.body, "statement_day")),
        dueDay: numberOrNull(field(ctx.body, "due_day")),
        // 15 · Whose money it is, and who can see it, are settled at creation
        // rather than as a second edit nobody remembers to make.
        budgetId: field(ctx.body, "budget_id") || undefined,
        visibility: field(ctx.body, "visibility") === "private" ? "private" : undefined,
      });

      return { redirect: `/accounts/${account.id}`, message: `Added ${account.name}.` };
    }),
  );

  router.get("/accounts/:id", (ctx) => {
    auth(ctx);
    const account = requireVisibleAccount(ctx, ctx.params.id!);

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
        // R6 · The cycle this charge bills in, derived from the card's statement
        // day. Cycles are not calendar months, so the register says which.
        statementPeriod:
          account.kind === "credit" && account.statement_day
            ? statementPeriodOf(r.date, account.statement_day).label
            : null,
        runningBalance: running,
      };
      running -= r.amount;
      return row;
    });

    const paymentCategory = account.kind === "credit" ? paymentCategoryFor(db, account.id) : null;
    const view = paymentCategory ? buildBudgetView(db, undefined, undefined, viewer(ctx)) : null;
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
        derived: derivedWorth(db, account, viewer(ctx)),
        // A hand-valued asset has no transactions and never will, so its
        // register shows the valuations instead of staying empty forever.
        assetEvents: REVALUABLE_SUBTYPES.has(account.subtype)
          ? assetHistory(db, account.id)
          : null,
        members: listMembers(db).map((m) => ({ id: m.id, name: m.name })),
        budgets: budgetsFor(db, viewer(ctx)).map((b) => ({ id: b.id, name: b.name, kind: b.kind })),
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
                account.opening_balance,
              )
            : null,
        paymentCategoryName: paymentCategory?.name ?? null,
        paymentCategoryId: paymentCategory?.id ?? null,
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
    const view = buildBudgetView(db, undefined, undefined, viewer(ctx));
    /*
     * Only accounts where a plain transaction means something.
     *
     * Not "not tracking" — most tracking accounts are worth exactly their
     * balance, and posting to them is how you record what happened. A fixed
     * deposit crediting interest, a savings account somebody watches without
     * budgeting from it: both are transactions, and both belong here.
     *
     * What does not is an account whose figure is derived somewhere else: a
     * demat account (the market value of its holdings), a loan or an EMI (an
     * amortisation schedule), a family loan (the transfers behind it), and the
     * hand-valued kinds (a dated valuation). A transaction against one of those
     * is stored and then reflected in none of them — and each has a flow that
     * does work, so offering the account here only ever leads somewhere wrong.
     */
    const accounts = listAccounts(db, { viewerMemberId: viewer(ctx) })
      .filter((a) => !DERIVED_VALUE_SUBTYPES.has(a.subtype));
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
        payees: listPayees(db, viewer(ctx)).map((p) => {
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
        budgets: budgetsFor(db, viewer(ctx)).map((b) => ({ id: b.id, name: b.name, kind: b.kind })),
        members: listMembers(db).map((m) => ({ id: m.id, name: m.name })),
        defaultSpenderId: viewer(ctx),
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

      /*
       * B99 · An expense has to name the envelope it came out of.
       *
       * "Uncategorised — I'll sort it later" was an option on this form, and
       * later mostly never came: three years of real use left a queue of them,
       * each one money that had left the household with no envelope recording
       * it. Income is different and stays optional — its job is to arrive in
       * Ready to Assign and wait to be given one, which is the whole model.
       */
      if (direction !== "in" && !requireVisibleCategory(ctx, field(ctx.body, "category_id") || null)) {
        throw new HttpError(
          400,
          "Which envelope did this come out of? Money in doesn't need one — money out does.",
        );
      }

      createTransaction(db, actorFor(a, "ui", ctx.req.headers["idempotency-key"] as string), {
        accountId: requiredField(ctx.body, "account_id"),
        amount: direction === "in" ? magnitude : -magnitude,
        date: dateField(dateRaw),
        payeeName: field(ctx.body, "payee") || null,
        categoryId: requireVisibleCategory(ctx, field(ctx.body, "category_id") || null) || null,
        memo: field(ctx.body, "memo") || null,
        tags,
        cleared: field(ctx.body, "cleared") === "1",
        reimbursable: field(ctx.body, "reimbursable") === "1",
        // H2 · Who spent it. A card with its own holder still wins — an add-on
        // charge belongs to whoever holds the add-on (R6.e).
        ownerMemberId: field(ctx.body, "owner_member_id") || undefined,
      });

      return { redirect: "/", message: `Saved ${formatPaise(magnitude)}.` };
    }),
  );

  // B51: the form that was missing — POST /transfer shipped, but no GET
  // rendered a form and the only link 405'd. Transfers underpin card payments,
  // asset purchases and family lending.
  router.get("/transfer", (ctx) => {
    auth(ctx);
    const accounts = listAccounts(db, { viewerMemberId: viewer(ctx) });
    return render(
      ctx,
      "Record a transfer",
      renderTransfer({
        accounts,
        defaultFrom: ctx.query.get("from"),
        defaultTo: ctx.query.get("to"),
        today: todayIST(),
        // Only envelopes this viewer can see, and never a card's payment
        // envelope — the domain refuses one, so offering it would be a choice
        // that always fails.
        categories: [...buildBudgetView(db, undefined, undefined, viewer(ctx)).categories.values()]
          .filter((c) => !c.hidden && !c.isPaymentCategory)
          .map((c) => ({ id: c.id, name: c.name })),
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
      const feeRaw = String(field(ctx.body, "fee_amount") ?? "").trim();
      const feeAmount = feeRaw ? Math.abs(amountField(feeRaw, "Charge")) : 0;
      const feeCategory = field(ctx.body, "fee_category_id");
      if (feeAmount > 0 && !feeCategory) {
        throw new Refusal("A bank charge needs an envelope to come out of.");
      }

      createTransfer(db, actorFor(a, "ui", ctx.req.headers["idempotency-key"] as string), {
        fromAccountId,
        toAccountId,
        amount: Math.abs(amountField(field(ctx.body, "amount"))),
        date: dateField(field(ctx.body, "date")),
        fee: feeAmount > 0
          ? { amount: feeAmount as Paise, categoryId: requireVisibleCategory(ctx, feeCategory!)! }
          : null,
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
      return { redirect: safePath(field(ctx.body, "return_to"), "/") };
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

  router.post("/impersonate/start", (ctx) => {
    if (!config.adminDebug) throw new NotFound();
    return mutate(ctx, (a) => {
      startImpersonation(db, actorFor(a), a.session.id, requiredField(ctx.body, "member_id"));
      return { redirect: "/", message: "Now viewing as another member, read only." };
    });
  });

  router.post("/impersonate/writes", (ctx) => {
    if (!config.adminDebug) throw new NotFound();
    return mutate(ctx, (a) => {
      const allow = field(ctx.body, "allow") === "1";
      setImpersonationWrites(db, actorFor(a), a.session.id, allow);
      // B51: return to where the toggle was clicked (the banner is on every
      // page), not always /settings.
      return {
        redirect: safePath(field(ctx.body, "return_to"), "/settings"),
        message: allow ? "Writes enabled while viewing as them." : "Back to read-only.",
      };
    });
  });

  router.post("/impersonate/exit", (ctx) => {
    if (!config.adminDebug) throw new NotFound();
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
    // F1.6 · Removed is a state, not a deletion.
    const removedMembers = listMembers(db, { includeRemoved: true })
      .filter((m) => m.removed_at !== null);
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

        ${when(
          !config.demoMode,
          () => renderGmailConnection(connectionView(db, a.member.id), config.google.clientId !== null),
        )}

        ${when(!config.demoMode, () => renderStatementIdentity(maskedIdentity(db, a.member.id)))}
        ${when(
          config.demoMode,
          () => html`
            <section class="card">
              <h2>Mailbox and statement passwords</h2>
              <p class="faint" style="margin-top:-.25rem">
                Connecting a mailbox and saving the identity that unlocks statement
                PDFs are both turned off here — a public demo should hold neither.
                Both work on your own copy.
              </p>
            </section>
          `,
        )}

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
                The category starts the next month at zero, and next month's Ready to
                Assign is reduced by the overspend. Keeps the pain in the one place you
                actually look, and stops a category building up invisible debt over
                several months.
              </p>
            </div>
            <div class="field">
              <label>
                <input type="radio" name="model" value="carry-negative"
                       ${raw(overspendModel === "carry-negative" ? "checked" : "")}>
                Carry the negative balance on the category
              </label>
              <p class="field-hint">
                The category starts the next month in the red and Ready to
                Assign is untouched — the overspend stays attached to whatever
                caused it.
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
                <span class="row" style="gap:.4rem">
                  ${m.id === a.member.id
                    ? html`<span class="chip">You</span>`
                    : html`
                        ${when(
                          config.adminDebug,
                          () => html`
                            <form method="post" action="/impersonate/start">
                              <input type="hidden" name="member_id" value="${m.id}">
                              <button class="button-small" type="submit">View as</button>
                            </form>
                          `,
                        )}
                        <!--
                          F1.6 · Removing is reversible and keeps every historical
                          attribution, so it is a link to a page that says what will
                          happen rather than a button that does it.
                        -->
                        <!--
                          Shown on the demo too. The page is an explanation of
                          what leaving costs and which endings are on offer —
                          exactly what a demo is for — and the POST behind it
                          still refuses. Hiding the link left the page reachable
                          only by typing its URL.
                        -->
                        <a class="button button-small" href="/members/${m.id}/remove">Remove</a>
                      `}
                </span>
              </div>
            `,
          )}
          <!--
            F1.6 · Somebody removed is not gone: their transactions keep their name
            and adding them back clears the removal. Showing them here is what makes
            that discoverable, instead of a person having to guess that re-inviting
            the same address restores everything.
          -->
          ${when(removedMembers.length > 0, () => html`
            <p class="faint" style="margin-top:1rem">No longer in the household</p>
            ${removedMembers.map(
              (m) => html`
                <div class="row-between" style="padding:.5rem 0;border-top:1px solid var(--border)">
                  <div>
                    <strong>${m.name}</strong>
                    <div class="faint">${m.email} · everything they entered is still here</div>
                  </div>
                  ${when(!config.demoMode, () => html`
                    <form method="post" action="/members/invite">
                      <input type="hidden" name="email" value="${m.email}">
                      <button class="button-small" type="submit">Add back</button>
                    </form>
                  `)}
                </div>
              `,
            )}
          `)}
          ${when(
            !config.demoMode,
            () => html`
              <form method="post" action="/members/invite" style="margin-top:1rem">
                <div class="field">
                  <label for="invite-email">Add a household member</label>
                  <input id="invite-email" name="email" type="email" required
                         placeholder="partner@example.com">
                  <p class="field-hint">They'll be able to sign in with that Google account.</p>
                </div>
                <button type="submit">Add to the allow-list</button>
              </form>
            `,
          )}
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
  /*
   * F1.6 · Setting and changing a password.
   *
   * Reachable whenever password sign-in is offered, including for a member who
   * signs in with Google today: having a second way in is the point, and the
   * moment somebody wants to stop depending on Google they need to be able to
   * set one without an administrator.
   */
  router.get("/settings/password", (ctx) => {
    const a = auth(ctx);
    if (!passwordSignInOffered(db, config)) throw new NotFound();
    const existing = hasPassword(db, a.member.id);

    return render(
      ctx,
      existing ? "Change your password" : "Set a password",
      html`
        <div class="prose-page">
          <p class="faint"><a href="/settings">← Settings</a></p>
          <h1>${existing ? "Change your password" : "Set a password"}</h1>
          <p>
            ${existing
              ? html`Changing it does not sign out your other sessions. End those
                     from <a href="/settings">Settings</a> if you need to.`
              : html`A password is a second way into this household that does not
                     depend on anybody else's service. You can keep using Google
                     as well.`}
          </p>
          <form class="card" method="post" action="/settings/password">
            ${when(existing, () => html`
              <div class="field">
                <label for="pw-current">Current password</label>
                <input id="pw-current" type="password" name="current" required
                       autocomplete="current-password">
              </div>
            `)}
            <div class="field">
              <label for="pw-new">New password</label>
              <input id="pw-new" type="password" name="password" required
                     autocomplete="new-password" minlength="12">
              <p class="field-hint">
                At least 12 characters. Length is what makes a password hard to
                guess — three or four words beats a short one with symbols in it.
              </p>
            </div>
            <div class="field">
              <label for="pw-confirm">New password again</label>
              <input id="pw-confirm" type="password" name="confirm" required
                     autocomplete="new-password">
            </div>
            <button class="button button-primary" type="submit">
              ${existing ? "Change it" : "Set it"}
            </button>
          </form>
        </div>
      `,
      { bare: true },
    );
  });

  router.post("/settings/password", (ctx) =>
    mutate(ctx, (a) => {
      if (!passwordSignInOffered(db, config)) throw new NotFound();

      const password = String(requiredField(ctx.body, "password"));
      const confirm = String(requiredField(ctx.body, "confirm"));
      if (password !== confirm) {
        throw new Refusal("Those two passwords are not the same.");
      }

      /*
       * Changing an existing password requires the old one. Without this, a
       * borrowed session — a shared laptop, a phone left unlocked — becomes a
       * permanent takeover rather than a temporary one.
       */
      if (hasPassword(db, a.member.id)) {
        const current = String(field(ctx.body, "current") ?? "");
        if (!checkPassword(db, a.member.id, current).ok) {
          throw new Refusal("That is not your current password.");
        }
      }

      setPassword(db, a.member.id, password);
      return { redirect: "/settings", message: "Password set." };
    }),
  );

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

  /*
   * 15 §6A · Leaving is a decision with money attached, so it is a page rather
   * than a button. Every option is offered and the app never picks.
   */
  router.get("/members/:id/remove", (ctx) => {
    auth(ctx);
    /*
     * Readable on the demo, and not doable — the POST still refuses. What this
     * page is *for* is showing what leaving costs and which endings are on
     * offer, which is exactly the thing a demo exists to show; refusing the read
     * as well left the one page in the app whose whole content is an explanation
     * behind a 403.
     */
    const departure = describeDeparture(db, ctx.params.id!);
    return render(
      ctx, `Removing ${departure.memberName}`,
      renderDeparture(departure, monthOf(todayIST())),
    );
  });

  /*
   * 06 §7.4 · Converting a card purchase to EMI.
   *
   * F8.5 had said the app must support this since the functional design, and the
   * only thing that existed was a loan *type* — so a household could record the
   * plan by hand and still be asked to clear the same purchase on the card, which
   * is the exact double-funding §7.4 warns about.
   */
  router.post("/transaction/:id/convert-to-emi", (ctx) =>
    mutate(ctx, (a) => {
      const amountRaw = field(ctx.body, "amount");
      const feeRaw = field(ctx.body, "processing_fee");
      const result = convertToEmi(db, actorFor(a, "ui", ctx.req.headers["idempotency-key"] as string), {
        transactionId: ctx.params.id!,
        amount: amountRaw?.trim() ? (amountField(amountRaw, "Amount") as Paise) : undefined,
        tenureMonths: Number(requiredField(ctx.body, "tenure_months")),
        annualRatePct: Number(requiredField(ctx.body, "annual_rate")),
        processingFee: feeRaw?.trim() ? (amountField(feeRaw, "Processing fee") as Paise) : undefined,
        feeCategoryId: requireVisibleCategory(ctx, field(ctx.body, "fee_category_id") || null) || null,
        nameSuffix: field(ctx.body, "name_suffix") || null,
      });
      return {
        redirect: `/loans/${result.loan.id}`,
        message:
          `Converted. ${formatPaise(result.emi)} a month, costing ` +
          `${formatPaise(result.totalCostOfBorrowing)} in interest and fees.`,
      };
    }),
  );

  router.post("/members/:id/remove", (ctx) => {
    refuseInDemo(config, "Removing members");
    return mutate(ctx, (a) => {
      const actor = actorFor(a, "ui", ctx.req.headers["idempotency-key"] as string);
      const id = ctx.params.id!;
      const resolution = field(ctx.body, "resolution") as DepartureResolution | undefined;

      const departure = describeDeparture(db, id);
      if (departure.standing !== "even" && !resolution) {
        throw new HttpError(
          400,
          `There is ${formatPaise(departure.outstanding)} outstanding with ` +
          `${departure.memberName}. Say how it should end before removing them.`,
        );
      }

      const settled = resolution ? settleDeparture(db, actor, id, resolution) : null;
      removeMember(db, actor, id);
      return {
        redirect: "/settings",
        message:
          `${departure.memberName} is no longer in the household.` +
          (settled ? ` ${settled}` : "") +
          ` Everything they entered is kept, and adding them back restores them.`,
      };
    });
  });

  router.post("/members/invite", (ctx) => {
    refuseInDemo(config, "Inviting members");
    return mutate(ctx, (a) => {
      const member = inviteMember(db, actorFor(a), { email: requiredField(ctx.body, "email") });
      return { redirect: "/settings", message: `${member.email} can now sign in.` };
    });
  });

  // -------------------------------------------------------------------------
  // Transaction detail and edit — where R7.b's confirmation actually fires
  // -------------------------------------------------------------------------
  router.get("/transaction/:id", (ctx) => {
    auth(ctx);
    const transaction = requireVisibleTransaction(ctx, ctx.params.id!);

    const account = getAccount(db, transaction.account_id)!;
    const view = buildBudgetView(db, monthOf(transaction.date), undefined, viewer(ctx));
    // The payee is the obvious name for a plan converted from this purchase.
    const payeeName = transaction.payee_id
      ? getPayee(db, transaction.payee_id)?.name ?? null
      : null;
    // F4.9 / F25.12: the raw imported values and the full event history.
    const history = historyFor(db, "transaction", transaction.id);
    const rules = queryAll<{ name: string }>(
      db,
      `SELECT r.name FROM rule_applications ra JOIN rules r ON r.id = ra.rule_id
        WHERE ra.transaction_id = ?`,
      transaction.id,
    );
    // F4.3 · A split transaction's lines, and the tags, are part of the record
    // this screen edits — a form that hid them destroyed them on save.
    const splits = transaction.is_split ? getSplits(db, transaction.id) : [];
    const tags = tagsFor(db, transaction.id).join(", ");
    const members = listMembers(db);
    const categoryName = new Map(
      [...view.categories.values()].map((c) => [c.id, c.name]),
    );
    const splitRows = [
      ...splits.map((s) => ({ categoryId: s.category_id, amount: Math.abs(s.amount) })),
      { categoryId: null, amount: null },
      { categoryId: null, amount: null },
    ];
    const envelopeOptions = (selected: string | null) =>
      [...view.categories.values()]
        .filter((c) => !c.isPaymentCategory && !c.hidden)
        .map((c) => html`
          <option value="${c.id}" ${raw(c.id === selected ? "selected" : "")}>${c.name}</option>
        `);

    return render(
      ctx,
      "Transaction",
      html`
        <div class="row-between" style="align-items:flex-start">
          <div>
            <h1 style="margin-bottom:.15rem">${formatPaise(Math.abs(transaction.amount))}</h1>
            <p class="muted" style="margin:0">
              ${account.nickname || account.name} · ${transaction.date}
            </p>
          </div>
          <!--
            06 §7.4 · A button, not a disclosure. Converting is a thing the bank
            offers and the household decides in the moment; hiding it behind a
            summary line is how the account edit form and the loan holder control
            both ended up reported as missing.
          -->
          ${when(account.kind === "credit" && transaction.amount < 0, () => html`
            <a class="button button-primary" href="#emi">Convert to EMI</a>
          `)}
        </div>

        ${when(account.kind === "credit" && transaction.amount < 0, () => html`
          <details class="card" id="emi">
            <summary class="linkish">The bank offered to convert this to EMI</summary>
            <p class="muted" style="margin-top:.75rem">
              The converted amount comes off this card's balance and becomes a loan
              with its own instalments — so you are not asked to clear it here
              <em>and</em> pay it monthly. The processing fee is charged to the card
              like any purchase, so give it an envelope.
            </p>
            <form method="post" action="/transaction/${transaction.id}/convert-to-emi">
              <div class="grid-2">
                <div class="field">
                  <label for="emi-amount">How much of it</label>
                  <input id="emi-amount" name="amount" class="amount-input" type="text"
                         inputmode="decimal"
                         value="${(Math.abs(transaction.amount) / 100).toFixed(2)}">
                </div>
                <div class="field">
                  <label for="emi-tenure">Over how many months</label>
                  <input id="emi-tenure" name="tenure_months" type="number" min="1" max="60"
                         required placeholder="12">
                </div>
              </div>
              <div class="grid-2">
                <div class="field">
                  <label for="emi-rate">Rate (% per year)</label>
                  <input id="emi-rate" name="annual_rate" type="text" inputmode="decimal"
                         required placeholder="15">
                </div>
                <div class="field">
                  <label for="emi-fee">Processing fee, before GST</label>
                  <input id="emi-fee" name="processing_fee" class="amount-input" type="text"
                         inputmode="decimal" placeholder="199">
                </div>
              </div>
              <div class="field">
                <!--
                  Three purchases converted on one card would otherwise be three
                  plans with the same name. The payee is usually the right word,
                  so it is filled in.
                -->
                <label for="emi-name">Call it</label>
                <input id="emi-name" name="name_suffix" autocomplete="off"
                       value="${payeeName ?? ""}"
                       placeholder="What it was for — Croma, the sofa, school fees">
                <p class="field-hint">
                  Added after the card's name, so the plan is findable in the loan
                  list and its envelope on the grid.
                </p>
              </div>
              <div class="field">
                <label for="emi-fee-category">Budget the fee from</label>
                <select id="emi-fee-category" name="fee_category_id">
                  <option value="">—</option>
                  ${[...view.categories.values()]
                    .filter((c) => !c.isPaymentCategory && !c.hidden)
                    .map((c) => html`<option value="${c.id}">${c.name}</option>`)}
                </select>
              </div>
              <button class="button-primary" type="submit">Convert to EMI</button>
            </form>
          </details>
        `)}

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

          ${when(!transaction.is_split, () => html`
            <div class="field">
              <label for="t-category">Category</label>
              <select id="t-category" name="category_id">
                <option value="">Uncategorised</option>
                ${envelopeOptions(transaction.category_id)}
              </select>
            </div>
            <details style="margin-bottom:.9rem">
              <summary class="linkish">Split across envelopes</summary>
              <p class="field-hint">
                Fill in two or more lines and they must add up to the amount.
                Lines left blank are ignored; the category above is too.
              </p>
              ${[0, 1, 2].map((i) => html`
                <div class="split-line">
                  <div class="field">
                    <select name="split_category_${i}" aria-label="Split ${i + 1} envelope">
                      <option value="">—</option>
                      ${envelopeOptions(null)}
                    </select>
                  </div>
                  <div class="field">
                    <input name="split_amount_${i}" class="amount-input" type="text"
                           inputmode="decimal" aria-label="Split ${i + 1} amount" placeholder="0">
                  </div>
                </div>
              `)}
            </details>
          `)}
          ${when(transaction.is_split, () => html`
            <div class="field">
              <label>Split across ${splits.length} envelopes</label>
              ${splitRows.map((row, i) => html`
                <div class="split-line">
                  <div class="field">
                    <select name="split_category_${i}" aria-label="Split ${i + 1} envelope">
                      <option value="">—</option>
                      ${envelopeOptions(row.categoryId)}
                    </select>
                  </div>
                  <div class="field">
                    <input name="split_amount_${i}" class="amount-input" type="text"
                           inputmode="decimal" aria-label="Split ${i + 1} amount"
                           value="${row.amount === null ? "" : (row.amount / 100).toFixed(2)}"
                           placeholder="0">
                  </div>
                </div>
              `)}
              <p class="field-hint">
                The lines must add up to the amount. Blank a line to drop it.
              </p>
            </div>
            <div class="field">
              <label for="t-category">Or file the whole thing to one envelope instead</label>
              <select id="t-category" name="category_id">
                <option value="" selected>— keep the split —</option>
                ${envelopeOptions(null)}
              </select>
            </div>
          `)}

          <div class="grid-2">
            <div class="field">
              <label for="t-date">Date</label>
              <input id="t-date" name="date" type="text" value="${formatDateOut(transaction.date)}">
            </div>
            <div class="field">
              <label for="t-payee">Payee</label>
              <input id="t-payee" name="payee" value="${payeeName ?? ""}"
                     placeholder="Who the money went to">
            </div>
          </div>

          <div class="grid-2">
            <div class="field">
              <label for="t-memo">Memo</label>
              <input id="t-memo" name="memo" value="${transaction.memo ?? ""}">
            </div>
            <div class="field">
              <label for="t-tags">Tags</label>
              <input id="t-tags" name="tags" value="${tags}"
                     placeholder="trip-2026, reimbursable">
            </div>
          </div>

          ${when(members.length > 1, () => html`
            <div class="field">
              <label for="t-owner">Whose spending</label>
              <select id="t-owner" name="owner_member_id">
                <option value="">The household's</option>
                ${members.map((m) => html`
                  <option value="${m.id}" ${raw(m.id === transaction.owner_member_id ? "selected" : "")}>
                    ${m.name}
                  </option>
                `)}
              </select>
            </div>
          `)}

          <div class="field">
            <label>
              <input type="checkbox" name="cleared" value="1"
                     ${raw(transaction.cleared ? "checked" : "")}> Cleared the bank
            </label>
            <label>
              <!-- The marker tells the handler the checkbox was on the form,
                   since an unchecked box sends nothing at all. -->
              <input type="hidden" name="reimbursable_present" value="1">
              <input type="checkbox" name="reimbursable" value="1"
                     ${raw(transaction.reimbursable ? "checked" : "")}> Someone owes this back
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
    const id = requireVisibleTransaction(ctx, ctx.params.id!).id;
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
    // 15 · The bytes of a receipt on somebody else's private account are the
    // plainest disclosure in the app: not a name or a figure, the document.
    const found = getAttachmentBytes(db, requireVisibleAttachment(ctx, ctx.params.id!));
    if (!found) throw new NotFound("That attachment does not exist.");
    return {
      body: Buffer.from(found.bytes),
      headers: {
        "Content-Type": found.meta.mime,
        /*
         * A photo is shown; a PDF is handed over.
         *
         * A PDF can carry script. It runs in the viewer's sandbox rather than
         * the page's, and the CSP and nosniff bound what it could reach anyway
         * — but a receipt is a document somebody keeps, not a page they read
         * here, so the safer header costs a click and nothing else. Images
         * stay inline, because looking at them *is* the feature.
         *
         * The filename is stripped of anything that could end the header value
         * or start a new one: it came from a file somebody chose.
         */
        "Content-Disposition":
          `${found.meta.mime === "application/pdf" ? "attachment" : "inline"}; `
          + `filename="${found.meta.filename.replace(/[^\w. ()\-]/g, "_")}"`,
        "Cache-Control": "no-store, private",
        "Content-Length": String(found.bytes.length),
      },
    };
  });

  router.post("/attachment/:id/delete", (ctx) =>
    mutate(ctx, (a) => {
      const transactionId = deleteAttachment(
        db, actorFor(a), requireVisibleAttachment(ctx, ctx.params.id!),
      );
      return {
        redirect: transactionId ? `/transaction/${transactionId}` : "/",
        message: "Receipt removed.",
      };
    }),
  );

  router.post("/transaction/:id", (ctx) => {
    const a = auth(ctx);
    const id = ctx.params.id!;
    const transaction = requireVisibleTransaction(ctx, id);

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
    const signed = field(ctx.body, "direction") === "in" ? magnitude : -magnitude;

    // L1 · A renamed payee is the signal. Resolved here so the rename and the
    // rest of the edit land in one update, and so the *old* name is still
    // readable when we decide whether anything actually changed.
    const newPayee = (field(ctx.body, "payee") ?? "").trim();
    const previousPayee = transaction.payee_id ? getPayee(db, transaction.payee_id)?.name ?? null : null;
    const renamed = newPayee !== "" && newPayee !== previousPayee;
    const payeeId = renamed
      ? resolvePayee(db, actor, newPayee, transaction.raw_narration).id
      : undefined;

    /*
     * F4.3 · Split lines from the form. Each filled line is an envelope and an
     * unsigned amount; the sign follows the transaction's direction. The form
     * that edits a record must carry all of it — this form once knew nothing
     * of splits, so saving any split transaction silently flattened it.
     */
    const splitLines: { categoryId: string | null; amount: Paise }[] = [];
    for (let i = 0; i < 25; i++) {
      const cat = field(ctx.body, `split_category_${i}`);
      const amt = field(ctx.body, `split_amount_${i}`);
      if (cat === undefined && amt === undefined) continue;
      if (!cat && !amt?.trim()) continue;
      if (!cat || !amt?.trim()) {
        throw new HttpError(400, "A split line needs both an envelope and an amount.");
      }
      const line = Math.abs(amountField(amt));
      if (line === 0) continue;
      splitLines.push({
        categoryId: requireVisibleCategory(ctx, cat),
        amount: (signed < 0 ? -line : line) as Paise,
      });
    }
    if (splitLines.length === 1) {
      throw new HttpError(400, "One line isn't a split — pick that envelope in the category field instead.");
    }
    if (splitLines.length > 0) {
      const total = splitLines.reduce((sum, s) => sum + s.amount, 0);
      if (total !== signed) {
        throw new HttpError(
          400,
          `The split lines add up to ${formatPaise(Math.abs(total))}, ` +
            `but the transaction is ${formatPaise(magnitude)}.`,
        );
      }
    }

    const postedCategory = field(ctx.body, "category_id");
    const collapse = transaction.is_split === 1 && splitLines.length === 0 && !!postedCategory;
    const keepSplit = transaction.is_split === 1 && splitLines.length === 0 && !postedCategory;
    if (keepSplit && signed !== transaction.amount) {
      throw new HttpError(
        400,
        "This transaction is split, and the lines no longer add up to the new amount. " +
          "Change the split lines to match, or file it to one envelope.",
      );
    }

    const tagsRaw = field(ctx.body, "tags");
    const ownerRaw = field(ctx.body, "owner_member_id");

    // Guard the earlier of the two dates: moving a transaction backwards means
    // the ripple starts where it lands, not where it was.
    const rippleFrom = monthOf(newDate < transaction.date ? newDate : transaction.date);
    const { recompute } = withForwardRecompute(
        db, actor, { month: rippleFrom, cause: "Edited a transaction" },
        () =>
          updateTransaction(db, actor, id, {
          amount: signed,
          date: newDate,
          ...(splitLines.length > 0
            ? { splits: splitLines }
            : keepSplit
              ? {}
              : collapse
                ? { splits: null, categoryId: requireVisibleCategory(ctx, postedCategory || null) || null }
                : { categoryId: requireVisibleCategory(ctx, postedCategory || null) || null }),
          memo: field(ctx.body, "memo") || null,
          cleared: field(ctx.body, "cleared") === "1",
          ...(tagsRaw !== undefined
            ? { tags: tagsRaw.split(",").map((t) => t.trim()).filter(Boolean) }
            : {}),
          ...(ownerRaw !== undefined ? { ownerMemberId: ownerRaw || null } : {}),
          ...(field(ctx.body, "reimbursable_present") === "1"
            ? { reimbursable: field(ctx.body, "reimbursable") === "1" }
            : {}),
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

  /*
   * B85 · Put one transaction in an envelope, from wherever it is listed.
   *
   * The Review screen offers a staged import an inline category dropdown and
   * an Approve button. A transaction already in the ledger with no category —
   * the same decision, on the same screen — offered a link to a detail page and
   * a full edit form that insists on an amount. The cheap half of the queue was
   * the expensive one to clear.
   */
  router.post("/transaction/:id/categorise", (ctx) =>
    mutate(ctx, (a) => {
      const id = ctx.params.id!;
      const transaction = requireVisibleTransaction(ctx, id);

      const categoryId = requireVisibleCategory(ctx, field(ctx.body, "category_id") || null) || null;
      if (categoryId && !getCategory(db, categoryId)) {
        throw new HttpError(400, "That category does not exist.");
      }
      updateTransaction(db, actorFor(a, "ui", ctx.req.headers["idempotency-key"] as string), id, {
        categoryId,
      });

      /*
       * B100 · Filing a transaction is the signal, wherever it happened.
       *
       * L2 says categorising the same payee a second time proposes a rule, and
       * `proposeCategoryRules` reads the ledger — but it was only ever called
       * from the import-approval route. Three years of real use produced 131
       * transactions from one merchant and not a single proposed rule, because
       * none of that filing went through an import.
       *
       * The proposal still only proposes: it goes to Review and is never
       * applied on its own (L3), so this is safe to run on every filing.
       */
      const proposals =
        categoryId && learningEnabled(db) ? proposeCategoryRules(db, actorFor(a)) : [];

      const name = categoryId ? getCategory(db, categoryId)?.name ?? "a category" : null;
      return {
        redirect: safePath(field(ctx.body, "return_to"), "/review"),
        message:
          (name ? `Filed under ${name}.` : "Category cleared.") +
          (proposals.length > 0
            ? ` Noticed a pattern — there ${proposals.length === 1 ? "is a rule" : "are rules"} to confirm in Review.`
            : ""),
      };
    }),
  );

  /*
   * B84 · The money came back. Clearing the flag is the whole lifecycle — the
   * repayment itself is an ordinary transaction the household records like any
   * other, and pretending otherwise would invent a second ledger.
   */
  router.post("/transaction/:id/settled", (ctx) =>
    mutate(ctx, (a) => {
      const id = requireVisibleTransaction(ctx, ctx.params.id!).id;
      updateTransaction(db, actorFor(a, "ui", ctx.req.headers["idempotency-key"] as string), id, {
        reimbursable: false,
      });
      return { redirect: "/review", message: "Marked settled." };
    }),
  );

  router.post("/transaction/:id/delete", (ctx) => {
    const a = auth(ctx);
    const id = ctx.params.id!;
    const transaction = requireVisibleTransaction(ctx, id);

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
    auth(ctx);
    const account = requireVisibleAccount(ctx, ctx.params.id!);
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
    const asOf = dateField(asOfRaw, "As of");
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
    const account = requireVisibleAccount(ctx, ctx.params.id!);
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
  /*
   * F2.3 / R6 · The cards, in the order they fall due.
   *
   * Seven cards on seven billing cycles, and the question asked most often —
   * which do I pay next, how much, is it already set aside — had no screen.
   * Every figure here already existed; none of them were ever put in due-date
   * order on one page.
   */
  router.get("/cards", (ctx) => {
    auth(ctx);
    const month = monthParam(ctx);
    /*
     * 15 §3A.5 · A card's debt, and the envelope funding it, belong to the budget
     * that owns the account. So this screen shows the cards of the budget being
     * looked at — the household's when that is what is selected, yours when it
     * is yours. Mixing them would put another budget's bill on your list.
     */
    const scope = budgetParam(ctx);
    const view = buildBudgetView(db, month, scope, viewer(ctx));
    const outstanding = creditOutstanding(db);
    const today = todayIST();

    const cards: CardDue[] = listAccounts(db, { viewerMemberId: viewer(ctx) })
      .filter((a) => a.kind === "credit" && a.budget_id === scope)
      .map((account) => {
        const payment = [...view.categories.values()]
          .find((c) => c.paymentAccountId === account.id) ?? null;
        const funded = payment?.state.balance ?? 0;
        const funding = cardFunding(
          account.id,
          outstanding.get(account.id) ?? 0,
          funded,
          view.monthState.unfundedByAccount[account.id] ?? 0,
          account.opening_balance,
        );
        const statement = lastCardStatement(db, account.id);

        return {
          accountId: account.id,
          name: account.nickname || account.name,
          last4: account.last4,
          startingDebtNote: cameWithTheCard(funding),
          owed: Math.max(0, -(outstanding.get(account.id) ?? 0)) as Paise,
          funded,
          unfunded: funding.unfunded,
          statement: statement
            ? {
                amount: statement.amount, date: statement.statement_date,
                due: statement.due_date, minimum: statement.minimum_due,
              }
            : null,
          daysToDue: statement ? daysBetween(today, statement.due_date) : null,
          paidSinceStatement: statement
            ? creditedSinceStatement(db, account.id, statement.statement_date)
            : (0 as Paise),
          paymentCategoryId: payment?.id ?? null,
        };
      })
      /*
       * Soonest first. A card with no statement has no due date to sort by, so
       * it goes last rather than being guessed at — R6 reports the debt it can
       * see and never invents a cycle.
       */
      .sort((a, b) => {
        if (a.daysToDue === null && b.daysToDue === null) return b.owed - a.owed;
        if (a.daysToDue === null) return 1;
        if (b.daysToDue === null) return -1;
        return a.daysToDue - b.daysToDue;
      });

    return render(ctx, "Cards", renderCards({ cards, month }));
  });

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
        statementDate: dateField(field(ctx.body, "statement_date"), "Statement date"),
        dueDate: dateField(requiredField(ctx.body, "due_date"), "Due date"),
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
    const visibleCategoryIds = new Set(
      listCategories(db, { includeHidden: true, viewerMemberId: viewer(ctx) }).map((c) => c.id),
    );
    // 15 · The envelopes this member may see: the household's and their own.
    const visible = visibleBudgetIds(db, viewer(ctx));
    const month = monthParam(ctx);
    const view = buildBudgetView(db, month, undefined, viewer(ctx));
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
          /*
           * B93 · The category this payee's money usually goes to, worked out
           * from the ledger, so the common case is one tap rather than a
           * nineteen-option dropdown. `usual` is null for a payee never seen
           * with a category, which is the case that still needs the full list.
           */
          `SELECT t.id, t.date, t.amount, p.name AS payee, a.name AS account,
                  (SELECT prev.category_id
                     FROM transactions prev
                    WHERE prev.payee_id = t.payee_id AND prev.category_id IS NOT NULL
                      AND prev.deleted_at IS NULL
                    GROUP BY prev.category_id
                    ORDER BY COUNT(*) DESC, MAX(prev.date) DESC
                    LIMIT 1) AS usual_category_id
             FROM transactions t
             JOIN accounts a ON a.id = t.account_id
             LEFT JOIN payees p ON p.id = t.payee_id
            WHERE t.deleted_at IS NULL AND t.is_split = 0 AND t.category_id IS NULL
              AND t.transfer_pair_id IS NULL AND a.kind != 'tracking'
              AND t.amount < 0
            ORDER BY t.date DESC LIMIT ?`,
          UNCATEGORISED_PAGE,
        ),
        uncategorisedTotal: queryOne<{ n: number }>(
          db,
          `SELECT COUNT(*) AS n FROM transactions t
             JOIN accounts a ON a.id = t.account_id
            WHERE t.deleted_at IS NULL AND t.is_split = 0 AND t.category_id IS NULL
              AND t.transfer_pair_id IS NULL AND a.kind != 'tracking'
              AND t.amount < 0`,
        )?.n ?? 0,
        claims: outstandingReimbursements(db),
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
        /*
         * 15 · And not a proposal about somebody else's envelope.
         *
         * Rules are learned from what the household actually filed, and the
         * proposal states its evidence — "You've put Blinkist in Books and
         * courses 36 times". Shown to everybody, that discloses the private
         * envelope's name, what goes in it, and how often, which is more than
         * the envelope itself would have given away. A proposal is only offered
         * to somebody who could have made the rule by hand.
         */
        proposedRules: queryAll<{
          id: string; name: string; because: string | null; actions_json: string;
          strength: number | null;
        }>(
          db,
          `SELECT id, name, because, strength, actions_json FROM rules
            WHERE proposed = 1 AND dismissed_at IS NULL
            ORDER BY strength IS NULL, strength DESC, created_at DESC`,
        ).filter((rule) => {
          const targets = (JSON.parse(rule.actions_json) as { categoryId?: string }[])
            .map((a) => a.categoryId)
            .filter((id): id is string => Boolean(id));
          return targets.every((id) => visibleCategoryIds.has(id));
        }),
        /*
         * 15 · Only envelopes this member may see. The review queue offers a
         * category for every unfiled row, and an unscoped budget view carries
         * every budget's — so it was offering one member's private envelopes to
         * the rest of the household, by name, on the busiest screen in the app.
         */
        categories: [...view.categories.values()].filter(
          (c) => c.budgetId === null || visible.has(c.budgetId),
        ),
        bufferReading: view.buffer.reading,
        month,
      }),
    );
  });

  router.post("/review/approve", (ctx) =>
    mutate(ctx, (a) => {
      /*
       * B99 · Approving is what puts a row in the ledger, so it is the same
       * rule as manual entry: an expense names its envelope, income does not
       * have to. Refusing here rather than at import is deliberate — the queue
       * is exactly where an unfiled row is supposed to wait.
       */
      approveStaged(db, actorFor(a, "ui", ctx.req.headers["idempotency-key"] as string),
        requiredField(ctx.body, "staged_id"),
        { categoryId: requireVisibleCategory(ctx, field(ctx.body, "category_id") || null) || null },
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
      accounts: listAccounts(db, { viewerMemberId: viewer(ctx) }),
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
        accounts: listAccounts(db, { viewerMemberId: viewer(ctx) }),
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
    /*
     * Which detail the bank's rule needs and this household has not saved.
     * Four institutions account for every statement a real corpus could not
     * open, and in every case the fix is one field — worth naming rather than
     * leaving somebody to conclude the file is simply unreadable.
     */
    let missing: string | null = null;
    try {
      if (typed !== "") {
        parsed = parseStatementPdf(upload.bytes, typed);
      } else if (identity) {
        // F2.9 · The destination account already stores the card/account's
        // last four digits (for SMS matching), which is exactly what Canara's
        // and SBI Card's passwords need. Hand them to the derivation.
        const account = getAccount(db, accountId);
        // The account knows its bank, so the bank's own rule is tried first.
        // detectBank cannot help here: the file is still locked.
        const bank = bankForInstitution(account?.institution);
        const result = openStatement(
          upload.bytes,
          passwordCandidates(identity, bank, { cardDigits: [account?.last4] }),
        );
        if (!result) {
          missing = missingDetailFor(bank, identity, [account?.last4]);
          throw new StatementWrongPassword();
        }
        parsed = result.parse;
        opened = ` It opened with ${describeCandidate(result.candidate, identity)}.`;
      } else {
        parsed = parseStatementPdf(upload.bytes, "");
      }
    } catch (error) {
      return importPage(
        error instanceof StatementWrongPassword
          ? (identity
              ? (missing
                  ? `${missing} Or type the password below.`
                  : "None of the passwords worked out from your saved details opened this. " +
                    "Type it below, or check the details in Settings.")
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

  /*
   * H2.2 · A private loan is its holder's alone — and a list filter is not a
   * privacy control.
   *
   * `listLoans` hid it from the index and `hiddenAccountIds` kept it out of
   * everyone else's net worth, and then every per-loan route read it straight
   * out of the table by id: the detail page, the schedule CSV, the statement,
   * and every POST that changes it. A member who had ever seen the loan, or who
   * simply tried the next id, could read the balance, record an instalment
   * against it, change whose it was, or close it.
   *
   * It answers NotFound rather than a refusal, because "you may not see this"
   * confirms there is something to see — which is the one thing a private loan
   * must not do.
   */
  function requireLoanVisible(ctx: RequestContext): string {
    const id = ctx.params.id!;
    if (!canSeeLoan(db, id, viewer(ctx))) throw new NotFound("That loan does not exist.");
    return id;
  }

  function requireFamilyLoanVisible(ctx: RequestContext): string {
    const id = ctx.params.id!;
    if (!canSeeFamilyLoan(db, id, viewer(ctx))) {
      throw new NotFound("That arrangement does not exist.");
    }
    return id;
  }

  router.get("/loans", (ctx) => {
    requireLoans();
    // H2.2 · A private loan is its holder's alone, the same as a private account.
    const projections = listLoans(db, { viewerMemberId: viewer(ctx) })
      .map((l) => projectLoan(db, l.id))
      .filter((p): p is NonNullable<typeof p> => p !== null);

    const memberNames = new Map(listMembers(db).map((m) => [m.id, m.name]));
    const showOwners = memberNames.size > 1;
    const ownership = new Map(
      projections.map((p) => {
        const account = getAccount(db, p.loan.account_id);
        return [p.loan.id, {
          holderName: account?.holder_member_id
            ? memberNames.get(account.holder_member_id) ?? null
            : null,
          isPrivate: account?.visibility === "private",
        }];
      }),
    );

    return render(
      ctx, "Loans",
      renderLoanList(projections, debtOverview(db, viewer(ctx)), showOwners ? ownership : new Map()),
    );
  });

  router.get("/loans/new", (ctx) => {
    requireLoans();
    return render(
      ctx, "Add a loan",
      renderNewLoanForm({
        members: listMembers(db).map((m) => ({ id: m.id, name: m.name })),
        accounts: listAccounts(db, { viewerMemberId: viewer(ctx) })
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
        holderMemberId: field(ctx.body, "holder_member_id") || null,
        visibility: field(ctx.body, "visibility") === "private" ? "private" : "household",
        // R15 · Where the drawn money landed, if the household said.
        disbursementDestination:
          field(ctx.body, "disbursement_destination") === "budget-account" ? "budget-account"
            : field(ctx.body, "disbursement_destination") === "third-party" ? "third-party"
              : undefined,
        disbursementAccountId: field(ctx.body, "disbursement_account_id") || null,
        loanType: requiredField(ctx.body, "loan_type") as LoanType,
        sanctioned: amountField(field(ctx.body, "sanctioned"), "Sanctioned amount"),
        sanctionDate: dateField(field(ctx.body, "sanction_date"), "Sanction date"),
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
    requireLoanVisible(ctx);
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
        budgetAccounts: listAccounts(db, { viewerMemberId: viewer(ctx) })
          .filter((acc) => acc.kind === "budget" && !acc.closed_at)
          .map((acc) => ({ id: acc.id, name: acc.name })),
        // H2 / H2.2 · Read off the tracking account the loan hangs on.
        members: listMembers(db).map((m) => ({ id: m.id, name: m.name })),
        holderMemberId: getAccount(db, projection.loan.account_id)?.holder_member_id ?? null,
        isPrivate: getAccount(db, projection.loan.account_id)?.visibility === "private",
        categories: listCategories(db, { viewerMemberId: viewer(ctx) })
          .map((c) => ({ id: c.id, name: c.name })),
      }),
    );
  });

  /** R15 · Record a tranche. */
  /*
   * H2 / H2.2 · Whose loan it is, changeable after the fact.
   *
   * It could be set when the loan was created and nowhere afterwards, so a loan
   * entered before a household started keeping money separately was stuck as
   * everybody's. The account it hangs on is where both live, so this is an
   * ordinary account edit wearing the loan's clothes.
   */
  /*
   * R21 · Closing a paid-off loan.
   *
   * closeLoan had been written and reachable from nowhere, parked on the
   * reasoning that "a loan closes by being repaid". It does — and then it sat in
   * the list at zero for ever, because nothing noticed. Repaying it is what makes
   * it closeable; this is what files it away.
   */
  /*
   * 06 §7.4 / R19.5 · Settling early, and what the lender charged for it.
   *
   * The charge is a real cost of the borrowing and has to be recordable, or the
   * prepayment decision is taken against a saving bigger than the one actually
   * on offer.
   */
  router.post("/loans/:id/settle", (ctx) =>
    mutate(ctx, (a) => {
      requireLoanVisible(ctx);
      const loan = getLoan(db, ctx.params.id!);
      if (!loan) throw new NotFound("That loan does not exist.");
      const settlementRaw = field(ctx.body, "settlement");
      const chargeRaw = field(ctx.body, "charge");

      closeLoan(db, actorFor(a, "ui", ctx.req.headers["idempotency-key"] as string), {
        loanId: loan.id,
        date: todayIST(),
        settlement: settlementRaw?.trim()
          ? (amountField(settlementRaw, "Settlement") as Paise)
          : undefined,
        foreclosureCharge: chargeRaw?.trim()
          ? (amountField(chargeRaw, "Foreclosure charge") as Paise)
          : undefined,
        chargeAccountId: field(ctx.body, "charge_account_id") || null,
        chargeCategoryId: requireVisibleCategory(ctx, field(ctx.body, "charge_category_id") || null) || null,
      });
      return {
        redirect: "/loans",
        message: `${loan.nickname || loan.lender} is settled and closed.`,
      };
    }),
  );

  router.post("/loans/:id/close", (ctx) =>
    mutate(ctx, (a) => {
      requireLoanVisible(ctx);
      const loan = getLoan(db, ctx.params.id!);
      if (!loan) throw new NotFound("That loan does not exist.");
      closeLoan(db, actorFor(a, "ui", ctx.req.headers["idempotency-key"] as string), {
        loanId: loan.id,
        date: todayIST(),
      });
      return { redirect: "/loans", message: `${loan.nickname || loan.lender} is closed.` };
    }),
  );

  router.post("/loans/:id/holder", (ctx) =>
    mutate(ctx, (a) => {
      requireLoanVisible(ctx);
      const loan = getLoan(db, ctx.params.id!);
      if (!loan) throw new NotFound("That loan does not exist.");
      updateAccount(db, actorFor(a, "ui", ctx.req.headers["idempotency-key"] as string),
        loan.account_id, {
          holder_member_id: field(ctx.body, "holder_member_id") || null,
          visibility: field(ctx.body, "visibility") === "private" ? "private" : "household",
        });
      return { redirect: `/loans/${loan.id}`, message: "Saved." };
    }),
  );

  router.post("/loans/:id/disburse", (ctx) =>
    mutate(ctx, (a) => {
      requireLoanVisible(ctx);
      const loanId = ctx.params.id!;
      const dateRaw = field(ctx.body, "date");
      const destination = field(ctx.body, "destination") === "budget-account"
        ? "budget-account" : "third-party";
      recordDisbursement(db, actorFor(a, "ui", ctx.req.headers["idempotency-key"] as string), {
        loanId,
        amount: Math.abs(amountField(requiredField(ctx.body, "amount"))),
        date: dateField(dateRaw),
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
    requireLoanVisible(ctx);
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
    requireLoanVisible(ctx);
    const projection = projectLoan(db, ctx.params.id!);
    if (!projection) throw new NotFound("That loan does not exist.");
    return render(
      ctx, "Record an instalment",
      renderRecordInstalment({
        projection,
        /*
         * 06 §7.4 · A card EMI is charged to the card, so the card has to be on
         * offer. Every other loan is paid from a bank account, and offering cards
         * there would invite recording a payment that never happened.
         */
        accounts: listAccounts(db, { viewerMemberId: viewer(ctx) })
          .filter((a) =>
            a.kind === "budget"
            || (projection.loan.loan_type === "credit-card-emi" && a.kind === "credit"))
          .map((a) => ({
            id: a.id,
            name: a.nickname || a.name,
            isCard: a.kind === "credit",
          })),
        today: todayIST(),
      }),
    );
  });

  router.post("/loans/:id/pay", (ctx) =>
    mutate(ctx, (a) => {
      requireLoans();
      requireLoanVisible(ctx);
      const loanId = ctx.params.id!;
      const principalRaw = field(ctx.body, "principal");
      const interestRaw = field(ctx.body, "interest");

      recordInstalment(db, actorFor(a, "ui", ctx.req.headers["idempotency-key"] as string), {
        loanId,
        date: dateField(field(ctx.body, "date")),
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
    requireLoanVisible(ctx);
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
      requireLoanVisible(ctx);
      const loanId = ctx.params.id!;
      const ytdRaw = field(ctx.body, "interest_paid_ytd");
      const remainingRaw = field(ctx.body, "instalments_remaining");
      recordLoanStatement(db, actorFor(a, "ui", ctx.req.headers["idempotency-key"] as string), {
        loanId,
        asOf: dateField(field(ctx.body, "as_of"), "As of"),
        lenderOutstanding: amountField(requiredField(ctx.body, "lender_outstanding")),
        interestPaidYtd: ytdRaw?.trim() ? amountField(ytdRaw) : null,
        instalmentsRemaining: remainingRaw?.trim() ? Number(remainingRaw) : null,
      });
      return { redirect: `/loans/${loanId}`, message: "Statement recorded." };
    }),
  );

  /*
   * B71 · R20 · A rate change, and what it does to the schedule.
   *
   * `recordRateChange`, `rateResetOptions` and `renderRateReset` all existed;
   * nothing connected them, so the single most common event in an Indian
   * floating-rate loan — a repo-linked reset, several times a year — could not
   * be entered at all. The GET previews both options the lender must offer; the
   * POST commits the change.
   */
  router.get("/loans/:id/rate", (ctx) => {
    requireLoans();
    requireLoanVisible(ctx);
    const projection = projectLoan(db, ctx.params.id!);
    if (!projection) throw new NotFound("That loan does not exist.");

    /*
     * B114 · The preview button is the same form as the record button, so the
     * query names it submits are the form's own. The older short names still
     * work, because links elsewhere use them.
     */
    const typedRate = ctx.query.get("annual_rate_pct") ?? ctx.query.get("rate");
    const newRatePct = Number(typedRate ?? projection.ratePct);
    const effectiveFrom =
      parseDate(ctx.query.get("effective_from") ?? ctx.query.get("from") ?? "") ?? todayIST();
    const keep = ctx.query.get("keep") === "emi" ? "emi" : "tenure";

    if (!Number.isFinite(newRatePct) || newRatePct < 0) {
      throw new HttpError(400, "That is not a rate.");
    }

    if (projection.outstanding <= 0) {
      return render(
        ctx, "Rate change",
        html`
          <h1>Rate change</h1>
          <div class="card empty-state">
            <p>Nothing is outstanding on this loan, so a rate change has nothing to act on.</p>
            <p><a class="button" href="/loans/${projection.loan.id}">Back to the loan</a></p>
          </div>
        `,
      );
    }

    try {
      return render(
        ctx, "Rate change",
        renderRateReset({
          loan: projection.loan,
          effectiveFrom,
          keep,
          options: rateResetOptions({
            outstanding: projection.outstanding,
            currentEmi: projection.emi,
            remainingMonths: Math.max(1, projection.schedule.months),
            oldRatePct: projection.ratePct,
            newRatePct,
          }),
        }),
      );
    } catch (err) {
      // R17.4 · An instalment below the new monthly interest never amortises.
      // That is a real answer about the loan, not a fault.
      if (err instanceof NegativeAmortisation) throw new HttpError(422, err.message);
      throw err;
    }
  });

  router.post("/loans/:id/rate", (ctx) =>
    mutate(ctx, (a) => {
      requireLoans();
      requireLoanVisible(ctx);
      const loanId = ctx.params.id!;
      if (!projectLoan(db, loanId)) throw new NotFound("That loan does not exist.");
      const from = parseDate(requiredField(ctx.body, "effective_from"));
      if (!from) throw new HttpError(400, "That is not a date I can read.");
      const rate = Number(requiredField(ctx.body, "annual_rate_pct"));
      if (!Number.isFinite(rate) || rate < 0) throw new HttpError(400, "That is not a rate.");

      const keep = field(ctx.body, "keep") === "emi" ? "emi" : "tenure";

      try {
        recordRateChange(db, actorFor(a, "ui", ctx.req.headers["idempotency-key"] as string), {
          loanId, effectiveFrom: from, annualRatePct: rate, keep,
          note: field(ctx.body, "note") || null,
        });
      } catch (err) {
        // R17.4 · Keeping an instalment that cannot cover the new month's
        // interest is not a fault; it is the answer, and it means the other
        // option is the only one open.
        if (err instanceof NegativeAmortisation) throw new HttpError(422, err.message);
        throw err;
      }

      return {
        redirect: `/loans/${loanId}`,
        message:
          keep === "emi"
            ? `Rate changed to ${rate}%, keeping the instalment — the tenure moved instead.`
            : `Rate changed to ${rate}%, keeping the tenure — the instalment moved instead.`,
      };
    }),
  );

  router.get("/loans/:id/prepay", (ctx) => {
    requireLoans();
    requireLoanVisible(ctx);
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
    const view = buildBudgetView(db, undefined, undefined, viewer(ctx));

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
    requireLoanVisible(ctx);
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

    /*
     * B115 · The mode and the funding envelope were both collected here and
     * neither was carried out: the mode went into the note, and the envelope
     * went nowhere. `recordPrepayment` applies both — which is also where R19.1
     * belongs, rather than in the route that renders the form.
     */
    recordPrepayment(db, actor, {
      loanId,
      date: todayIST(),
      amount,
      mode,
      charge,
      fromAccountId: projection.loan.repayment_account_id,
      fundingCategoryId: requireVisibleCategory(ctx, field(ctx.body, "funding_category_id") || null) || null,
    });

    const after = projectLoan(db, loanId);
    return {
      redirect: withNotice(
        `/loans/${loanId}`,
        mode === "emi"
          ? `Prepaid ${formatPaise(amount)}. The instalment is now ` +
            `${formatPaise(after?.emi ?? 0)} and the closure date is unchanged.`
          : `Prepaid ${formatPaise(amount)}. The instalment is unchanged and there are ` +
            `${after?.schedule.months ?? 0} left.`,
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

    /*
     * 15 · Scope is asked for here rather than taken from the switcher.
     *
     * `16`'s decision is that reports offer every scope rather than picking one:
     * "what did we spend on groceries" and "what did I spend" and "what did all
     * of it come to" are three different questions, and a report that silently
     * answered only one of them would be wrong two times in three. So `scope`
     * defaults to everything and is a control on the page.
     */
    const scope = ctx.query.get("scope");
    const budgetId =
      scope && scope !== "all" && budgetsFor(db, viewer(ctx)).some((b) => b.id === scope)
        ? scope
        : undefined;

    return {
      period,
      filter: {
        from: period.from,
        to: period.to,
        text: ctx.query.get("q") ?? undefined,
        accountIds: account ? [account] : undefined,
        categoryIds: category ? [category] : undefined,
        budgetId,
        // H2.2 · Query, Search and the CSV all come through here, so this is the
        // one place the viewer has to be named for all three of them.
        viewerMemberId: viewer(ctx),
        limit: 1000,
      },
    };
  }

  function queryPage(ctx: RequestContext, title?: string) {
    const { filter, period } = filterFromQuery(ctx);
    const groupBy = (ctx.query.get("group_by") ?? "category") as GroupBy;
    /*
     * B96 · Load everything the filter matches, render a page of it, and do all
     * the arithmetic over the whole set. The cap was always about how much HTML
     * to produce; it had quietly become the basis of the totals as well.
     */
    const all = queryTransactions(db, { ...filter, limit: Number.MAX_SAFE_INTEGER });

    return render(
      ctx,
      title ?? "Query",
      renderQuery({
        rows: all,
        matched: all.length,
        csvQuery: ctx.url.search,
        totals: {
          net: all.reduce((sum, r) => sum + r.amount, 0) as Paise,
          outflow: all.filter((r) => r.amount < 0).reduce((sum, r) => sum + r.amount, 0) as Paise,
          inflow: all.filter((r) => r.amount > 0).reduce((sum, r) => sum + r.amount, 0) as Paise,
        },
        groups: groupTotals(all, groupBy),
        groupBy,
        period,
        periods: periodPresets(),
        text: ctx.query.get("q") ?? "",
        accounts: listAccounts(db, { viewerMemberId: viewer(ctx) }).map((a) => ({ id: a.id, name: a.nickname || a.name })),
        categories: listCategories(db, { viewerMemberId: viewer(ctx) })
          .map((c) => ({ id: c.id, name: c.name })),
        selectedAccounts: filter.accountIds ?? [],
        selectedCategories: filter.categoryIds ?? [],
        budgets: budgetsFor(db, viewer(ctx)).map((b) => ({ id: b.id, name: b.name, kind: b.kind })),
        scope: ctx.query.get("scope") ?? "all",
        title,
      }),
    );
  }

  // S16 · Overview — the read-only home that gathers the five most-checked
  // numbers from the budget, cashflow, net worth and insight engine.
  router.get("/overview", (ctx) => {
    /*
     * 15 · The overview is a dashboard of one budget's position, and with the
     * switcher in the chrome it has to be the budget being looked at. Showing the
     * household's Ready to Assign while the sidebar says "Ravi" is worse than not
     * offering the switch at all.
     */
    const scope = budgetParam(ctx);
    const view = buildBudgetView(db, undefined, scope, viewer(ctx));
    const month = view.month;
    const cashflow = projectCashflow(db, { days: 60, viewerMemberId: viewer(ctx) });
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
    /*
     * B78 · Both figures below are envelope spend, not cash through budget
     * accounts. The tile read "Spent this month ₹1,060" on a month the
     * household spent ₹22,010, because 95% of it was on cards — and the runway
     * denominator had the same blind spot, which is the more dangerous of the
     * two: it reported months of safety the household did not have.
     */
    const monthSpend =
      (envelopeSpendByMonth(db, `${month}-01`, todayIST(), scope, viewer(ctx))
        .at(-1)?.spent ?? 0) as Paise;

    // #12 · Months of runway = liquid cash ÷ typical monthly spend (mean of the
    // three complete months before this one, so a partial month doesn't skew it).
    const bals = accountBalances(db);
    const cash = listAccounts(db, { viewerMemberId: viewer(ctx) })
      .filter((acc) => acc.kind === "budget" && acc.budget_id === scope)
      .reduce((sum, acc) => sum + Math.max(0, bals.get(acc.id)?.working ?? 0), 0);
    const priorMonths = envelopeSpendByMonth(
      db, `${addMonths(month, -3)}-01`, lastDayOfMonth(addMonths(month, -1)), scope, viewer(ctx),
    );
    const avgMonthlySpend = priorMonths.length
      ? priorMonths.reduce((s, m) => s + m.spent, 0) / priorMonths.length
      : 0;
    const runwayMonths = avgMonthlySpend > 0 ? cash / avgMonthlySpend : null;

    // #13 · Bills due in the next fortnight, each with a one-tap "mark paid".
    const soon = addDays(todayIST(), 14);
    // 15 §3A.4 · Either end, the same as the schedules screen: a household bill
    // paid from somebody's own account is still a household bill.
    const budgetAccounts = new Set(
      listAccounts(db, { viewerMemberId: viewer(ctx) })
        .filter((acc) => acc.budget_id === scope)
        .map((acc) => acc.id),
    );
    const budgetCategories = new Set(
      listCategories(db, { includeHidden: true, budgetId: scope, viewerMemberId: viewer(ctx) })
        .map((c) => c.id),
    );
    const dueSoon = listSchedules(db)
      .filter((s) => s.next_due && s.next_due <= soon && (s.amount ?? 0) < 0)
      .filter((s) =>
        (!s.account_id && !s.category_id)
        || (s.account_id !== null && budgetAccounts.has(s.account_id))
        || (s.category_id !== null && budgetCategories.has(s.category_id)))
      .sort((x, y) => (x.next_due ?? "").localeCompare(y.next_due ?? ""))
      .slice(0, 6)
      .map((s) => ({ id: s.id, name: s.name, amount: Math.abs(s.amount ?? 0) as Paise, nextDue: s.next_due! }));

    return render(
      ctx, "Overview",
      renderOverview({
        month,
        rta: view.monthState.readyToAssign,
        rtaState: view.monthState.rtaState,
        /*
         * H2.2 · With the viewer, the same as the net-worth page itself. Without
         * it this headline was the whole household's — so somebody saw ₹55.6L
         * here and ₹28.6L on the page behind it, and the difference was the
         * private money they could not see, published by subtraction.
         */
        netWorth: config.features.assets
          ? netWorthStatement(db, undefined, "INR", { viewerMemberId: viewer(ctx) }).netWorth
          : (0 as Paise),
        netWorthHistory: config.features.assets ? netWorthHistory(db) : [],
        cashflow,
        cashflowReading: describeCashflow(cashflow),
        unfundedCards,
        insights: spendingInsights(db, todayIST(), 4, viewer(ctx)),
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
      // B96 · No cap here. A CSV is carried off and totalled elsewhere, so a
      // silently partial one is worse than a slow one.
      body: rowsToCsv(queryTransactions(db, { ...filter, limit: Number.MAX_SAFE_INTEGER })),
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="query-${todayIST()}.csv"`,
      },
    };
  });

  router.get("/reports", (ctx) => {
    const period = periodFor(ctx.query.get("period") ?? "last-12");
    /*
     * 15 / 16 · Reports offer every scope rather than picking one, the same as
     * Query — and for the same reason: a household asks about its own money,
     * about one person's, and about all of it, on different days.
     */
    const asked = ctx.query.get("scope");
    const scope =
      asked && asked !== "all" && budgetsFor(db, viewer(ctx)).some((b) => b.id === asked)
        ? asked
        : undefined;

    const categorySpend = groupTotals(
      queryTransactions(db, {
        from: period.from, to: period.to, direction: "out", budgetId: scope,
        viewerMemberId: viewer(ctx),
      }),
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
    const bview = buildBudgetView(db, undefined, scope, viewer(ctx));
    const monthIncome =
      (incomeVsExpense(db, `${bview.month}-01`, todayIST(), scope, viewer(ctx)).at(-1)?.income ?? 0) as Paise;
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
        insights: spendingInsights(db, todayIST(), 6, viewer(ctx)),
        gains: config.features.assets ? capitalGainsByYear(db) : [],
        trend: incomeVsExpense(db, period.from, period.to, scope, viewer(ctx)),
        categorySpend: categorySpend.map((g) => ({ label: g.label, value: g.value })),
        categoryTrends,
        tagSpend: spendByTag(db, period.from, period.to, viewer(ctx)),
        spendingCalendar: spendingCalendar(db, addDays(todayIST(), -119), todayIST(), viewer(ctx)),
        sankey: { income: monthIncome, month: bview.month, groups: sankeyGroups },
        period,
        periods: periodPresets(),
        loanInterest: config.features.loans ? loanInterestByFinancialYear(db) : [],
        budgets: budgetsFor(db, viewer(ctx)).map((b) => ({ id: b.id, name: b.name, kind: b.kind })),
        scope: asked ?? "all",
      }),
    );
  });

  // -------------------------------------------------------------------------
  // S8 · Schedules and the cashflow calendar (F7)
  // -------------------------------------------------------------------------
  router.get("/schedules", (ctx) => {
    const horizon = Number(ctx.query.get("days") ?? 60);
    const scope = budgetParam(ctx);
    const cashflow = projectCashflow(db, { days: horizon, budgetId: scope, viewerMemberId: viewer(ctx) });
    const view = buildBudgetView(db, undefined, scope, viewer(ctx));

    /*
     * 15 §3A.4 · A schedule belongs to a budget through **either** end: the
     * account the money comes out of, or the envelope it lands in. Those differ
     * exactly when one of you pays a shared bill from your own account, and the
     * rent is then a household schedule and hers at once — which is the same rule
     * Query uses for a transaction that crosses budgets.
     *
     * Scoping on the account alone made five household bills vanish from the
     * household's list the moment the account paying them moved into a personal
     * budget. The cashflow projection stays account-based, because that one is
     * about whose cash actually leaves.
     */
    const accountsInScope = new Set(
      listAccounts(db, { viewerMemberId: viewer(ctx) })
        .filter((a) => a.budget_id === scope)
        .map((a) => a.id),
    );
    const categoriesInScope = new Set(
      listCategories(db, { includeHidden: true, budgetId: scope, viewerMemberId: viewer(ctx) })
        .map((c) => c.id),
    );
    const inScopeSchedule = (s: { account_id: string | null; category_id: string | null }) =>
      (!s.account_id && !s.category_id)
      || (s.account_id !== null && accountsInScope.has(s.account_id))
      || (s.category_id !== null && categoriesInScope.has(s.category_id));

    return render(
      ctx, "Schedules",
      renderSchedules({
        schedules: listSchedules(db).filter(inScopeSchedule),
        detected: detectSchedules(db),
        cashflow,
        cashflowReading: describeCashflow(cashflow),
        subscriptions: subscriptions(db),
        horizon,
        categoryNames: new Map([...view.categories].map(([id, c]) => [id, c.name])),
        // The inline edit form needs the full lists, or saving would blank the
        // fields it does not show.
        categories: [...view.categories.values()]
          .filter((c) => !c.isPaymentCategory && !c.hidden)
          .map((c) => ({ id: c.id, name: c.name })),
        accounts: listAccounts(db, { viewerMemberId: viewer(ctx) })
          .filter((acc) => acc.kind === "budget" || acc.kind === "credit")
          .map((acc) => ({ id: acc.id, name: acc.nickname || acc.name })),
      }),
    );
  });

  // B51: the manual form the "Add one" button pointed at (it 405'd before).
  router.get("/schedules/new", (ctx) => {
    const view = buildBudgetView(db, undefined, undefined, viewer(ctx));
    return render(
      ctx, "Add a schedule",
      renderNewScheduleForm({
        accounts: listAccounts(db, { viewerMemberId: viewer(ctx) }).map((a) => ({ id: a.id, name: a.name, nickname: a.nickname })),
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
        categoryId: requireVisibleCategory(ctx, field(ctx.body, "category_id") || null) || null,
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
      /*
       * Money in as well as money out. The route forced -Math.abs() on every
       * amount, so a salary could not be scheduled at all — even though the
       * cashflow projection has always had an inflows side and the whole question
       * it answers ("will I make it to the 30th") depends on knowing when money
       * arrives, not only when it leaves.
       */
      const magnitude = Math.abs(amountField(field(ctx.body, "amount")));
      const direction = field(ctx.body, "direction") ?? "out";

      createSchedule(db, actorFor(a, "ui", ctx.req.headers["idempotency-key"] as string), {
        name: requiredField(ctx.body, "name"),
        amount: (direction === "in" ? magnitude : -magnitude) as Paise,
        recurrence: (field(ctx.body, "recurrence") ?? "monthly") as Recurrence,
        nextDue: dateField(field(ctx.body, "next_due"), "Next due"),
        categoryId: requireVisibleCategory(ctx, field(ctx.body, "category_id") || null) || null,
        accountId: field(ctx.body, "account_id") || null,
        isSubscription: field(ctx.body, "is_subscription") === "1",
      });
      return { redirect: "/schedules", message: "Schedule added." };
    }),
  );

  /*
   * A schedule was permanent once created: no edit, no delete, neither written.
   * A typo in the amount or a cancelled subscription stayed in the cashflow
   * projection for good — the one screen whose entire job is telling you whether
   * you will make it to the 30th.
   */
  router.post("/schedules/:id/edit", (ctx) =>
    mutate(ctx, (a) => {
      const amountRaw = field(ctx.body, "amount");
      const magnitude = amountRaw?.trim() ? Math.abs(amountField(amountRaw, "Amount")) : null;
      const direction = field(ctx.body, "direction") ?? "out";
      const dueRaw = field(ctx.body, "next_due");

      const schedule = updateSchedule(
        db, actorFor(a, "ui", ctx.req.headers["idempotency-key"] as string), ctx.params.id!,
        {
          name: field(ctx.body, "name") || undefined,
          amount: magnitude === null
            ? undefined
            : ((direction === "in" ? magnitude : -magnitude) as Paise),
          recurrence: (field(ctx.body, "recurrence") || undefined) as Recurrence | undefined,
          next_due: dueRaw?.trim() ? (parseDate(dueRaw) ?? undefined) : undefined,
          category_id: requireVisibleCategory(ctx, field(ctx.body, "category_id") || null) || null,
          account_id: field(ctx.body, "account_id") || null,
          is_subscription: field(ctx.body, "is_subscription") === "1" ? 1 : 0,
        },
      );
      return { redirect: "/schedules", message: `${schedule.name} updated.` };
    }),
  );

  /*
   * F7 · A schedule that lands in more than one envelope.
   *
   * Lines arrive as split_category_N / split_amount_N, the same shape the
   * transaction editor posts, so the two screens agree about what a split is.
   */
  router.post("/schedules/:id/splits", (ctx) =>
    mutate(ctx, (a) => {
      const id = ctx.params.id!;
      const lines: { categoryId: string | null; amount: Paise; memo?: string | null }[] = [];
      for (let i = 0; i < 20; i++) {
        const raw = String(field(ctx.body, `split_amount_${i}`) ?? "").trim();
        if (!raw) continue;
        const categoryId = field(ctx.body, `split_category_${i}`);
        lines.push({
          amount: amountField(raw, `Line ${i + 1}`),
          categoryId: categoryId ? requireVisibleCategory(ctx, categoryId)! : null,
          memo: field(ctx.body, `split_memo_${i}`) || null,
        });
      }
      setScheduleSplits(db, actorFor(a, "ui", ctx.req.headers["idempotency-key"] as string), id, lines);
      return {
        redirect: "/schedules",
        message: lines.length ? "Split saved. It applies from the next time this posts." : "Split removed.",
      };
    }),
  );

  router.post("/schedules/:id/delete", (ctx) =>
    mutate(ctx, (a) => {
      deleteSchedule(db, actorFor(a, "ui", ctx.req.headers["idempotency-key"] as string), ctx.params.id!);
      return {
        redirect: "/schedules",
        message: "Removed. Anything it already recorded is untouched.",
      };
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
    // 15 §6B · A goal belongs to a budget, so the list follows the switcher.
    const scope = budgetParam(ctx);
    const mine = budgetsFor(db, viewer(ctx));
    const view = buildBudgetView(db, undefined, scope, viewer(ctx));
    const balances = new Map(
      [...view.categories].map(([id, c]) => [id, { name: c.name, balance: c.state.balance }]),
    );

    return render(
      ctx, "Goals",
      renderGoals({
        goals: goalProgress(db, balances, todayIST(), [scope]),
        budgets: mine.map((b) => ({ id: b.id, name: b.name, kind: b.kind })),
      }),
    );
  });

  router.post("/goals/new", (ctx) =>
    mutate(ctx, (a) => {
      const actor = actorFor(a, "ui", ctx.req.headers["idempotency-key"] as string);
      const targetDate = field(ctx.body, "target_date");
      const name = requiredField(ctx.body, "name");

      /*
       * 15 §6B · Whose goal it is, chosen here and fixed after that. A goal is
       * measured by its envelope's balance, so moving it later would change what
       * months of watched history meant.
       */
      const asked = field(ctx.body, "budget_id");
      const mine = budgetsFor(db, a.member.id);
      const budgetId = mine.find((b) => b.id === asked)?.id ?? householdBudgetId(db);

      // B58 · The goal makes its own envelope; the rule lives in createGoal so
      // that every caller gets it, not only this form.
      createGoal(db, actor, {
        name,
        targetAmount: amountField(field(ctx.body, "target_amount"), "Target"),
        targetDate: targetDate ? parseDate(targetDate) : null,
        budgetId,
      });
      const budget = getBudget(db, budgetId);
      return {
        redirect: "/goals",
        message:
          `Goal added, with its own savings category in ` +
          `${budget?.kind === "household" ? "the household budget" : `${budget?.name}'s budget`}.`,
      };
    }),
  );

  // B58 · Create (or reuse) the app-managed "Savings goals" group and a fresh
  // category in it for a goal. The group is `internal`, so its categories carry
  // no manual controls on the Categories screen — the goal owns them.

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
      const view = buildBudgetView(db, undefined, undefined, viewer(ctx));
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
    const visibleCategories = new Set(
      listCategories(db, { includeHidden: true, viewerMemberId: viewer(ctx) }).map((c) => c.id),
    );
    const rows: PayeeRow[] = listPayees(db, viewer(ctx)).map((p) => {
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
        /*
         * 15 · And not if it is somebody else's envelope. "Blinkist — Books and
         * courses" told the whole household which private envelope one member
         * files a payee to, which is the same disclosure as showing the envelope
         * itself, arrived at sideways.
         */
        usualCategory: stats.usualCategoryId && visibleCategories.has(stats.usualCategoryId)
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
      strength: number | null;
    }>(
      db2,
      // N9 · Strongest evidence first, so the handful that is shown is the
      // handful worth reading. Hand-written rules have no count and keep their
      // own order, newest first.
      `SELECT * FROM rules WHERE proposed = ? AND dismissed_at IS NULL
        ORDER BY strength IS NULL, strength DESC, created_at DESC`,
      proposed ? 1 : 0,
    ).map((r) => ({
      id: r.id, name: r.name, stage: r.stage as Rule["stage"], match: "all",
      conditions: JSON.parse(r.conditions_json) as Rule["conditions"],
      actions: JSON.parse(r.actions_json) as Rule["actions"],
      enabled: r.enabled === 1,
      because: r.because,
      strength: r.strength,
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
      actions: [{ type: "setCategory", categoryId: requireVisibleCategory(ctx, requiredField(ctx.body, "category_id"))! }],
      enabled: true,
    };
  }

  function rulesPage(
    ctx: RequestContext,
    test?: Parameters<typeof renderRules>[0]["test"],
    draft?: Parameters<typeof renderRules>[0]["draft"],
  ) {
    const view = buildBudgetView(db, undefined, undefined, viewer(ctx));
    /*
     * 15 · The same rule as the review queue: a rule about an envelope you
     * cannot see is not yours to read, and a proposal states its evidence —
     * "You've put Zomato in Going out 4 times" — which gives away the envelope's
     * name, what goes in it and how often. Both lists, because a saved rule
     * discloses exactly as much as a proposed one.
     */
    const mine = new Set(view.categories.keys());
    const visibleRule = (rule: RuleRow): boolean =>
      rule.actions.every((action) => {
        if (action.type === "setCategory") return mine.has(action.categoryId);
        if (action.type === "splitFixed") {
          return action.parts.every((part) => mine.has(part.categoryId));
        }
        return true;
      });

    return render(
      ctx, "Rules",
      renderRules({
        rules: ruleRows(db, false).filter(visibleRule),
        proposed: ruleRows(db, true).filter(visibleRule),
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
    const view = buildBudgetView(db, undefined, undefined, viewer(ctx));

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
      confirmRule(db, actorFor(a), requiredField(ctx.body, "rule_id"));
      return { redirect: "/rules", message: "Rule confirmed." };
    }),
  );

  router.post("/rules/dismiss", (ctx) =>
    mutate(ctx, (a) => {
      // L5: dismissing a proposal suppresses that specific proposal for good.
      const id = requiredField(ctx.body, "rule_id");
      dismissRule(db, actorFor(a), id, ruleRows(db, true).find((r) => r.id === id));
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
    const budgetId = budgetParam(ctx);
    const view = buildBudgetView(db, undefined, budgetId, viewer(ctx));
    const budget = getBudget(db, budgetId);
    return render(
      ctx, "Categories",
      renderCategories(
        listGroups(db, budgetId).map((g) => ({
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
        budget ? { id: budget.id, name: budget.name, kind: budget.kind } : undefined,
      ),
    );
  });

  // 15 · A group belongs to the budget being looked at, which is how a personal
  // budget gets its first envelope without a second screen.
  router.post("/groups/new", (ctx) =>
    mutate(ctx, (a) => {
      const group = createGroup(
        db, actorFor(a, "ui", ctx.req.headers["idempotency-key"] as string),
        requiredField(ctx.body, "name"), "normal", budgetParam(ctx),
      );
      return { redirect: "/categories", message: `Added the group ${group.name}.` };
    }),
  );

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
      requireVisibleCategory(ctx, ctx.params.id!);
      if (hidden) guardCommitmentEnvelope(db, ctx.params.id!, "hidden");
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
      requireVisibleCategory(ctx, ctx.params.id!);
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
      requireVisibleCategory(ctx, ctx.params.id!);
      reorderCategory(db, actorFor(a, "ui", ctx.req.headers["idempotency-key"] as string),
        ctx.params.id!, dir);
      return { redirect: "/categories", message: "Moved." };
    }),
  );

  /*
   * A group could be created and reordered but never renamed or removed, so a
   * typo was permanent and an empty leftover stayed on the grid for good.
   * renameGroup had existed in the domain the whole time with nothing calling it.
   */
  router.post("/groups/:id/rename", (ctx) =>
    mutate(ctx, (a) => {
      const group = renameGroup(
        db, actorFor(a, "ui", ctx.req.headers["idempotency-key"] as string),
        ctx.params.id!, requiredField(ctx.body, "name"),
      );
      return { redirect: "/categories", message: `Renamed to ${group.name}.` };
    }),
  );

  router.post("/groups/:id/delete", (ctx) =>
    mutate(ctx, (a) => {
      deleteGroup(
        db, actorFor(a, "ui", ctx.req.headers["idempotency-key"] as string),
        requireVisibleGroup(ctx, ctx.params.id!),
      );
      return { redirect: "/categories", message: "Group deleted." };
    }),
  );

  router.post("/groups/:id/reorder", (ctx) =>
    mutate(ctx, (a) => {
      const dir = field(ctx.body, "direction") === "up" ? "up" : "down";
      reorderGroup(db, actorFor(a, "ui", ctx.req.headers["idempotency-key"] as string),
        requireVisibleGroup(ctx, ctx.params.id!), dir);
      return { redirect: "/categories", message: "Moved." };
    }),
  );

  // F3.5 · Delete a category (must be empty; its history can be remapped).
  /*
   * Merging two categories. `requireVisibleCategory` on both ends is what stops
   * this being a way to learn that somebody else's envelope exists: an id you
   * cannot see is a 404, the same as one that was never there.
   */
  router.post("/categories/:id/merge", (ctx) =>
    mutate(ctx, (a) => {
      const loser = requireVisibleCategory(ctx, ctx.params.id!)!;
      const winner = requireVisibleCategory(ctx, requiredField(ctx.body, "winner_id"))!;
      guardCommitmentEnvelope(db, loser, "merged");
      mergeCategories(db, actorFor(a, "ui", ctx.req.headers["idempotency-key"] as string), loser, winner);
      return {
        redirect: "/categories",
        message: `Merged into ${getCategory(db, winner)?.name ?? "that category"}. Its balance, history and targets came across.`,
      };
    }),
  );

  router.post("/categories/:id/delete", (ctx) =>
    mutate(ctx, (a) => {
      const id = requireVisibleCategory(ctx, ctx.params.id!)!;
      guardCommitmentEnvelope(db, id, "deleted");
      const view = buildBudgetView(db, undefined, undefined, viewer(ctx));
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
  function cashAccounts(ctx: RequestContext) {
    return listAccounts(db, { viewerMemberId: viewer(ctx) })
      .filter((a) => a.kind === "budget" && !a.closed_at)
      .map((a) => ({ id: a.id, name: a.name }));
  }

  router.get("/family", (ctx) => {
    auth(ctx);
    // H2.2 · A private arrangement is its holder's alone, the same as a loan.
    const loans = listFamilyLoans(db, { includeClosed: true, viewerMemberId: viewer(ctx) })
      .map((l) => viewFamilyLoan(db, l.id))
      .filter((v): v is NonNullable<typeof v> => v !== null);

    return render(ctx, "Lending in the family", renderFamilyLoans({
      loans, accounts: cashAccounts(ctx),
      members: listMembers(db).map((m) => ({ id: m.id, name: m.name })),
    }));
  });

  router.post("/family/new", (ctx) =>
    mutate(ctx, (a) => {
      const agreed = field(ctx.body, "agreed_total");
      const loan = createFamilyLoan(db, actorFor(a), {
        counterparty: requiredField(ctx.body, "counterparty"),
        agreedTotal: agreed ? amountField(agreed) : null,
        note: field(ctx.body, "note") || null,
        // H2 / H2.2 · Money lent to your cousin can be yours rather than the
        // household's, the same as an asset or a loan.
        holderMemberId: field(ctx.body, "holder_member_id") || null,
        visibility: field(ctx.body, "visibility") === "private" ? "private" : undefined,
      });
      return {
        redirect: `/family/${loan.id}`,
        message: "Now record what has actually moved — the balance comes from that.",
      };
    }),
  );

  router.get("/family/:id", (ctx) => {
    requireFamilyLoanVisible(ctx);
    auth(ctx);
    const view = viewFamilyLoan(db, ctx.params.id!);
    if (!view) throw new NotFound("That arrangement does not exist.");

    const entries = queryAll<{ date: string; amount: number; memo: string | null }>(
      db,
      `SELECT date, amount, memo FROM transactions
        WHERE account_id = ? AND deleted_at IS NULL ORDER BY date DESC, created_at DESC`,
      view.loan.account_id,
    );

    const budgetView = buildBudgetView(db, undefined, undefined, viewer(ctx));
    return render(ctx, view.loan.counterparty, renderFamilyLoan({
      view,
      accounts: cashAccounts(ctx),
      categories: [...budgetView.categories.values()]
        .filter((c) => !c.isPaymentCategory && !c.hidden)
        .map((c) => ({ id: c.id, name: c.name })),
      entries: entries.map((e) => ({ ...e, amount: e.amount as never })),
      confirmingWriteOff: ctx.query.get("confirm") === "write-off",
    }));
  });

  router.post("/family/:id/advance", (ctx) =>
    mutate(ctx, (a) => {
      requireFamilyLoanVisible(ctx);
      const dateRaw = field(ctx.body, "date");
      recordAdvance(db, actorFor(a, "ui", ctx.req.headers["idempotency-key"] as string), {
        loanId: ctx.params.id!,
        amount: Math.abs(amountField(requiredField(ctx.body, "amount"))),
        date: dateField(dateRaw),
        fromAccountId: requiredField(ctx.body, "account_id"),
      });
      return { redirect: `/family/${ctx.params.id}`, message: "Recorded." };
    }),
  );

  router.post("/family/:id/repayment", (ctx) =>
    mutate(ctx, (a) => {
      requireFamilyLoanVisible(ctx);
      const dateRaw = field(ctx.body, "date");
      recordRepayment(db, actorFor(a, "ui", ctx.req.headers["idempotency-key"] as string), {
        loanId: ctx.params.id!,
        amount: Math.abs(amountField(requiredField(ctx.body, "amount"))),
        date: dateField(dateRaw),
        accountId: requiredField(ctx.body, "account_id"),
      });
      return { redirect: `/family/${ctx.params.id}`, message: "Recorded." };
    }),
  );

  router.post("/family/:id/write-off", (ctx) => {
    requireFamilyLoanVisible(ctx);
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
      categoryId: requireVisibleCategory(ctx, requiredField(ctx.body, "category_id"))!,
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
      requireFamilyLoanVisible(ctx);
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
    refuseInDemo(config, "Creating API tokens");
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
    /*
     * B126 · 15 §6.1 · A month close is per budget, and this page listed every
     * budget's. With three budgets that is every month three times over, the
     * same figures repeated, with nothing on the row to say whose close each one
     * was — a page that looked like it was printing duplicates. The switcher is
     * on this screen; it now means something here too.
     */
    const budgetId = budgetParam(ctx);
    return render(ctx, "Month closes", renderClosedMonths({
      months: closedMonths(db, 24, budgetId),
      awaiting: monthAwaitingClose(db, todayIST(), budgetId),
    }));
  });

  router.get("/months/:month/close", (ctx) => {
    auth(ctx);
    const month = ctx.params.month!;
    if (!isMonthKey(month)) throw new NotFound("That is not a month.");
    // 15 §6.1 · Each budget closes on its own, so it is the one being looked at.
    const budgetId = budgetParam(ctx);
    return render(
      ctx, `Closing ${formatMonth(month)}`,
      renderMonthClose(monthCloseView(db, month, todayIST(), budgetId)),
    );
  });

  router.post("/months/:month/close", (ctx) =>
    mutate(ctx, (a) => {
      const month = ctx.params.month!;
      if (!isMonthKey(month)) throw new NotFound("That is not a month.");

      const budgetId = budgetParam(ctx);
      const result = closeMonth(
        db, actorFor(a, "ui", ctx.req.headers["idempotency-key"] as string),
        month, field(ctx.body, "note") || null, budgetId,
      );

      return {
        redirect: `/?month=${addMonths(month, 1)}&budget=${budgetId}`,
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
      reopenMonth(db, actorFor(a), month, budgetParam(ctx));
      return { redirect: "/months", message: `${formatMonth(month)} is open again.` };
    }),
  );

  // -------------------------------------------------------------------------
  // `04` §3.4 · Gmail ingestion — a separate, opt-in connection.
  // -------------------------------------------------------------------------

  router.get("/gmail/connect", (ctx) => {
    refuseInDemo(config, "Connecting a mailbox");
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
  router.post("/settings/identity", (ctx) => {
    refuseInDemo(config, "Saving a statement identity");
    return mutate(ctx, (a) => {
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
    });
  });

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

  /*
   * A projection, not a ledger figure, and scoped to whoever is looking: a
   * private investment account must not reach somebody else's corpus, since a
   * total that includes what they cannot see publishes it by subtraction.
   */
  router.get("/fire", (ctx) => {
    requireAssets();
    const percent = (name: string, fallback: number): number => {
      const raw = ctx.query.get(name);
      if (!raw?.trim()) return fallback;
      const value = Number(raw.trim());
      // A nonsense rate is ignored rather than refused — this screen is a
      // sandbox for trying numbers, and a 422 in the middle of that is rude.
      if (!Number.isFinite(value) || value <= 0 || value > 100) return fallback;
      return Math.round(value * 100);
    };
    const ageRaw = ctx.query.get("age")?.trim();
    const age = ageRaw ? Number(ageRaw) : NaN;

    const projection = fireProjection(db, {
      viewerMemberId: viewer(ctx),
      scope: holderScopeParam(ctx),
      assumptions: {
        withdrawalRateBp: percent("swr", DEFAULT_ASSUMPTIONS.withdrawalRateBp),
        realReturnBp: percent("ret", DEFAULT_ASSUMPTIONS.realReturnBp),
        includeLocked: (ctx.query.get("locked") ?? "1") !== "0",
        currentAge: Number.isFinite(age) && age > 0 && age < 120 ? age : null,
      },
    });

    return render(ctx, "Financial independence", renderFire({ projection }));
  });

  router.get("/portfolio", (ctx) => {
    requireAssets();
    const balances = accountBalances(db);
    const scope = holderScopeParam(ctx);
    const hidden = hiddenAccountIds(db, viewer(ctx), scope);
    const accounts = new Map(
      listAssetAccounts(db, { viewerMemberId: viewer(ctx) })
        .filter((a) => !hidden.has(a.id))
        .map((a) => [a.id, a.name]),
    );

    const rows: PortfolioRow[] = listHoldings(db)
      .filter((h) => accounts.has(h.account_id))
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

    /*
     * B101 · An asset with no valuation yet is still an asset.
     *
     * This dropped them, so adding "SafeGold" and not immediately valuing it
     * made the account disappear from Portfolio and from Net worth both — the
     * account was in the database and nowhere on screen, with nothing
     * prompting for the number that would bring it back. A thing that vanishes
     * after you create it is the worst way to lose someone's trust in a ledger.
     */
    /*
     * listValuableAccounts, not listAssetAccounts.
     *
     * The first covers the six asset subtypes; the second adds the plain ones —
     * "other asset", "other liability", fixed and recurring deposits. The
     * revalue-everything screen already used the wider list, so those accounts
     * appeared there, could be revalued, and were then nowhere on this page.
     * The same account being on one screen and not the other is how a household
     * concludes the revaluation did nothing.
     */
    const manualAssets = listValuableAccounts(db, { viewerMemberId: viewer(ctx) })
      // A portfolio is what you hold. A deposit belongs here — it is an
      // investment, and a household thinks of it as one — but "other
      // liability" does not: it is a debt, it belongs on net worth's other
      // side, and it is revaluable from the valuations screen without
      // appearing on a page headed Portfolio.
      .filter((a) => a.subtype !== "liability")
      .filter((a) => listHoldings(db, a.id).length === 0)
      .map((a) => {
        const valuation = latestValuation(db, a.id);
        /*
         * A deposit is worth its balance unless somebody has said otherwise
         * (B56), and that is the whole reason it is a tracking account: the
         * interest credited to it is a transaction, and the balance moves with
         * it. Reading only the stated valuation showed a fixed deposit holding
         * ₹5,32,000 as "no value yet", which is the app disbelieving its own
         * ledger.
         */
        const counted = !DERIVED_VALUE_SUBTYPES.has(a.subtype);
        const balance = counted ? (balances.get(a.id)?.working ?? 0) as Paise : (0 as Paise);
        return {
          id: a.id, name: a.name, subtype: a.subtype,
          value: valuation?.value ?? balance,
          asOf: valuation?.asOf ?? (counted ? todayIST() : null),
          stale: valuation?.stale ?? false,
          valued: valuation !== null || (counted && balance !== 0),
        };
      });

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

    const accountNames = new Map(listAssetAccounts(db, { viewerMemberId: viewer(ctx) }).map((acc) => [acc.id, acc.name]));

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
    const view = buildBudgetView(db, undefined, undefined, viewer(ctx));

    // The search is a server-side call (P7) and needs no key (§6.2).
    return Promise.resolve(
      query ? searchSchemes(query) : Promise.resolve([]),
    ).then((results) =>
      render(
        ctx, "Add a holding",
        renderAddHolding({
          assetAccounts: listAssetAccounts(db, { viewerMemberId: viewer(ctx) }).map((a) => ({ id: a.id, name: a.name })),
          budgetAccounts: listAccounts(db, { viewerMemberId: viewer(ctx) })
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
        tradeDate: dateField(field(ctx.body, "trade_date"), "Trade date"),
        price: toUnitPrice(unitPrice),
        amount: amountRaw?.trim() ? amountField(amountRaw) : undefined,
        units: amountRaw?.trim() ? undefined : toUnits(Number(field(ctx.body, "units") ?? 0)),
        fees: feesRaw?.trim() ? amountField(feesRaw) : 0,
        fromAccountId: field(ctx.body, "from_account_id") || null,
        categoryId: requireVisibleCategory(ctx, field(ctx.body, "category_id") || null) || null,
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
    const account = listAssetAccounts(db, { viewerMemberId: viewer(ctx) }).find((a) => a.id === view.holding.account_id);

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
        asOf: dateField(field(ctx.body, "as_of"), "As of"),
        source: "manual",
      });
      return { redirect: `/portfolio/${view.holding.id}`, message: "Price saved." };
    }),
  );

  // B72 · R28.2 · A split or bonus, which adjusts every lot and the price
  // history together. The domain function existed; the screen did not.
  router.get("/portfolio/:id/split", (ctx) => {
    requireAssets();
    const view = viewHolding(db, ctx.params.id!);
    if (!view) throw new NotFound("That holding does not exist.");
    return render(
      ctx, "Split or bonus",
      renderSplitForm({
        holdingId: view.holding.id,
        instrumentName: view.instrument.name,
        units: formatUnits(view.units),
        today: todayIST(),
      }),
    );
  });

  router.post("/portfolio/:id/split", (ctx) =>
    mutate(ctx, (a) => {
      requireAssets();
      const view = viewHolding(db, ctx.params.id!);
      if (!view) throw new NotFound("That holding does not exist.");
      const ratio = Number(requiredField(ctx.body, "ratio"));
      if (!Number.isFinite(ratio) || ratio <= 0) {
        throw new HttpError(400, "A split ratio has to be a number above zero.");
      }
      const kind = field(ctx.body, "kind") === "bonus" ? "bonus" : "split";
      recordSplit(db, actorFor(a, "ui", ctx.req.headers["idempotency-key"] as string), {
        holdingId: view.holding.id,
        date: dateField(field(ctx.body, "date")),
        ratio,
        kind,
      });
      return {
        redirect: `/portfolio/${view.holding.id}`,
        message: `Recorded the ${kind}. Your units and their cost moved together.`,
      };
    }),
  );

  /*
   * R28 · A merger. `applyMerger` existed, the events table allowed the kind,
   * and no route tied them together — the same shape of gap as B71 and B72, and
   * the one corporate action an Indian fund investor is most likely to meet.
   */
  router.get("/portfolio/:id/merge", (ctx) => {
    requireAssets();
    const view = viewHolding(db, ctx.params.id!);
    if (!view) throw new NotFound("That holding does not exist.");
    return render(
      ctx, "Merger",
      renderMergerForm({
        holdingId: view.holding.id,
        instrumentName: view.instrument.name,
        units: formatUnits(view.units),
        today: todayIST(),
        instruments: listInstruments(db)
          .filter((i) => i.id !== view.instrument.id)
          .map((i) => ({ id: i.id, name: i.name })),
      }),
    );
  });

  router.post("/portfolio/:id/merge", (ctx) =>
    mutate(ctx, (a) => {
      requireAssets();
      const view = viewHolding(db, ctx.params.id!);
      if (!view) throw new NotFound("That holding does not exist.");
      const ratio = Number(requiredField(ctx.body, "ratio"));
      if (!Number.isFinite(ratio) || ratio <= 0) {
        throw new HttpError(400, "A merger ratio has to be a number above zero.");
      }
      recordMerger(db, actorFor(a, "ui", ctx.req.headers["idempotency-key"] as string), {
        holdingId: view.holding.id,
        date: dateField(field(ctx.body, "date")),
        ratio,
        intoInstrumentId: field(ctx.body, "into_instrument_id") || null,
      });
      return {
        redirect: `/portfolio/${view.holding.id}`,
        message:
          "Recorded the merger. Your cost and purchase dates carried forward, " +
          "so nothing was realised.",
      };
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
        accounts: listAccounts(db, { viewerMemberId: viewer(ctx) })
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
      const chargesRaw = field(ctx.body, "charges");
      const preview = recordSale(db, actorFor(a, "ui", ctx.req.headers["idempotency-key"] as string), {
        holdingId,
        units: toUnits(Number(requiredField(ctx.body, "units"))),
        price: toUnitPrice(Number(requiredField(ctx.body, "price"))),
        // R27 · Realised gains are reported by financial year, so a sale
        // recorded late under today's date lands in the wrong year's figure.
        date: dateField(field(ctx.body, "date"), "Date of sale"),
        charges: chargesRaw?.trim()
          ? (Math.abs(amountField(chargesRaw, "Charges")) as Paise)
          : undefined,
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
    const scope = holderScopeParam(ctx);
    const statement = netWorthStatement(db, todayIST(), "INR", {
      viewerMemberId: viewer(ctx), scope,
    });
    const history = netWorthHistory(db);
    const previous = history.at(-2);

    return render(
      ctx, "Net worth",
      renderNetWorth({
        scope,
        members: listMembers(db).map((m) => ({ id: m.id, name: m.name })),
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
    return render(ctx, "Add an asset", renderNewAssetForm({
      today: todayIST(),
      members: listMembers(db).map((m) => ({ id: m.id, name: m.name })),
      payFrom: listAccounts(db, { viewerMemberId: viewer(ctx) })
        .filter((acc) => acc.kind === "budget")
        .map((acc) => ({ id: acc.id, name: acc.name })),
      categories: [...buildBudgetView(db, undefined, undefined, viewer(ctx)).categories.values()]
        .filter((c) => !c.hidden && !c.isPaymentCategory)
        .map((c) => ({ id: c.id, name: c.name })),
    }));
  });

  router.post("/portfolio/asset/new", (ctx) =>
    mutate(ctx, (a) => {
      requireAssets();
      const valueRaw = field(ctx.body, "value");
      const account = createAssetAccount(db, actorFor(a), {
        holderMemberId: field(ctx.body, "holder_member_id") || null,
        visibility: field(ctx.body, "visibility") === "private" ? "private" : "household",
        name: requiredField(ctx.body, "name"),
        subtype: requiredField(ctx.body, "subtype") as "physical",
        openingValue: valueRaw?.trim() ? amountField(valueRaw) : undefined,
        asOf: dateField(field(ctx.body, "as_of"), "As of"),
      });

      /*
       * If it was bought just now, the money has to leave somewhere. Without
       * this the asset appears and net worth rises by its value with nothing on
       * the other side — value created out of nothing, which is the one thing a
       * ledger must never do quietly.
       *
       * Optional, because recording a flat somebody has lived in for years is
       * the commoner case and no money moves in it.
       */
      const paidFrom = field(ctx.body, "paid_from");
      const value = valueRaw?.trim() ? amountField(valueRaw) : 0;
      let note = "";
      if (paidFrom && value > 0) {
        const from = requireVisibleAccount(ctx, paidFrom)!.id;
        const categoryId = field(ctx.body, "paid_category");
        createTransaction(db, actorFor(a, "ui", ctx.req.headers["idempotency-key"] as string), {
          accountId: from,
          amount: -value as Paise,
          date: dateField(field(ctx.body, "as_of"), "As of"),
          categoryId: categoryId ? requireVisibleCategory(ctx, categoryId)! : null,
          memo: `Bought ${account.name}`,
        });
        note = ` ${formatPaise(value as Paise)} recorded as leaving ${getAccount(db, from)?.name ?? "that account"}.`;
      }

      return { redirect: "/portfolio", message: `Added ${account.name}.${note}` };
    }),
  );

  /*
   * B101 · R23.2 · Every hand-valued pot in one sitting.
   *
   * Gold with one provider, gold with another, a pension balance: three
   * statements a month and no feed that can price any of them. One at a time is
   * how a valuation comes to be six months old.
   */
  router.get("/portfolio/valuations", (ctx) => {
    requireAssets();
    auth(ctx);
    return render(
      ctx, "Update valuations",
      renderValuations({
        assets: listValuableAccounts(db, { viewerMemberId: viewer(ctx) })
          // Only the kinds you state by hand. A deposit is worth its balance.
          .filter((a) => REVALUABLE_SUBTYPES.has(a.subtype))
          .filter((a) => listHoldings(db, a.id).length === 0)
          .map((a) => {
            const valuation = latestValuation(db, a.id);
            return {
              id: a.id, name: a.name, subtype: a.subtype, currency: a.currency,
              value: valuation?.value ?? (0 as Paise),
              asOf: valuation?.asOf ?? null,
              stale: valuation?.stale ?? false,
              valued: valuation !== null,
            };
          }),
        today: todayIST(),
      }),
    );
  });

  router.post("/portfolio/valuations", (ctx) =>
    mutate(ctx, (a) => {
      requireAssets();
      const actor = actorFor(a, "ui", ctx.req.headers["idempotency-key"] as string);
      const assets = listValuableAccounts(db, { viewerMemberId: viewer(ctx) })
        .filter((x) => REVALUABLE_SUBTYPES.has(x.subtype))
        .filter((x) => listHoldings(db, x.id).length === 0);

      let saved = 0;
      for (const asset of assets) {
        // An empty box means "leave this one alone", which is what makes the
        // screen usable when only one statement has arrived.
        const raw = field(ctx.body, `value-${asset.id}`);
        if (!raw?.trim()) continue;

        const asOfRaw = field(ctx.body, `asof-${asset.id}`);
        recordValuation(db, actor, {
          accountId: asset.id,
          value: signedValuation(asset.subtype, amountField(raw, asset.name) as Paise),
          asOf: dateField(asOfRaw, `${asset.name} — as of`),
        });
        saved++;
      }

      return {
        redirect: "/portfolio",
        message: saved === 0
          ? "Nothing was filled in, so nothing changed."
          : `Updated ${saved} valuation${saved === 1 ? "" : "s"}.`,
      };
    }),
  );

  /*
   * Disposing of a hand-valued asset.
   *
   * It could be created and revalued but never sold, so the gold that paid for
   * a wedding stayed on the net worth statement forever and the only way out
   * was to revalue it to zero — which loses both the proceeds and the fact that
   * anything happened.
   *
   * A disposal is two facts: the asset is gone, and money arrived. Recording
   * only the first is the mirror of creating one without saying where the money
   * came from.
   */
  /*
   * Buying more of a hand-valued asset. The mirror of disposing of one: money
   * leaves, and the stated value changes. Revaluing alone loses the payment.
   */
  router.get("/portfolio/asset/:id/add", (ctx) => {
    requireAssets();
    auth(ctx);
    const account = requireVisibleAccount(ctx, ctx.params.id!)!;
    const valuation = latestValuation(db, account.id);
    return render(ctx, `Add to ${account.name}`, renderAddToAsset({
      account: { id: account.id, name: account.name },
      lastValue: valuation?.value ?? (0 as Paise),
      lastAsOf: valuation?.asOf ?? null,
      today: todayIST(),
      payFrom: listAccounts(db, { viewerMemberId: viewer(ctx) })
        .filter((acc) => acc.kind === "budget")
        .map((acc) => ({ id: acc.id, name: acc.name })),
      categories: [...buildBudgetView(db, undefined, undefined, viewer(ctx)).categories.values()]
        .filter((c) => !c.hidden && !c.isPaymentCategory)
        .map((c) => ({ id: c.id, name: c.name })),
    }));
  });

  router.post("/portfolio/asset/:id/add", (ctx) =>
    mutate(ctx, (a) => {
      requireAssets();
      const account = requireVisibleAccount(ctx, ctx.params.id!)!;
      const actor = actorFor(a, "ui", ctx.req.headers["idempotency-key"] as string);
      const spent = amountField(requiredField(ctx.body, "spent"), "What you paid");
      if (spent <= 0) throw new Refusal("Enter what you paid, above zero.");
      const on = dateField(field(ctx.body, "on"), "Date");

      const paidFrom = field(ctx.body, "paid_from");
      let note = "";
      if (paidFrom) {
        const from = requireVisibleAccount(ctx, paidFrom)!.id;
        const categoryId = field(ctx.body, "paid_category");
        createTransaction(db, actor, {
          accountId: from,
          amount: -spent as Paise,
          date: on,
          categoryId: categoryId ? requireVisibleCategory(ctx, categoryId)! : null,
          memo: `Added to ${account.name}`,
        });
        note = ` ${formatPaise(spent as Paise)} recorded as leaving ${getAccount(db, from)?.name ?? "that account"}.`;
      }

      const raw = field(ctx.body, "new_value");
      const stated = raw?.trim()
        ? amountField(raw, "What it is worth")
        : ((latestValuation(db, account.id)?.value ?? 0) + spent);
      recordValuation(db, actor, {
        accountId: account.id,
        value: signedValuation(account.subtype, stated as Paise),
        asOf: on,
        note: `Added ${formatPaise(spent as Paise)}`,
      });

      return { redirect: `/accounts/${account.id}`, message: `${account.name} updated.${note}` };
    }),
  );

  router.get("/portfolio/asset/:id/dispose", (ctx) => {
    requireAssets();
    auth(ctx);
    const account = requireVisibleAccount(ctx, ctx.params.id!)!;
    const valuation = latestValuation(db, account.id);
    return render(ctx, `Sell ${account.name}`, renderDisposeAsset({
      account: { id: account.id, name: account.name },
      lastValue: valuation?.value ?? (0 as Paise),
      lastAsOf: valuation?.asOf ?? null,
      today: todayIST(),
      intoAccounts: listAccounts(db, { viewerMemberId: viewer(ctx) })
        .filter((acc) => acc.kind === "budget")
        .map((acc) => ({ id: acc.id, name: acc.name })),
    }));
  });

  router.post("/portfolio/asset/:id/dispose", (ctx) =>
    mutate(ctx, (a) => {
      requireAssets();
      const account = requireVisibleAccount(ctx, ctx.params.id!)!;
      const proceeds = amountField(field(ctx.body, "proceeds"), "Proceeds");
      const on = dateField(field(ctx.body, "on"), "Date");
      const into = field(ctx.body, "into_account");
      const actor = actorFor(a, "ui", ctx.req.headers["idempotency-key"] as string);

      if (proceeds < 0) throw new Refusal("Proceeds cannot be negative.");

      /*
       * The money first, then the asset — so that if the transaction is
       * refused, the asset is still here and the household has not lost an
       * entry with nothing to show for it.
       */
      let note = "";
      if (into && proceeds > 0) {
        const target = requireVisibleAccount(ctx, into)!.id;
        createTransaction(db, actor, {
          accountId: target,
          amount: proceeds as Paise,
          date: on,
          categoryId: null,
          memo: `Sold ${account.name}`,
        });
        note = ` ${formatPaise(proceeds as Paise)} recorded into ${getAccount(db, target)?.name ?? "that account"}.`;
      }

      /*
       * Part of it is the ordinary case — a few grams of gold, not the whole
       * holding — so what is left decides whether the account closes. Selling
       * all of it was the only option before, which meant somebody selling a
       * portion had to close the account and create a new one for the
       * remainder, losing its history to record something that did not happen.
       */
      const remainingRaw = field(ctx.body, "remaining");
      const remaining = remainingRaw?.trim() ? amountField(remainingRaw, "What is left") : 0;
      if (remaining < 0) throw new Refusal("What is left cannot be negative.");

      recordValuation(db, actor, {
        accountId: account.id,
        value: signedValuation(account.subtype, remaining as Paise),
        asOf: on,
        note: remaining > 0
          ? `Sold part${proceeds > 0 ? ` for ${formatPaise(proceeds as Paise)}` : ""}`
          : `Disposed of${proceeds > 0 ? ` for ${formatPaise(proceeds as Paise)}` : ""}`,
      });
      if (remaining === 0) closeAccount(db, actor, account.id);

      return {
        redirect: remaining > 0 ? `/portfolio/asset/${account.id}` : "/portfolio",
        message: remaining > 0
          ? `Sold part of ${account.name}; ${formatPaise(remaining as Paise)} left.${note}`
          : `${account.name} sold.${note}`,
      };
    }),
  );

  router.get("/portfolio/asset/:id/revalue", (ctx) => {
    requireAssets();
    auth(ctx);
    const account = listValuableAccounts(db, { viewerMemberId: viewer(ctx) }).find((acc) => acc.id === ctx.params.id);
    if (!account) throw new NotFound("That asset does not exist.");
    const valuation = latestValuation(db, account.id);
    return render(
      ctx, `Revalue ${account.name}`,
      renderRevalueAsset({
        asset: {
          id: account.id, name: account.name, currency: account.currency,
          value: valuation?.value ?? 0, asOf: valuation?.asOf ?? todayIST(),
        },
        today: todayIST(),
      }),
    );
  });

  router.post("/portfolio/asset/:id/revalue", (ctx) =>
    mutate(ctx, (a) => {
      requireAssets();
      const account = listValuableAccounts(db, { viewerMemberId: viewer(ctx) }).find((acc) => acc.id === ctx.params.id);
      if (!account) throw new NotFound("That asset does not exist.");
      if (!REVALUABLE_SUBTYPES.has(account.subtype)) {
        throw new Refusal(
          `${account.name} is worth its balance, so there is nothing to state. ` +
          "Record what happened to it — interest credited, money paid in — as a transaction.",
        );
      }
      recordValuation(db, actorFor(a), {
        accountId: account.id,
        value: signedValuation(account.subtype, amountField(requiredField(ctx.body, "value")) as Paise),
        asOf: dateField(field(ctx.body, "as_of"), "As of"),
        note: "Revalued",
      });
      return { redirect: `/accounts/${account.id}`, message: `Revalued ${account.name}.` };
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
          {
            /*
             * Slabs change with a Finance Act, roughly every February. The app
             * ships them as data and refuses a year it does not have rather
             * than applying the previous year's — so the failure mode is a
             * refusal, not a wrong number. This is what turns that refusal into
             * something an operator sees coming, instead of discovering it the
             * first time somebody opens the screen in April.
             */
            name: "Tax rates",
            state: staleRatesWarning(fiscalYearOf(todayIST())) ? "degraded" : "healthy",
            reason: staleRatesWarning(fiscalYearOf(todayIST()))
              ?? `Cover the current financial year. Last checked ${RATES_VERIFIED_ON} against ${RATES_SOURCE}.`,
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
        "Content-Disposition": `attachment; filename="pathayam-${todayIST()}.json"`,
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
  // -------------------------------------------------------------------------
  // Q31 · Tax estimate
  //
  // Reverses 02 N15, deliberately. Per member and per financial year, because
  // income tax in India is assessed on an individual — a household figure
  // would mix one member's salary into another's estimate.
  // -------------------------------------------------------------------------
  function taxPageProps(ctx: RequestContext, a: ReturnType<typeof auth>) {
    const fyParam = Number(ctx.query.get("fy"));
    const fy = Number.isInteger(fyParam) && fyParam > 2000 ? fyParam : fiscalYearOf(todayIST());

    const stored = getDeclaration(db, a.member.id, fy);
    const visible = listAccounts(db, { viewerMemberId: a.member.id })
      .filter((acc) => acc.kind === "budget")
      .map((acc) => acc.id);
    const ledgerIncome = incomeInFinancialYear(db, fy, visible);
    const gross = stored.gross > 0 ? stored.gross : ledgerIncome;

    // Capital gains are taxed at their own rates and are scoped to this
    // member's own holdings — another member's sale is not part of their
    // assessment.
    const gains = capitalGainsTaxFor(db, fy, a.member.id);

    let estimate = null;
    let advance: AdvanceInstalment[] = [];
    if ((gross > 0 || gains.specialRateTax > 0) && !staleRatesWarning(fy)) {
      estimate = estimateTax(fy, gross, stored, gains);
      const liability = estimate.better === "old" ? estimate.old.total : estimate.new.total;
      advance = advanceTaxSchedule(fy, liability);
    }

    return {
      fy, gross, ledgerIncome, deductions: stored, estimate, advance, gains,
      staleWarning: staleRatesWarning(fy),
      ratesVerifiedOn: RATES_VERIFIED_ON,
      ratesSource: RATES_SOURCE,
      availableYears: Object.keys(RULES).map(Number).sort((x, y) => y - x),
    };
  }

  router.get("/tax", (ctx) => {
    const a = auth(ctx);
    return render(ctx, "Tax estimate", renderTax(taxPageProps(ctx, a)));
  });

  router.post("/tax", (ctx) =>
    mutate(ctx, (a) => {
      const fy = Number(field(ctx.body, "fy"));
      if (!Number.isInteger(fy)) throw new Refusal("Pick a financial year.");

      const money = (name: string): Paise => {
        const raw = String(field(ctx.body, name) ?? "").trim();
        return raw ? amountField(raw, name) : (0 as Paise);
      };

      const received = money("hra_received");
      const rentPaid = money("hra_rent");
      const basic = money("hra_basic");

      saveDeclaration(db, a.member.id, fy, {
        gross: money("gross"),
        s80c: money("s80c"),
        s80d: money("s80d"),
        s80dSenior: field(ctx.body, "s80d_senior") === "1",
        other: money("other"),
        hra: (received || rentPaid || basic)
          ? { received, rentPaid, basic, metro: field(ctx.body, "hra_metro") === "1" }
          : null,
      });

      return { redirect: `/tax?fy=${fy}`, message: "Saved. The estimate is recalculated." };
    }),
  );

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
            <!-- The page's own title, so it is the page's heading. -->
            <h1>Something went wrong</h1>
            <p>${message}</p>
            <p><a class="button" href="/">Back to the budget</a></p>
          </div>
        `,
  );
}