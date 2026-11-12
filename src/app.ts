/**
 * Route table and middleware.
 *
 * Two things are enforced here for every request rather than in each handler,
 * because "we forgot one" is exactly how both of them fail:
 *
 * - authentication and the allow-list (R38.16)
 * - an idempotency key on every mutation (R36.1, N20)
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { DB } from "./db/db.ts";
import { queryAll, queryOne, execute, newId , transact } from "./db/db.ts";
import { VERSION } from "./version.ts";
import { devLoginModulePresent, type Config } from "./config.ts";
import { pathAvailable, FEATURE_NAMES, FEATURE_ENV } from "./features.ts";
import {
  Router, field, fieldList, fileField, requiredField, HttpError, NotFound,
  type RequestContext, type Response, rawBodies,
} from "./http/router.ts";
import { clientIp, wantsJson, contentSecurityPolicy } from "./http/server.ts";
import { html, raw, when, type SafeHtml } from "./http/html.ts";
import { page, MANIFEST, ASSET_VERSION, type Theme } from "./web/layout.ts";
import { STYLESHEET } from "./web/styles.ts";
import { CLIENT_SCRIPT } from "./web/client.ts";
import { APP_ICON_SVG, APP_ICON_SMALL_SVG } from "./web/icon.ts";
import { ICON_FILES } from "./web/icon-files.ts";
import {
  authenticate, parseCookies, sessionCookie, clearedSessionCookie, SESSION_COOKIE,
  actorFor, setTheme, listMembers, memberCount, inviteMember, createSession,
  startImpersonation, stopImpersonation, setImpersonationWrites, listSessions,
  revokeSession, recordAuthAttempt, isRateLimited, findMemberByEmail, getMember,
  removeMember, revokeAllSessions,
  type AuthContext,
} from "./auth/sessions.ts";
import {
  authenticateToken, tokenMayReach, checkTokenRateLimit, tokenRedacts, type ApiToken,
  isAiToken, aiConnectionId,
  mintToken, listTokens, revokeToken, type TokenScope,
} from "./auth/tokens.ts";
import { beginOAuth, exchangeCode, OAuthError } from "./auth/google.ts";
// OAUTH · As a namespace: google.ts already owns these names for the other
// direction, where this app is the client.
import * as oauth from "./auth/oauth.ts";
import { renderConsent, renderConsentProblem } from "./web/pages/oauth.ts";
import { PendingStates } from "./auth/pending.ts";
import {
  beginGmailConnect, exchangeGmailCode, revokeToken as revokeGmailToken, GmailAuthError,
} from "./gmail/oauth.ts";
import {
  saveConnection, deleteConnection, connectionView, getConnection, refreshTokenOf,
} from "./gmail/connection.ts";
import {
  saveClient, clearClient, clientView, clientForConnect, clientForConnection, canSaveClients, HOUSEHOLD,
} from "./gmail/clients.ts";
import { fetchGmail } from "./gmail/fetch.ts";
import { GoogleUnreachable } from "./gmail/client.ts";
import { withIdempotency, IdempotencyConflict } from "./core/idempotency.ts";
import { parseAmount, evaluateAmountExpression, formatPaise, type Paise } from "./core/money.ts";
import {
  parseDate, todayIST, nowIST, addDays, addMonths, monthOf, isMonthKey, formatMonth, formatDate,
  formatDateTime, fiscalYearOf, formatFiscalYear, statementPeriodOf, type MonthKey, type IsoDate,
  type WeekdayOrdinal,
} from "./core/dates.ts";
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
import { renderReview, renderImport, renderMapping, renderBudgetAppMapping } from "./web/pages/review.ts";
import {
  parseStatementPdf, openStatement, BANKS, bankForInstitution, SAFEGOLD_DISTRIBUTOR_BALANCE,
  WrongPassword as StatementWrongPassword,
} from "./import/pdf-statements.ts";
import {
  passwordCandidates, describeCandidate, missingDetailFor, cardDigitsNeeded,
} from "./import/statement-passwords.ts";
import { getIdentity, setIdentity, clearIdentity, maskedIdentity } from "./import/identity.ts";
import {
  parseCardNumber, keepLongerCardDigits, setCardNumberDigits, cardNumberDigits, maskedCardNumber,
} from "./domain/card-digits.ts";
import {
  recognise, saveProfile, listProfiles, markProfileUsed, deleteProfile,
  mappingFromSelections, validateMapping, columnChoices, candidateHeaderRows, looksMappable,
  rowsByPosition, delimiterName, MAPPING_DELIMITERS,
  parseWith,
} from "./import/profiles.ts";
import {
  proposeCategoryRules, proposePayeeRule, previewRetroactive, applyRetroactive, ruleSubjects,
  suppress, learningEnabled, setLearningEnabled, confirmRule, dismissRule,
} from "./import/learning.ts";
import {
  renderReconcileStart, renderReconcileDifference, renderReconcileDone,
  renderCheckpointConfirmation,
} from "./web/pages/reconcile.ts";
import {
  reconcile, reconciliationStatus, listCheckpoints, clearedBalanceAsOf,
  guardHistoricalEdit, breakCheckpoints, CheckpointConfirmationRequired,
  intactCheckpointBalances, checkpointsMovedSince, previewReconciliation, type Checkpoint,
} from "./domain/reconciliation.ts";
import { parseStatement, detectDelimiter, dateOrderOf, parseDelimited, decodeCsvBytes } from "./import/csv.ts";
import { parseBudgetApp, BUDGET_APP_NAMES, type BudgetAppParse } from "./import/budget-apps.ts";
import { importBudgetApp } from "./import/budget-app-import.ts";
import {
  ingest, listStaged, approveStaged, approveStagedAsTransfer, rejectStaged, mergeStaged, undoBatch, listBatches, batchUndoDates,
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
import { memberScope, hiddenTransactionSql, hiddenAccountSql } from "./domain/member-scope.ts";
import { exportForMember, exportTransactionsCsvForMember } from "./ops/member-export.ts";
import { aiSnapshot, SNAPSHOT_MAX_MONTHS } from "./ai/analysis.ts";
import { callItEven } from "./domain/squaring-up.ts";
import { describeDeparture, settleDeparture, type DepartureResolution } from "./domain/departure.ts";
import { convertToEmi, convertedFrom, GST_PCT } from "./domain/card-emi.ts";
import { renderDeparture } from "./web/pages/departure.ts";
import { renderHousehold } from "./web/pages/household.ts";
import {
  createAccount, updateAccount, closeAccount, reopenAccount, listAccounts, getAccount, listCards, createCard, closeCard, recordCardStatement, lastCardStatement, nextDueByDay, paymentCategoryFor, MANAGED_SUBTYPES, SUBTYPE_LABELS, type AccountKind, hiddenAccountIds, type HolderScope,
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
  getTransaction, getSplits, listPayees, payeeStats, payeeAliases, tagsFor, type Transaction, DELETED_TRANSACTION,
  resolveCategoryLines,
  outgoingLacksEnvelope,
} from "./domain/transactions.ts";
import {
  accountBalances, creditOutstanding, householdSettings,
  monthInReach,
} from "./engine/repository.ts";
import {
  suggestCoverSources, cardFunding,
  type AutoAssignPlan, type AutoAssignProposal,
} from "./engine/engine.ts";
import {
  historyFor, queryEvents, getEvent, appendEvent, checkUndo, undoEvent, DEFAULT_UNDO_WINDOW_DAYS,
  undoByIdempotencyKey, checkUndoByIdempotencyKey,
  type Actor,
} from "./core/events.ts";
import {
  withForwardRecompute, setOverspendModel, type RecomputeResult,
} from "./engine/recompute.ts";
import {
  renderHealth, overallState, type HealthGroup,
} from "./web/pages/health.ts";
import {
  createBackup, pruneBackups, verifyRestore, listBackups, lastJobRun, recordJobRun,
  pingHeartbeat,
} from "./ops/backup.ts";
import {
  renderLoanList, renderLoanDetail, renderNewLoanForm, renderRecordInstalment,
  renderPrepaymentComparison, renderLoanStatementForm, renderRateReset,
} from "./web/pages/loans.ts";
import {
  createLoan, listLoans, getLoan, projectLoan, recordInstalment, listPayments, closeLoan,
  recordDisbursement, recordLoanStatement, recordRateChange, recordPrepayment, canSeeLoan, checkAnnualRate, loanPaymentBudgetId,
  setLoanPropertyUse, gstOnInterest,
  listDisbursements, listRatePeriods, debtOverview, type LoanType,
} from "./domain/loans.ts";
import { comparePrepayment, rateResetOptions, NegativeAmortisation } from "./loans/amortisation.ts";
import {
  renderQuery, renderReports, renderSchedules, renderNewScheduleForm, renderGoals,
} from "./web/pages/analysis.ts";
import { renderOverview } from "./web/pages/overview.ts";
import {
  derivedWorth, accountRows, cardsDue, overviewData, portfolioData, taxPageModel, scheduleInScope,
} from "./web/screen-data.ts";
import {
  queryTransactions, groupTotals, periodPresets, periodFor, incomeVsExpense,
  outstandingReimbursements, capitalGainsByYear, loanInterestByFinancialYear, categoryTrend,
  spendingCalendar, spendByTag, rowsToCsv, type GroupBy, type TransactionFilter,
} from "./domain/reports.ts";
import { spendingInsights } from "./domain/insights.ts";
import {
  listSchedules, createSchedule, updateSchedule, deleteSchedule, markPaid, skipOccurrence,
  detectSchedules, projectCashflow, describeCashflow, subscriptions,
  parseRecurrence, describeRecurrence, type Recurrence,
  setScheduleSplits, getScheduleSplits, getSchedule,
} from "./domain/schedules.ts";
import {
  listGoals, createGoal, updateGoal, deleteGoal, goalCategoryIds, goalProgress, completeGoal,
  LEGACY_GOAL_GROUP, getGoal,
} from "./domain/goals.ts";
import {
  renderMore, renderPayees, renderRules, conditionValueText, renderCategories, renderFirstRun,
  renderTokens,
  type PayeeRow, type RuleRow,
} from "./web/pages/manage.ts";
import { renderPrivacy, renderTerms, type LegalMode } from "./web/pages/legal.ts";
import { Refusal } from "./core/refusal.ts";
import {
  checkPassword, checkAbsentPassword, setPassword, anyPasswordSet, hasPassword,
} from "./auth/passwords.ts";
import {
  issueSetupLink, redeemSetupLink, usableSetupLink, setupLinkBlocker, serverCommandFor,
  SetupLinkUnusable, SETUP_LINK_UNUSABLE,
} from "./auth/setup-links.ts";
import { beginOidc, exchangeOidcCode } from "./auth/oidc.ts";
import {
  staleRatesWarning, RATES_VERIFIED_ON, RATES_SOURCE, saveDeclaration, settle, addTaxPayment,
  deleteTaxPayment, type TaxPaymentKind,
} from "./domain/tax.ts";
import { renderTax, TAX_PRINT_CAVEAT } from "./web/pages/tax.ts";
import { renderCategoryLines } from "./web/pages/category-lines.ts";
import { renderDisposeAsset, renderAddToAsset } from "./web/pages/portfolio.ts";
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

/** The furthest the Schedules page projects cash: ten years of days. */
const MAX_CASHFLOW_DAYS = 3650;

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

function passwordSignInOffered(db: DB, config: Config): boolean {
  return config.localLogin || anyPasswordSet(db);
}

/** Whether somebody added to the household has a way in without a password. */
function singleSignOnConfigured(config: Config): boolean {
  return Boolean(config.google.clientId && config.google.clientSecret) || oidcConfigured(config);
}

/**
 * Whether a newly added member needs a password link to get in at all: there
 * is no Google or OIDC door for them, the password form is the way in, and
 * they have no password. The Settings button and the invite message both ask
 * this, so they cannot disagree about it.
 */
function needsPasswordLink(db: DB, config: Config, memberId: string): boolean {
  return !singleSignOnConfigured(config) && passwordSignInOffered(db, config) && !hasPassword(db, memberId);
}

const LEGAL_UPDATED = "19 September 2026";
import { loadRules } from "./import/pipeline.ts";
import {
  testRule, type Rule, type RuleSubject, extractNarrationFields, CONDITION_FIELDS, OPERATORS, LIST_OPERATORS,
} from "./import/rules.ts";
import {
  applyStartingTemplate, startBlank,
} from "./domain/starting-budget.ts";
import {
  mergePayees, getPayee, visiblePayeeIds, resolvePayee, UndoRefused, refusePaymentCategories,
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
  createPolicy, updatePolicy, markPremiumPaid, setPolicyStatus, deletePolicy, getPolicy,
  listPolicies, canSeePolicy, type PolicyInput,
} from "./domain/insurance.ts";
import { renderInsurance, renderPolicy } from "./web/pages/insurance.ts";
import {
  digestFor, mutedKinds, setMutedKinds, DIGEST_KINDS, type DigestKind,
} from "./domain/digest.ts";
import {
  renderMonthClose, renderClosedMonths, renderDigest, renderDigestSettings,
  renderStatementIdentity, renderGmailConnection, renderCardDigitAsks,
} from "./web/pages/month-close.ts";
import {
  renderPortfolio, renderHoldingDetail, renderSalePreview, renderNetWorth, renderAllocation,
  renderAddHolding, renderCasUpload, renderCasReview, renderNewAssetForm, renderRevalueAsset,
  renderManualPrice, renderSplitForm, renderMergerForm, renderValuations, type CasReviewScheme,
} from "./web/pages/portfolio.ts";
import { parseCasPdf, WrongPassword } from "./import/cas.ts";
import { parseSafeGoldText, isSafeGoldText, type SafeGoldStatement } from "./import/safegold.ts";
import {
  planSafeGoldImport, applySafeGoldPlan, stashSafeGoldPlan, peekSafeGoldPlan, takeSafeGoldPlan,
} from "./import/safegold-plan.ts";
import { renderSafeGoldUpload, renderSafeGoldReview } from "./web/pages/safegold.ts";
import {
  planCasImport, applyCasPlan, casDestinations, stashPlan, peekPlan, takePlan,
} from "./import/cas-plan.ts";
import {
  createAssetAccount, listAssetAccounts, listValuableAccounts, findOrCreateInstrument,
  setInstrumentListed, recordPurchase, recordSale, recordPrice, recordSplit, recordMerger,
  recordValuation, latestValuation, listHoldings, viewHolding, priceHistory, previewHoldingSale,
  getInstrument, findManualInstrument, listInstruments, classifyInstrument, ASSET_CLASSES,
  ASSET_CLASS_LABELS, exportHoldingsCsv, exportLotsCsv, exportPriceHistoryCsv, exportNetWorthCsv,
  type InstrumentKind, signedValuation, assetHistory, standingValuation,
} from "./domain/assets.ts";
import {
  getDepositTerms, setDepositTerms, removeDepositTerms, computedDepositValue, describeTerms,
  DEPOSIT_SUBTYPES, type DepositTermsInput,
} from "./domain/deposits.ts";
import { checkTerms, READS_REGISTER, type DepositKind } from "./deposits/accrual.ts";
import {
  netWorthStatement, snapshotNetWorth, netWorthChange, netWorthHistory,
  assetAllocation,
} from "./domain/networth.ts";
import {
  units as toUnits, price as toUnitPrice, formatUnits, parseUnitPrice, type MicroRupees,
} from "./portfolio/holdings.ts";
import { searchSchemes } from "./portfolio/providers.ts";
import { refreshPrices, MANUAL_REFRESH } from "./portfolio/refresh.ts";
import { handleMcp } from "./ai/mcp.ts";
import { buildTools, MCP_INSTRUCTIONS, writeInstructions } from "./ai/tools.ts";
import {
  isWriteTool, aiIdempotencyKey, pendingSuggestions, approveSuggestion, rejectSuggestion,
  pruneSuggestions, type AiWriteContext,
} from "./ai/writes.ts";
import { redactValue } from "./ai/redact.ts";
import { recordAiAccess, listAiAccess } from "./ai/access-log.ts";
import { renderConnectAi, renderAiUndoConfirm } from "./web/pages/ai.ts";
import {
  verifyInbound, verifyInboundCheck, signatureLooksFresh, SIGNATURE_HEADER, RECIPIENT_HEADER,
} from "./mail/signature.ts";
import type { TxtResolver } from "./mail/dkim.ts";
import {
  addressRow, formatAddress, issueAddress, memberForToken, removeAddress, tokenFromRecipient,
} from "./forwarding/address.ts";
import { receiveForwarded } from "./forwarding/inbound.ts";
import {
  listHeld, deleteHeld, retryHeld, listForwardedMail, pendingConfirmation,
} from "./forwarding/held.ts";
import { renderForwarding } from "./web/pages/forwarding.ts";
import { bankSenders } from "./gmail/fetch.ts";

export interface AppDeps {
  db: DB;
  config: Config;
  /** Injected so tests can drive the OAuth exchange without a network call. */
  fetchImpl?: typeof fetch;
  /** FWD · DNS TXT lookups for DKIM keys; injected so tests need no network. */
  resolveTxt?: TxtResolver;
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
/*
 * OAUTH · The authorization server's machine-facing doors (src/auth/oauth.ts).
 * An AI provider's servers fetch and post to these, from their own origin or
 * none, with no session and no cookie — so, exactly these and nothing broader,
 * they are public, read only a small body, and are exempt from the
 * same-origin write rule below. Each takes a code, a refresh token or a
 * registration and nothing a browser's cookie could lend it. The consent
 * page, /oauth/authorize, is NOT here: it is a signed-in browser page, and
 * its POST is held to every rule a form post is.
 */
const OAUTH_DOORS = new Set([
  "/.well-known/oauth-protected-resource",
  "/.well-known/oauth-protected-resource/mcp",
  "/.well-known/oauth-authorization-server",
  "/oauth/register", "/oauth/token", "/oauth/revoke",
]);
/** OAUTH · The MCP endpoint, matched segment by segment like the router. */
function isMcpPath(path: string): boolean {
  const parts = path.split("/").filter((s) => s.length > 0);
  return parts.length === 1 && parts[0] === "mcp";
}
const STATIC_PREFIX = "/assets/";
/*
 * A password link (src/auth/setup-links.ts) is a door too, and the one public
 * path with a parameter in it — so it cannot sit in the set above, which is
 * matched exactly. One segment after /auth/setup/ and nothing else.
 */
const SETUP_LINK_PATH = /^\/auth\/setup\/[^/]+$/;
/** FWD · The receiver's hand-off, answered before any session or form rule. */
const INBOUND_PATH = "/inbound/email";
/** MAIL-9 · The receiver's question at RCPT time: is this address in use? */
const INBOUND_CHECK_PATH = "/inbound/check";
/** A forwarded message's cap: the receiver's 25 MiB, and a little framing. */
const INBOUND_BODY_BYTES = 26 * 1024 * 1024;
/** MAIL-7 · Hand-offs read at once; more wait at the receiver, which retries. */
export const INBOUND_CONCURRENCY = 4;

/** The largest body a public route (a sign-in door) will read. */
const PUBLIC_BODY_BYTES = 64 * 1024;

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

export function buildApp(deps: AppDeps): {
  router: Router; middleware: ((ctx: RequestContext) => Response | void | Promise<Response | void>)[];
} {
  const { db, config } = deps;
  const router = new Router();
  // AI-7 · Off on a hosted Solo instance (FEATURE_AI=false); on everywhere else.
  const aiEnabled = config.features.ai;
  /** AIW · Whether any AI connection may change anything here (AI_WRITE). */
  const aiWriteOn = aiEnabled && config.aiWrite !== "off";
  /** MAIL-7 · Hand-offs to /inbound/email being read or processed right now. */
  let inboundInFlight = 0;

  // -------------------------------------------------------------------------
  // Middleware
  // -------------------------------------------------------------------------
  const middleware = [
    function staticAssets(ctx: RequestContext): Response | void {
      const path = ctx.url.pathname;
      /*
       * D6 · Every page names these by a hash of their content (layout.ts), so
       * a request carrying the current hash is for exactly this content and
       * may be cached for good: the next deploy that changes it changes the
       * URL. Without the hash, or with an old one, it keeps the short cache —
       * the content served is not the content that URL named.
       */
      if (path === "/assets/app.css") {
        return asset(STYLESHEET, "text/css", ctx.url.searchParams.get("v") === ASSET_VERSION.css);
      }
      if (path === "/assets/app.js") {
        return asset(CLIENT_SCRIPT, "text/javascript", ctx.url.searchParams.get("v") === ASSET_VERSION.js);
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
     * PLAN-1 · A module this deployment does not offer answers 404 before any
     * handler runs, so a route added to a module later is gated by where it
     * lives rather than by remembering a guard. 404 and not 403: F28.2 makes a
     * disabled module disappear, and "not on your plan" for a page that does
     * not exist on this instance would be a promise of something to unlock.
     */
    function featureGate(ctx: RequestContext): Response | void {
      if (!pathAvailable(ctx.url.pathname, config.features)) throw new NotFound();
    },

    /*
     * FWD-2 · The mail receiver's hand-off of one forwarded message.
     *
     * Answered here, ahead of sessions and the same-origin write rule, because
     * the caller is a server holding neither a cookie nor an Origin: what it
     * holds is INBOUND_SECRET, and the signature over the recipient and the
     * exact bytes is checked before anything else looks at them. The body is
     * read here too, as bytes: the form reader would decode it as UTF-8, and a
     * bank's 8-bit body would then no longer match its DKIM signature.
     *
     * The status is the receiver's answer to the sending server: 202 taken,
     * 404 no such address (refused), 401 a bad signature, 503 not set up or
     * busy (the receiver answers 451 and the sender retries).
     *
     * MAIL-7 · Nothing is read from a caller who cannot be the receiver: a
     * signature header that is missing, malformed or outside the five-minute
     * window is refused from the headers alone, and at most
     * INBOUND_CONCURRENCY hand-offs are read at once.
     *
     * MAIL-9 · POST /inbound/check is the receiver's question at RCPT time,
     * signed the same way over the recipient alone: 200 {"known": …}. Unsigned
     * askers get 401, so which addresses exist is told only to the receiver.
     */
    async function inboundMail(ctx: RequestContext): Promise<Response | void> {
      const path = ctx.url.pathname;
      if (path !== INBOUND_PATH && path !== INBOUND_CHECK_PATH) return;
      if (ctx.method.toUpperCase() !== "POST") {
        return { status: 405, headers: { Allow: "POST" }, body: "" };
      }
      const { secret } = config.inbound;
      if (!secret || !config.inbound.domain) {
        return { status: 503, headers: { Connection: "close" }, json: { error: "Forwarding is not set up on this server." } };
      }
      const signature = ctx.req.headers[SIGNATURE_HEADER] as string | undefined;
      const recipient = String(ctx.req.headers[RECIPIENT_HEADER] ?? "").toLowerCase();
      if (!signatureLooksFresh(signature)) {
        return { status: 401, headers: { Connection: "close" }, json: { error: "That hand-off was not signed with this server's INBOUND_SECRET." } };
      }
      if (path === INBOUND_CHECK_PATH) {
        if (!verifyInboundCheck(secret, signature, recipient)) {
          return { status: 401, headers: { Connection: "close" }, json: { error: "That question was not signed with this server's INBOUND_SECRET." } };
        }
        const token = tokenFromRecipient(config.inbound, recipient);
        return { status: 200, json: { known: token !== null && memberForToken(db, token) !== null } };
      }
      const declared = Number(ctx.req.headers["content-length"] ?? NaN);
      if (Number.isFinite(declared) && declared > INBOUND_BODY_BYTES) {
        return { status: 413, headers: { Connection: "close" }, json: { error: "That message is too large." } };
      }
      if (inboundInFlight >= INBOUND_CONCURRENCY) {
        return {
          status: 503, headers: { "Retry-After": "60", Connection: "close" },
          json: { error: "Too many messages are being handed over at once; try again shortly." },
        };
      }
      inboundInFlight += 1;
      try {
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of ctx.req) {
          size += (chunk as Buffer).length;
          if (size > INBOUND_BODY_BYTES) return { status: 413, headers: { Connection: "close" }, json: { error: "That message is too large." } };
          chunks.push(chunk as Buffer);
        }
        const raw = new Uint8Array(Buffer.concat(chunks));
        if (!verifyInbound(secret, signature, recipient, raw)) {
          return { status: 401, json: { error: "That hand-off was not signed with this server's INBOUND_SECRET." } };
        }
        const token = tokenFromRecipient(config.inbound, recipient);
        if (!token) return { status: 404, json: { error: "No such address." } };
        const outcome = await receiveForwarded(db, {
          secretsKey: config.secretsKey, resolveTxt: deps.resolveTxt,
        }, token, raw);
        if (outcome.status === "unknown-address") return { status: 404, json: { error: "No such address." } };
        // MAIL-4 · The receiver answers the sender 451, and the sender retries.
        if (outcome.status === "try-later") {
          return { status: 503, headers: { "Retry-After": "300" }, json: { error: "The bank's signing key could not be looked up just now." } };
        }
        return { status: 202, json: { outcome: outcome.outcome } };
      } finally {
        inboundInFlight -= 1;
      }
    },

    /*
     * OAUTH · Before the write rule, because both of these are answered for
     * callers that rule would refuse.
     *
     * The doors are called by browser-based MCP clients too (an inspector, a
     * web app), which need CORS to read the answer. A wildcard is safe here
     * and only here: none of these reads a cookie, so a page that calls one
     * learns nothing it could not have asked for itself.
     *
     * /mcp without a usable bearer token is 401 with the WWW-Authenticate
     * header that starts an AI app's sign-in (Claude starts it on a 401 and
     * nothing else). Without this, the first call — a POST from a server,
     * with no Origin — met the write rule and was a bare 403, and the app
     * never learned where to sign in. The route itself is the MCP server's.
     */
    function oauthDoors(ctx: RequestContext): Response | void {
      const path = ctx.url.pathname;
      /*
       * AI-7 · With AI connections switched off, every way in for an AI app is
       * simply not there: the endpoint, its sign-in, and the page that sets it
       * up (F28.2 — a disabled module disappears). Checked here, first, so the
       * 401 that would start an app's sign-in is never offered.
       */
      if (!aiEnabled && (isMcpPath(path) || OAUTH_DOORS.has(path) || path === "/oauth/authorize"
          || path.replace(/\/+$/, "") === "/tokens/ai")) {
        throw new NotFound();
      }
      if (OAUTH_DOORS.has(path)) {
        ctx.res.setHeader("Access-Control-Allow-Origin", "*");
        if (ctx.method.toUpperCase() === "OPTIONS") {
          return {
            status: 204,
            headers: {
              "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
              "Access-Control-Allow-Headers": "Content-Type, Authorization, MCP-Protocol-Version",
              "Access-Control-Max-Age": "86400",
            },
          };
        }
        return;
      }
      if (isMcpPath(path) && ctx.method.toUpperCase() !== "OPTIONS") {
        const header = ctx.req.headers.authorization;
        const bearer = authenticateToken(db, header);
        if (!bearer) {
          return oauth.mcpUnauthorized(config.baseUrl, { invalidToken: /^Bearer\s/i.test(String(header ?? "")) });
        }
        // Read once: authenticating records last-used, and twice is noise.
        ctx.locals.bearer = bearer;
        // AI-5 · Broken JSON is handleMcp's to answer, as a JSON-RPC parse error.
        ctx.locals.routeParsesJson = true;
      }
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
     *
     * That premise is now checked rather than assumed (SECURITY-OPS-2). The
     * exemption keyed on the header alone, while authentication below lets a
     * valid session cookie win over a bearer that does not authenticate — so
     * "Authorization: Bearer nonsense" plus a victim's cookie was a
     * cookie-authenticated write with no Origin check at all. A request that
     * carries a session cookie is held to the rule whatever else it carries.
     */
    function sameOriginWrites(ctx: RequestContext): Response | void {
      const method = ctx.method.toUpperCase();
      if (method === "GET" || method === "HEAD" || method === "OPTIONS") return;
      // OAUTH · Posted to by an AI provider's servers; see OAUTH_DOORS.
      if (OAUTH_DOORS.has(ctx.url.pathname)) return;
      /*
       * And never on a public door. A token cannot reach any of them, so a
       * bearer there authenticates nothing — while a DNS-rebound page, being
       * same-origin to itself, may set the header without a preflight, and
       * "Bearer anything" took it past the Host check below into
       * /auth/first-run.
       */
      const publicDoor = PUBLIC_PATHS.has(ctx.url.pathname) || SETUP_LINK_PATH.test(ctx.url.pathname);
      if (
        !publicDoor
        && /^Bearer\s/i.test(String(ctx.req.headers.authorization ?? ""))
        && parseCookies(ctx.req.headers.cookie)[SESSION_COOKIE] === undefined
      ) return;

      /*
       * SECURITY-D3 · DNS rebinding. The Host is the attacker's to choose: a
       * page on evil.example re-points its own name at this machine and posts
       * to it, and then its Origin and the Host agree — so trusting the Host
       * as "here" let a rebound page create the first member through
       * /auth/first-run on a fresh LAN install. The Host must first be one
       * this app answers to: BASE_URL's, or a name no DNS answer is involved
       * in (an IP literal, localhost), which is therefore not reboundable.
       */
      if (!addressedHere(ctx)) {
        throw new HttpError(403, "That request was addressed to a different host than BASE_URL.");
      }

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
      /*
       * AI-2 · /mcp is answered only as the token: the tools act for whoever
       * the AI connection was made by. A browser cookie riding along (the
       * member's own tab, a page that fetched with credentials) must not turn
       * a connection into its holder's full session.
       */
      let auth = isMcpPath(path) ? null : authenticate(db, cookies[SESSION_COOKIE] ?? null);

      // F30 · A bearer token authenticates as its member, but is a narrower
      // thing than a session: it cannot reach the routes in F30.6's list, it
      // is rate-limited separately (F30.7), and a read-only one cannot write.
      // The OAuth doors take codes and refresh tokens, never a bearer; one sent
      // along is ignored rather than judged against the deny-list.
      const bearer = OAUTH_DOORS.has(path) ? null
        : (ctx.locals.bearer as ReturnType<typeof authenticateToken> | undefined)
          ?? authenticateToken(db, ctx.req.headers.authorization);
      // PLAN-1 · With API tokens off, a token minted before stops working
      // rather than outliving the module that issued it; it is kept, so turning
      // the module back on brings it back. The MCP endpoint is the exception:
      // an AI app's connection is a token too, and FEATURE_AI governs it.
      if (bearer && !auth && !config.features.apiTokens && !isMcpPath(path)) {
        return { status: 403, json: { error: "API tokens are not available on this instance." } };
      }
      // AI-4 · And an AI connection's token is FEATURE_AI's, on every route:
      // with that module off, /mcp was gone but the same token still read
      // /export.json and the rest wherever API tokens stayed on. Kept, like a
      // token above, so it works again once the module is back.
      if (bearer && !auth && !aiEnabled && isAiToken(bearer.token)) {
        return { status: 403, json: { error: "AI connections are not available on this instance." } };
      }
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

        // AI-2 · Except /mcp: MCP is JSON-RPC over POST, and every tool behind
        // it is a read. A read-only token is exactly what an AI connection is.
        if (ctx.method !== "GET" && bearer.scope === "read" && !isMcpPath(path)) {
          return { status: 403, json: { error: "That token is read-only." } };
        }
        /*
         * AIW · An AI's token, even one allowed to make changes, makes them
         * only through /mcp: there every change is one of a short list of
         * tools, logged and capped. The REST routes would hand it deletes,
         * loans, settings and the rest of what docs/ai.md says it never gets.
         */
        if (ctx.method !== "GET" && isAiToken(bearer.token) && !isMcpPath(path)) {
          return {
            status: 403,
            json: { error: "An AI connection's token changes things only through /mcp, and only with its tools." },
          };
        }

        const member = getMember(db, bearer.token.member_id);
        // The allow-list is authority for a token as it is for a session
        // (R38.16): removing a member revokes their sessions, and a token
        // they minted must not outlive them either.
        if (member && !member.removed_at && member.allowed) {
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

      if (PUBLIC_PATHS.has(path) || SETUP_LINK_PATH.test(path) || OAUTH_DOORS.has(path)) {
        // Every door is a short form — an email and a password at most. The
        // 12 MB an attachment needs is not offered to somebody not yet in.
        ctx.locals.bodyLimit = PUBLIC_BODY_BYTES;
        return;
      }
      if (!auth) {
        // OAUTH · A token that authenticated for a member no longer allowed in.
        if (isMcpPath(path)) return oauth.mcpUnauthorized(config.baseUrl, { invalidToken: true });
        if (wantsJson(ctx)) return { status: 401, json: { error: "Your session has expired." } };
        // OAUTH · The consent page is nothing without its query — which app,
        // sent where — so it comes back with it. Sign-in passes `next` through
        // safePath, which keeps it on this site.
        if (path === "/oauth/authorize" && ctx.method === "GET") {
          return { redirect: `/signin?next=${encodeURIComponent(path + ctx.url.search)}` };
        }
        return { redirect: `/signin?next=${encodeURIComponent(path)}` };
      }

      // R38.10: impersonation is read-only unless the toggle was set. The
      // check lives here so no handler can be the one that forgets it.
      // B51: `/impersonate/writes` must pass even in read-only mode — it *is*
      // the toggle. Blocking it (as this did) made read-only impersonation a
      // one-way door, contradicting the error's own "Enable writes first".
      // Signing out is the same kind of door: refusing it left a read-only
      // viewer unable to end their own session on a shared device.
      const IMPERSONATION_CONTROLS = new Set(["/impersonate/exit", "/impersonate/writes", "/signout"]);
      if (ctx.method !== "GET" && !auth.canWrite && !IMPERSONATION_CONTROLS.has(path) && !(isMcpPath(path) && ctx.locals.token)) {
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

  function render(ctx: RequestContext, title: string, content: ReturnType<typeof html>, opts: { bare?: boolean; notice?: Parameters<typeof page>[0]["notice"]; print?: Parameters<typeof page>[0]["print"] } = {}): Response {
    const a = ctx.locals.auth as AuthContext | null;
    return {
      body: page(
        {
          title,
          // PRINT-1 · The printable screens say so; the footer names the household.
          print: opts.print ?? null,
          householdName: a ? householdSettings(db)?.name ?? null : null,
          theme: (a?.viewingAs.theme ?? "system") as Theme,
          memberName: a?.member.name ?? null,
          // OFFLINE-1 · Not while viewing as somebody else: an entry kept then
          // would be replayed later under whichever person the session is.
          memberId: a && !a.impersonating ? a.member.id : null,
          impersonating: a?.impersonating
            ? { name: a.viewingAs.name, readOnly: !a.canWrite }
            : null,
          devMode: config.devLogin,
          demoMode: config.demoMode,
          path: ctx.url.pathname,
          reviewCount: a ? reviewCount(db, viewer(ctx), { ai: aiEnabled }) : 0,
          notice: opts.notice ?? noticeFrom(ctx),
          bare: opts.bare,
          features: {
            ...config.features,
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

  /*
   * SECURITY-D4 · Only the server writes in the notice banner.
   *
   * A success message rides the redirect as `?notice=<text>`, and was shown
   * on whatever page the link opened — so any link to this household's own
   * instance could put its words ("your account is locked, call ...") in the
   * app's own banner. Escaped, so never a script, but phishing with the app's
   * authority. Every notice the server issues now carries an HMAC of its text
   * (`ns`), keyed by a secret that never leaves this process, and a notice
   * without a matching one is not shown. The key is per process: a restart
   * between a redirect and its page drops that one notice, and nothing else.
   * `kind` was never set by any redirect, so it is no longer read at all.
   */
  const noticeKey = randomBytes(32);
  function noticeSignature(message: string): string {
    return createHmac("sha256", noticeKey).update(message).digest("base64url").slice(0, 22);
  }

  function noticeFrom(ctx: RequestContext): Parameters<typeof page>[0]["notice"] {
    const message = ctx.query.get("notice");
    if (!message) return null;
    const given = Buffer.from(ctx.query.get("ns") ?? "");
    const expected = Buffer.from(noticeSignature(message));
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
    return { kind: "success", message };
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

  /**
   * D4 / D14 · The budget a form was showing when it was submitted, posted with
   * it — so "Hold it" and "Assign" act on the budget whose figures were on the
   * screen, not whichever one was opened last in another tab. Checked like
   * budgetParam; falls back to it.
   */
  function postedBudget(ctx: RequestContext): string {
    const posted = field(ctx.body, "budget");
    if (posted && budgetsFor(db, viewer(ctx)).some((b) => b.id === posted)) return posted;
    return budgetParam(ctx);
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
    // And a split line's envelope, which the two checks above never look at.
    if (memberScope(db, viewer(ctx)).transactions.has(transaction.id)) {
      throw new NotFound("That transaction does not exist.");
    }
    return transaction;
  }

  /**
   * EXTRA-3 · A transaction a change can be made to: visible, and not deleted.
   * The edit, file, settle, attach and convert routes all took a deleted one
   * and answered 303 over a write to a row that counts for nothing. Viewing
   * one stays open — Activity links to it.
   */
  function requireLiveTransaction(ctx: RequestContext, id: string): Transaction {
    const transaction = requireVisibleTransaction(ctx, id);
    if (transaction.deleted_at) throw new HttpError(422, DELETED_TRANSACTION);
    return transaction;
  }

  /**
   * 15 · A statement line waiting in the queue, by the account it came from.
   * Approving, dismissing or merging one took any id it was given.
   */
  function requireVisibleStaged(ctx: RequestContext, id: string): string {
    const row = queryOne<{ account_id: string }>(
      db, `SELECT account_id FROM staged_transactions WHERE id = ?`, id,
    );
    if (!row) throw new NotFound("That review item does not exist.");
    try {
      requireVisibleAccount(ctx, row.account_id);
    } catch (e) {
      if (e instanceof NotFound) throw new NotFound("That review item does not exist.");
      throw e;
    }
    return id;
  }

  /**
   * 15 · An import, by the account it was read into. The history hid another
   * member's private-account batches, but `/import/undo` took any batch id, so
   * Ravi could post Priya's and remove every transaction her statement had
   * created — the queue writes beside it were guarded, the undo was not. A
   * batch with no account (a Gmail fetch that matched nothing) is nobody's.
   */
  function requireVisibleBatch(ctx: RequestContext, id: string): string {
    const row = queryOne<{ account_id: string | null }>(
      db, `SELECT account_id FROM import_batches WHERE id = ?`, id,
    );
    if (!row || memberScope(db, viewer(ctx)).hides(row.account_id)) {
      throw new NotFound("That import does not exist.");
    }
    return id;
  }

  function requireVisibleAttachment(ctx: RequestContext, id: string): string {
    const meta = attachmentMeta(db, id);
    if (!meta) throw new NotFound("That attachment does not exist.");
    requireVisibleTransaction(ctx, meta.transaction_id);
    return id;
  }

  /**
   * 15 · An event is as private as what it is about.
   *
   * The activity log hid Ravi's events from Priya, but the undo button's route
   * took any event id it was given: posting `/activity/<id>/undo` for the event
   * that added his ₹60,000 private-card purchase deleted the transaction
   * outright. Undo is the most destructive write in the app — it removes rows —
   * so it answers exactly as it would for an id that never existed.
   */
  function requireVisibleEvent(ctx: RequestContext, id: string): string {
    const event = getEvent(db, id);
    if (!event || !eventVisibility(db, viewer(ctx))(event)) {
      throw new NotFound("That change does not exist.");
    }
    return id;
  }

  /**
   * 15 · The same rule for everything else a URL can name.
   *
   * As Priya, `/schedules/<Ravi's>/edit` renamed his private subscription,
   * `/paid` posted ₹777 into his private account, `/goals/<his>/delete`
   * removed his goal and `/portfolio/<his holding>/split` doubled the 100
   * units in his private demat to 200 — each id-addressed route that had never
   * been given a guard. What each thing hangs off is member-scope's to say, so
   * these ask it rather than repeat the joins; a thing that does not exist and
   * a thing that is not yours answer the same 404.
   */
  type Scoped = "schedules" | "goals" | "holdings" | "instruments" | "cards";
  const SCOPED_TABLE: Record<Scoped, [table: string, noun: string]> = {
    schedules: ["schedules", "schedule"], goals: ["goals", "goal"],
    holdings: ["holdings", "holding"], instruments: ["instruments", "instrument"],
    cards: ["cards", "card"],
  };
  function requireVisibleIn(ctx: RequestContext, kind: Scoped, id: string): string {
    const [table, noun] = SCOPED_TABLE[kind];
    const row = queryOne(db, `SELECT 1 AS n FROM ${table} WHERE id = ?`, id);
    if (!row || memberScope(db, viewer(ctx))[kind].has(id)) {
      throw new NotFound(`That ${noun} does not exist.`);
    }
    return id;
  }
  const requireVisibleSchedule = (ctx: RequestContext, id: string) => requireVisibleIn(ctx, "schedules", id);
  const requireVisibleGoal = (ctx: RequestContext, id: string) => requireVisibleIn(ctx, "goals", id);
  const requireVisibleHolding = (ctx: RequestContext, id: string) => requireVisibleIn(ctx, "holdings", id);
  const requireVisibleInstrument = (ctx: RequestContext, id: string) => requireVisibleIn(ctx, "instruments", id);

  /**
   * A rule about an envelope you cannot see, and an import profile for an
   * account you cannot see, are as private as the envelope and the account —
   * the Rules and Import screens already hid them. Their delete routes took any
   * id and logged "Removed a rule" whether or not there was one.
   */
  function requireVisibleRule(ctx: RequestContext, id: string): string {
    const rule = queryOne<{ actions_json: string }>(db, `SELECT actions_json FROM rules WHERE id = ?`, id);
    if (!rule || memberScope(db, viewer(ctx)).mentionsHidden(JSON.parse(rule.actions_json))) {
      throw new NotFound("That rule does not exist.");
    }
    return id;
  }
  /**
   * IMPORTS-SCHEDULES-33 · The saved mappings /import lists. A mapping is named
   * after its account ("<account> columns"), so listing them all named
   * another member's private account on Ravi's import page — with a Remove
   * button that then answered 404. The same rule as the guard below.
   */
  function visibleProfiles(ctx: RequestContext) {
    const scope = memberScope(db, viewer(ctx));
    return listProfiles(db).filter((p) => !scope.hides(p.account_id));
  }

  function requireVisibleImportProfile(ctx: RequestContext, id: string): string {
    const profile = queryOne<{ account_id: string | null }>(
      db, `SELECT account_id FROM import_profiles WHERE id = ?`, id,
    );
    if (!profile || memberScope(db, viewer(ctx)).hides(profile.account_id)) {
      throw new NotFound("That profile does not exist.");
    }
    return id;
  }

  /**
   * An account named in a form, which is a suggestion like any other field.
   * `/add`, `/schedules/new` and `/portfolio/add` wrote into Ravi's private
   * accounts when Priya posted their ids, and answered 422 "That account does
   * not exist" for an id that really did not — so the two different answers
   * told her which ids were real. Both are now the same 404.
   */
  function visibleAccountField(ctx: RequestContext, name: string): string | null {
    const id = field(ctx.body, name);
    return id ? requireVisibleAccount(ctx, id).id : null;
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
   * An id posted in a form field, checked by one of the guards above: absent
   * is null, present is either the id or that guard's 404.
   *
   * visibleAccountField did this for accounts only, and every other id in a
   * form body went straight to the domain. An audit found the same two
   * outcomes route after route: another member's private budget, group, payee
   * or rule was written to (a 303 that confirmed it was real), and a made-up
   * one reached the database, failed its foreign key, and answered 500 —
   * recorded as a fault, and distinguishable from the real ones. One helper so
   * the next form field has the obvious thing to reach for.
   */
  function guardedField(
    ctx: RequestContext, name: string,
    guard: (ctx: RequestContext, id: string) => string | null,
  ): string | null {
    const id = field(ctx.body, name);
    return id ? guard(ctx, id) : null;
  }

  /**
   * UI-8 · The holder a new policy, asset or loan is stored with. In a
   * one-member household the forms offer no "Whose is it", so the holder came
   * through empty; UI-3 reads an empty holder as the sole member's, but only
   * while they are alone. When a second member joined, everything recorded
   * alone became the household's, jointly, and stopped counting as the first
   * member's (their 80C/80D policies left the tax page). So with one member,
   * an unnamed holder is stored as that member. With two or more, empty
   * still means the household's.
   */
  function holderOrSoleMember(holder: string | null | undefined): string | null {
    if (holder) return holder;
    const members = queryAll<{ id: string }>(db, `SELECT id FROM members WHERE removed_at IS NULL`);
    return members.length === 1 ? members[0]!.id : null;
  }

  /**
   * FRESH-WEB-2 / WEB-1 · An edit may leave a record private only to whoever is
   * making the edit, and only if it was theirs or nobody's to begin with. A
   * create passes `before` as null, so the same rule holds there (WEB-4).
   * Otherwise one member could take another's account, loan or policy private
   * to themselves (or hand it, private, to a third) and it would vanish from
   * the screens of the person it belongs to, Activity included.
   */
  function refuseForeignPrivate(
    a: AuthContext, before: string | null, next: string | null, visibility: string | null | undefined,
    noun: string,
  ): void {
    if (visibility !== "private" || !next) return;
    if (next === a.member.id && (before === null || before === a.member.id)) return;
    throw new Refusal(
      `Only you can be the one a private ${noun} is private to. Leave it shared, ` +
      "or let whoever's name is on it make it private themselves.",
    );
  }

  /** A budget this member may file into: the household's, or their own. */
  function requireVisibleBudget(ctx: RequestContext, id: string): string {
    if (!budgetsFor(db, viewer(ctx)).some((b) => b.id === id)) {
      throw new NotFound("That budget does not exist.");
    }
    return id;
  }

  /**
   * A member named in a form — a holder, or who spent it. Members are no
   * secret inside the household, so this is only about existence: a made-up
   * id reached the database and failed its foreign key, a 500 recorded as a
   * fault on every form that names one (SECURITY-OPS-10, WEBUX-11). A member
   * since removed still counts, so an edit form that re-posts an old holder
   * keeps working.
   */
  function requireMember(_ctx: RequestContext, id: string): string {
    if (!getMember(db, id)) throw new NotFound("That member does not exist.");
    return id;
  }

  /**
   * A payee is visible by the rule listPayees applies — seen somewhere this
   * member can see, or nowhere yet — plus one merged into a visible payee.
   * A payee seen only on another member's private account is where they spend;
   * merging into it announced its name, and merging it away re-pointed their
   * private transactions (SECURITY-OPS-7).
   */
  function requireVisiblePayee(ctx: RequestContext, id: string): string {
    if (!visiblePayeeIds(db, viewer(ctx)).has(id)) throw new NotFound("That payee does not exist.");
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
  /**
   * The host this request was addressed by: X-Forwarded-Host behind a trusted
   * proxy — its right-most entry, the one that proxy wrote, as for
   * X-Forwarded-For — and the Host header otherwise.
   */
  function requestHost(ctx: RequestContext): string {
    const forwarded = config.trustProxy ? ctx.req.headers["x-forwarded-host"] : undefined;
    if (forwarded !== undefined) {
      return String(forwarded).split(",").pop()!.trim();
    }
    return String(ctx.req.headers.host ?? "");
  }

  /**
   * Whether the request's host is one this app answers to (SECURITY-D3):
   * BASE_URL's hostname with its port (or none), or a name that involves no
   * DNS answer — an IPv4 or IPv6 literal, or localhost — since only a DNS
   * name can be rebound to this machine by somebody else's page. A request
   * with no Host at all is not from a browser and is left to the Origin check.
   */
  function addressedHere(ctx: RequestContext): boolean {
    const host = requestHost(ctx);
    if (host === "") return true;
    // host[:port] and nothing else — no path, credentials or whitespace to
    // make the URL parser below read a different host than the header says.
    if (/[\/\\@?#\s]/.test(host)) return false;
    let addressed: URL;
    let base: URL;
    try {
      addressed = new URL(`http://${host}`);
      base = new URL(config.baseUrl);
    } catch {
      return false;
    }
    const name = addressed.hostname;
    if (name === "localhost" || name.startsWith("[") || /^\d{1,3}(\.\d{1,3}){3}$/.test(name)) return true;
    return name === base.hostname && (addressed.port === "" || addressed.port === base.port);
  }

  /** The origin this request was addressed by, from its own Host header. */
  function hostOrigin(ctx: RequestContext): string {
    const host = requestHost(ctx);
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
    /**
     * False only for work SQLite cannot do inside a transaction — a backup's
     * `VACUUM INTO`. Everything else runs as one unit (DEBUG-WEB-6).
     */
    opts: { atomic?: boolean } = {},
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
        // DEBUG-WEB-6 · One request, one transaction: a refusal on a later
        // write takes the earlier ones back with it.
        () => ({ statusCode: 200, body: opts.atomic === false ? fn(a) : transact(db, () => fn(a)) }),
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

  /**
   * MONEY-CORE-14 · R36 for a route that cannot go through `mutate` — one that
   * asks a question first (the "Already reconciled" guard, a preview) or
   * renders a page rather than redirecting. `fn` does the writing and returns
   * a JSON-safe description of the answer; a retry with the same key gets that
   * description back instead of doing the work again. Reconcile repeated made a
   * second checkpoint and a second Activity entry, and a repeated delete
   * logged a second "Deleted ₹50" and re-stamped deleted_at.
   */
  function once<T>(ctx: RequestContext, a: AuthContext, fn: () => T): T {
    try {
      return withIdempotency(
        db,
        {
          key: (ctx.req.headers["idempotency-key"] as string | undefined) ?? null,
          memberId: a.member.id,
          method: ctx.method,
          path: ctx.url.pathname,
          payload: ctx.body,
        },
        () => ({ statusCode: 200, body: transact(db, fn) }),
      ).body;
    } catch (err) {
      if (err instanceof IdempotencyConflict) throw new HttpError(err.statusCode, err.message);
      throw err;
    }
  }

  function withNotice(path: string, message?: string): string {
    if (!message) return path;
    // The query goes before any #fragment: after it, the browser never sends it.
    const hashAt = path.indexOf("#");
    const base = hashAt < 0 ? path : path.slice(0, hashAt);
    const fragment = hashAt < 0 ? "" : path.slice(hashAt);
    const separator = base.includes("?") ? "&" : "?";
    return `${base}${separator}notice=${encodeURIComponent(message)}&ns=${noticeSignature(message)}${fragment}`;
  }

  function monthParam(ctx: RequestContext): MonthKey {
    const value = ctx.query.get("month") ?? field(ctx.body, "month");
    const month = value && isMonthKey(value) ? value : monthOf(todayIST());
    /*
     * BUDGET-13 · A month the engine's walk does not reach was shown with the
     * last month it did reach, under the requested heading: /?month=2150-06
     * read "June 2150" over December 2099's figures. Said instead.
     */
    if (!monthInReach(db, month)) {
      throw new Refusal(
        `${formatMonth(month)} is too far from the rest of this budget for it to reach — ` +
        `a budget spans at most a hundred years.`,
      );
    }
    return month;
  }

  /** Amount fields accept an expression (F4.10) before falling back to a plain parse. */
  /**
   * UI-PASS-8 · The card or account number's last four, as printed beside the
   * name everywhere ("····6604"). The form says maxlength=4, but the server
   * took "abcdefgh" and showed it as the number. Spaces and dashes are let go;
   * anything else is refused. Undefined when the field was not sent.
   */
  function last4Field(raw: string | undefined): string | null | undefined {
    if (raw === undefined) return undefined;
    const digits = raw.replace(/[\s-]/g, "");
    if (digits === "") return null;
    if (!/^\d{4}$/.test(digits)) {
      throw new Refusal(`"${raw.trim()}" is not the last four digits — enter four numbers, like 6604, or leave it empty.`);
    }
    return digits;
  }

  function amountField(raw: string | undefined, name = "Amount"): number {
    if (raw === undefined || raw.trim() === "") {
      throw new HttpError(400, `${name} is required.`);
    }
    const value = evaluateAmountExpression(raw) ?? parseAmount(raw);
    if (value === null) throw new HttpError(400, `"${raw}" isn't an amount I can read.`);
    return value;
  }

  /**
   * WEALTH-39 · A per-unit price the user typed, kept to the micro-rupee a NAV
   * needs (amountField stops at the paisa). `Number("abc")` went straight into
   * the prices table as NULL and answered 500; now it is a sentence. WEBUX-15:
   * "1,250.50" and "₹1,250" are read the way every amount field reads them.
   */
  function unitPriceField(raw: string | undefined, name = "Price"): MicroRupees {
    if (raw === undefined || raw.trim() === "") throw new HttpError(400, `${name} is required.`);
    const value = parseUnitPrice(raw);
    if (value === null) throw new Refusal(`"${raw}" isn't a price I can read.`);
    if (value <= 0) throw new Refusal(`${name} has to be above zero.`);
    return toUnitPrice(value);
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

  /**
   * DEPOSITS · A deposit's terms as the form sends them, or null when the form
   * names no kind (the new-account form, where terms are optional). The rate
   * is a percentage to two places — "7.1" is 710 basis points — and anything
   * else is a sentence, not a guess. The domain checks the rest.
   */
  function depositTermsField(body: Record<string, string | string[]>): DepositTermsInput | null {
    // PLAN-1 · Without the module, terms sent anyway are not taken.
    if (!config.features.deposits) return null;
    const kind = field(body, "deposit_kind")?.trim();
    if (!kind) return null;
    const rateRaw = (field(body, "deposit_rate") ?? "").trim().replace(/%$/, "").trim();
    if (!/^\d{1,3}(\.\d{1,2})?$/.test(rateRaw)) {
      throw new Refusal("The rate is a yearly percentage to two decimal places, like 7.1 or 7.25.");
    }
    const optionalAmount = (name: string, label: string) => {
      const raw = field(body, name);
      return raw?.trim() ? amountField(raw, label) : null;
    };
    const maturityRaw = field(body, "deposit_maturity_date");
    return {
      kind,
      principal: optionalAmount("deposit_principal", "Principal"),
      instalment: optionalAmount("deposit_instalment", "Monthly instalment"),
      rateBp: Math.round(Number(rateRaw) * 100),
      compounding: field(body, "deposit_compounding") || null,
      startDate: dateField(field(body, "deposit_start_date"), "Started on"),
      maturityDate: maturityRaw?.trim() ? dateField(maturityRaw, "Matures on") : null,
      payout: field(body, "deposit_payout") || null,
    };
  }

  /*
   * The weekday pair is posted by every schedule form, because the fields are
   * hidden rather than removed when the recurrence is something else. Reading
   * them unconditionally is therefore right, and harmless: the domain clears
   * both whenever the recurrence is not 'monthly-nth-weekday'.
   */
  function weekdayOrdinalField(body: Record<string, string | string[]>): WeekdayOrdinal | null {
    const raw = field(body, "recurrence_ordinal");
    if (raw === undefined || raw === "") return null;
    const n = Number(raw);
    if (![1, 2, 3, 4, -1].includes(n)) {
      throw new HttpError(400, "Choose the first, second, third, fourth or last one in the month.");
    }
    return n as WeekdayOrdinal;
  }

  function weekdayField(body: Record<string, string | string[]>): number | null {
    const raw = field(body, "recurrence_weekday");
    if (raw === undefined || raw === "") return null;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 0 || n > 6) {
      throw new HttpError(400, "That is not a day of the week.");
    }
    return n;
  }

  function memberName(id: string | null): string {
    if (!id) return "the app";
    return listMembers(db, { includeRemoved: true }).find((m) => m.id === id)?.name ?? "a former member";
  }

  // -------------------------------------------------------------------------
  // Sign in
  // -------------------------------------------------------------------------
  // Expiring and capped — see auth/pending.ts (SECURITY-OPS-19).
  const pendingOAuth = new PendingStates<{ verifier: string; next: string; at: number }>();
  const pendingGmail = new PendingStates<{ verifier: string; memberId: string; clientId: string; at: number }>();

  /*
   * A sign-in's state, bound to the browser that started it.
   *
   * The state was held in server memory alone, so it proved the flow was
   * started *here* but not *by whom*: anybody could start a sign-in with their
   * own account, stop at the callback, and send that link on — whoever opened
   * it was signed in as them (login CSRF), and entered their own spending into
   * somebody else's ledger. The cookie is set where the flow starts and must
   * come back with the callback, which a link sent to anyone else cannot do.
   * Lax, because the callback is the provider's top-level redirect back.
   */
  const OAUTH_STATE_COOKIE = "pathayam_oauth";
  function oauthStateCookie(state: string): string {
    return [
      `${OAUTH_STATE_COOKIE}=${state}`, "Path=/auth", "HttpOnly", "SameSite=Lax", "Max-Age=600",
      config.baseUrl.startsWith("https") ? "Secure" : "",
    ].filter(Boolean).join("; ");
  }
  function takeOAuthState(ctx: RequestContext, source: string) {
    const state = ctx.query.get("state") ?? "";
    const pending = pendingOAuth.take(state);
    const bound = parseCookies(ctx.req.headers.cookie)[OAUTH_STATE_COOKIE];
    if (!pending || bound !== state) {
      recordAuthAttempt(db, source, "bad-state");
      throw new HttpError(400, "That sign-in link has expired. Please try again.");
    }
    return pending;
  }

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
                  ${when(!oidcConfigured(config) && !passwordSignInOffered(db, config), () => html`
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

  /*
   * The allow-list is a list of email addresses, so an address is only worth
   * matching once the provider vouches that the person signing in owns it.
   * Both callbacks parsed `email_verified` and neither read it: an identity
   * provider that lets people register themselves, or set an address without
   * confirming it (Keycloak and Authentik can both be set up that way), let
   * anyone sign in as any household member by typing that member's address —
   * and on an empty household, become its first member (SECURITY-OPS-17).
   * Refused here, before the address is looked up at all. A provider that
   * does not send the claim is refused too: this cannot tell "not verified"
   * from "not said", and guessing is the wrong way round for a sign-in.
   */
  function refuseUnverifiedEmail(source: string, profile: { email: string; emailVerified: boolean }): void {
    if (profile.emailVerified) return;
    recordAuthAttempt(db, source, "unverified-email", profile.email);
    throw new HttpError(
      403,
      "Your sign-in provider has not verified that email address, so it cannot be used to sign in here. " +
      "Verify it with the provider and try again.",
    );
  }

  /**
   * The provider said no to the code — forged, replayed, expired, or a token
   * that fails its checks. That is a failed sign-in, not a broken server
   * (SECURITY-OPS-18): OAuthError is a plain Error, so it reached the
   * generic 500 page and request_failures, and anybody could mint a state at
   * the public /auth/google and write a fault row per request. Now it is a
   * 400 that says what the provider said, recorded as an auth attempt so it
   * counts toward the rate limit like every other failed sign-in.
   */
  async function exchangeOrRefuse<T>(source: string, exchange: () => Promise<T>): Promise<T> {
    try {
      return await exchange();
    } catch (error) {
      if (!(error instanceof OAuthError)) throw error;
      recordAuthAttempt(db, source, "rejected-code", error.message);
      throw new HttpError(400, `${error.message} Please try signing in again.`);
    }
  }

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

    return { redirect: start.url, headers: { "Set-Cookie": oauthStateCookie(start.state) } };
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
    /*
     * ROUTES-2 · Discovery failing — the provider down, or answering something
     * that is not a discovery document — is the provider's state, not this
     * server breaking. Uncaught, OAuthError was a 500 and a request_failures
     * row on a public, unauthenticated URL: the hole SECURITY-OPS-18 closed on
     * the callback, still open on the way in.
     */
    let start: Awaited<ReturnType<typeof beginOidc>>;
    try {
      start = await beginOidc(
        {
          issuer: config.oidc.issuer!,
          clientId: config.oidc.clientId!,
          clientSecret: config.oidc.clientSecret!,
        },
        `${config.baseUrl}/auth/oidc/callback`,
        deps.fetchImpl,
      );
    } catch (error) {
      if (!(error instanceof OAuthError)) throw error;
      throw new HttpError(503, `${config.oidc.label} is not answering right now. Please try again later.`);
    }
    pendingOAuth.set(start.state, {
      verifier: start.codeVerifier,
      next: safePath(ctx.query.get("next"), "/"),
      at: Date.now(),
    });
    return { redirect: start.url, headers: { "Set-Cookie": oauthStateCookie(start.state) } };
  });

  router.get("/auth/oidc/callback", async (ctx) => {
    const source = clientIp(ctx, config.trustProxy);
    if (isRateLimited(db, source)) {
      throw new HttpError(429, "Too many sign-in attempts. Try again in a few minutes.");
    }
    if (!oidcConfigured(config)) throw new NotFound();

    const pending = takeOAuthState(ctx, source);

    const code = ctx.query.get("code");
    if (!code) {
      recordAuthAttempt(db, source, "no-code");
      throw new HttpError(400, "The identity provider did not return a sign-in code.");
    }

    const profile = await exchangeOrRefuse(source, () => exchangeOidcCode({
      config: {
        issuer: config.oidc.issuer!,
        clientId: config.oidc.clientId!,
        clientSecret: config.oidc.clientSecret!,
      },
      redirectUri: `${config.baseUrl}/auth/oidc/callback`,
      code,
      codeVerifier: pending.verifier,
      fetchImpl: deps.fetchImpl,
    }));
    refuseUnverifiedEmail(source, profile);

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

    const pending = takeOAuthState(ctx, source);

    const code = ctx.query.get("code");
    if (!code) {
      recordAuthAttempt(db, source, "no-code");
      throw new HttpError(400, "Google did not return a sign-in code.");
    }

    const profile = await exchangeOrRefuse(source, () => exchangeCode({
      clientId: config.google.clientId!,
      clientSecret: config.google.clientSecret!,
      redirectUri: `${config.baseUrl}/auth/google/callback`,
      code,
      codeVerifier: pending.verifier,
      fetchImpl: deps.fetchImpl,
    }));
    refuseUnverifiedEmail(source, profile);

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

    /*
     * The Google account is the subject; the address it carries can change.
     * When it does, and the household adds the new address, the subject is
     * still on the old member's row, and google_sub is UNIQUE — so writing it
     * here failed on every attempt, a 500 that locked the person out. The
     * provider has just vouched that this subject owns this allowed address,
     * so the link moves to the member signing in.
     */
    transact(db, () => {
      db.prepare(`UPDATE members SET google_sub = NULL WHERE google_sub = ? AND id != ?`)
        .run(profile.sub, member.id);
      db.prepare(`UPDATE members SET google_sub = ?, avatar_url = ?, name = COALESCE(NULLIF(name,''), ?) WHERE id = ?`)
        .run(profile.sub, profile.picture, profile.name, member.id);
    });

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

    /*
     * And one lockout for all of them: an address with no usable password
     * locks after the same eight guesses a real one does (see
     * checkAbsentPassword). Otherwise the eighth guess answered 429 for a
     * member and 401 for anybody else, which says the same thing the message
     * above was worded not to.
     */
    const usable = member && !member.removed_at && member.allowed && hasPassword(db, member.id);
    const result = usable
      ? checkPassword(db, member.id, password)
      : checkAbsentPassword(db, email, password);
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

    /*
     * One transaction. inviteMember committed before setPassword checked the
     * password, so a password the rules refuse (too short, or on the refused
     * list) answered 422 with the member already created and no password set:
     * this door then closed (the household has a member) and /auth/password
     * had nothing to check, so nobody could ever sign in without editing the
     * database (SECURITY-OPS-16). Refused now, the member is not created
     * either, and the form can simply be tried again.
     */
    const member = transact(db, () => {
      const created = inviteMember(db, { memberId: null, source: "system" }, { email, name });
      setPassword(db, created.id, password);
      return created;
    });

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

  /*
   * A password link, opened. Works signed out — that is who opens one.
   *
   * Referrer-Policy is strict-origin here, not no-referrer, and the difference
   * is the form below. The token is in this page's path, so the full URL must
   * never go anywhere in a Referer: strict-origin sends the origin alone, to
   * this app's own assets as much as to anybody else. no-referrer would do the
   * same for the Referer, and also make the browser send "Origin: null" on the
   * form's POST — the Fetch standard serialises the origin as null under that
   * policy — which sameOriginWrites refuses, rightly, as a request from
   * nowhere. Loosening that check for one route to suit a header would trade
   * the CSRF lock for a guarantee strict-origin already gives.
   *
   * no-store, so the page holding the token is not kept by the browser or
   * anything between it and here.
   */
  const SETUP_LINK_HEADERS = {
    "Cache-Control": "no-store, private",
    "Referrer-Policy": "strict-origin",
  };

  router.get("/auth/setup/:token", (ctx) => {
    const link = usableSetupLink(db, ctx.params.token!);
    if (!link) {
      // Unknown, used, expired and no-longer-suitable all answer exactly this.
      return {
        ...render(
          ctx,
          "Password link",
          html`
            <div style="max-width:26rem;margin:3rem auto">
              <h1>Password link</h1>
              <p>${SETUP_LINK_UNUSABLE}</p>
              <p><a href="/signin">Go to sign in</a></p>
            </div>
          `,
          { bare: true },
        ),
        status: 410,
        headers: SETUP_LINK_HEADERS,
      };
    }
    return {
      ...render(
        ctx,
        "Set your password",
        html`
          <div style="max-width:26rem;margin:3rem auto">
            <h1>Set your password</h1>
            <p class="muted">
              For ${link.member.name}, signing in as ${link.member.email}. This
              link works once.
            </p>
            <form class="card" method="post" action="/auth/setup/${ctx.params.token!}">
              <input type="text" name="username" value="${link.member.email}"
                     autocomplete="username" hidden>
              <div class="field">
                <label for="setup-password">New password</label>
                <input id="setup-password" type="password" name="password" required
                       autocomplete="new-password" minlength="12">
                <p class="field-hint">
                  At least 12 characters. Length is what makes a password hard to
                  guess — three or four words beats a short one with symbols in it.
                </p>
              </div>
              <div class="field">
                <label for="setup-confirm">New password again</label>
                <input id="setup-confirm" type="password" name="confirm" required
                       autocomplete="new-password">
              </div>
              <button class="button button-primary" style="width:100%" type="submit">
                Set it and sign in
              </button>
            </form>
          </div>
        `,
        { bare: true },
      ),
      headers: SETUP_LINK_HEADERS,
    };
  });

  /*
   * Rate limited exactly as /auth/password is, and a link that does not work
   * counts as a failed attempt from where it came: 256 random bits are not
   * guessed, but a door that lets anybody try without limit is still a door
   * that lets anybody try without limit.
   */
  router.post("/auth/setup/:token", (ctx) => {
    const source = clientIp(ctx, config.trustProxy);
    if (isRateLimited(db, source)) {
      throw new HttpError(429, "Too many sign-in attempts. Try again in a few minutes.");
    }
    const token = ctx.params.token!;
    if (!usableSetupLink(db, token)) {
      recordAuthAttempt(db, source, "bad-setup-link");
      throw new SetupLinkUnusable();
    }

    const password = String(field(ctx.body, "password") ?? "");
    const confirm = String(field(ctx.body, "confirm") ?? "");
    if (password !== confirm) {
      throw new Refusal("Those two passwords are not the same. Go back and type them again.");
    }

    // Checks the link again inside its own transaction, and spends it there.
    const member = redeemSetupLink(db, token, password);
    const { token: session } = createSession(db, member.id, {
      userAgent: ctx.req.headers["user-agent"] ?? null,
      ipHint: source,
      days: config.sessionDays,
    });
    recordAuthAttempt(db, source, "success", member.email);

    return {
      // Home, never back to the link's own path — the token stays out of the
      // Location header and out of the history entry it would make.
      redirect: withNotice("/", `Password set. You're signed in, ${member.name}.`),
      headers: {
        ...SETUP_LINK_HEADERS,
        "Set-Cookie": sessionCookie(session, {
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
    // AIW · "AI changes": what an AI connection made, or a member approved from one.
    const source = ctx.query.get("source") === "ai" ? "ai" as const : undefined;
    const events = queryEvents(db, { entity: entity ?? undefined, source, limit: 400 })
      .filter(canSee)
      .slice(0, 100);

    const entities = queryAll<{ entity: string }>(
      db, `SELECT DISTINCT entity FROM events ORDER BY entity`,
    ).map((r) => r.entity);

    return render(
      ctx, "Activity",
      renderActivity({
        entity,
        source: source ?? null,
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
            sourceDetail: e.sourceDetail,
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

  router.post("/activity/:id/undo", (ctx) => {
    const force = field(ctx.body, "force") === "1";
    const eventId = requireVisibleEvent(ctx, ctx.params.id!);

    /*
     * MONEY-CORE-23 · An undo is a change like any other, and one that reaches a
     * reconciled period meets the same "Already reconciled" question an edit
     * does (R7.b), and breaks the checkpoint once answered (R7.c). Undoing a
     * ₹500 → ₹700 correction after the bank was reconciled at ₹9,300 put ₹500
     * back with no question, and the checkpoint stayed intact over a cleared
     * ₹9,500 — nothing reached Review. Which rows an undo writes is its
     * handler's business, on any account, so the undo is tried first and
     * rolled back, and the checkpoints whose cleared balance it would move are
     * the ones asked about.
     */
    if (field(ctx.body, "confirm_checkpoint") !== "1") {
      const moved = checkpointsAnUndoWouldMove(auth(ctx), eventId, force);
      if (moved.length > 0) {
        const fields: Record<string, string> = {};
        for (const [key, value] of Object.entries(ctx.body)) {
          fields[key] = Array.isArray(value) ? value[0]! : value;
        }
        const names = [...new Set(moved.map((c) => {
          const account = getAccount(db, c.account_id);
          return account?.nickname || account?.name || "That account";
        }))];
        return render(
          ctx,
          "Already reconciled",
          renderCheckpointConfirmation({
            accountName: names.join(" and "),
            checkpoints: moved,
            action: `/activity/${eventId}/undo`,
            hiddenFields: fields,
            cancelHref: "/activity",
          }),
        );
      }
    }

    return mutate(ctx, (a) => {
      const actor = actorFor(a, "ui", ctx.req.headers["idempotency-key"] as string);
      const intact = intactCheckpointBalances(db);
      let result;
      try {
        result = undoEvent(db, eventId, actor, { force });
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
      // MONEY-CORE-23 · Confirmed above (or moved nothing then): R7.c/R7.f.
      breakCheckpoints(
        db, actor, checkpointsMovedSince(db, intact),
        "an undo changed a transaction dated on or before it",
      );
      return {
        redirect: "/activity",
        message: result.undoEvent?.summary ?? "Undone.",
      };
    });
  });

  /**
   * MONEY-CORE-23 · The intact checkpoints undoing `eventId` would move, found by
   * undoing it inside a transaction that is always rolled back. An undo that
   * would be refused moves nothing; the real attempt says why.
   */
  function checkpointsAnUndoWouldMove(a: AuthContext, eventId: string, force: boolean): Checkpoint[] {
    class DryRun extends Error {
      readonly moved: Checkpoint[];
      constructor(moved: Checkpoint[]) { super("dry run"); this.moved = moved; }
    }
    try {
      transact(db, () => {
        const intact = intactCheckpointBalances(db);
        const result = undoEvent(db, eventId, actorFor(a), { force });
        throw new DryRun(result.ok ? checkpointsMovedSince(db, intact) : []);
      });
    } catch (err) {
      if (err instanceof DryRun) return err.moved;
    }
    return [];
  }

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
      headers: {
        "Set-Cookie": clearedSessionCookie(config.baseUrl.startsWith("https")),
        /*
         * OFFLINE-1 · R35.5 as amended. The client script purges its queue
         * when the sign-out form is submitted; this is the same promise kept
         * by the browser, for a script that never ran or a tab that had an
         * old one. "storage" is localStorage and friends — the session
         * cookie is cleared by the line above, not here.
         */
        "Clear-Site-Data": '"storage"',
      },
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
    // WEB-3 · An item whose page is a module this instance does not offer (a
    // subscription renewing, a shortfall on the schedules calendar, with
    // FEATURE_SCHEDULES off) goes with the module rather than linking to a 404.
    const digest = month === view.currentMonth
      ? renderDigest(
        digestFor(db, a.viewingAs.id, todayIST(), viewer(ctx), scope)
          .filter((item) => pathAvailable(item.href, config.features)),
      )
      : undefined;

    // 15 · The switcher lives in the sidebar now, on every screen that shows one
    // budget's money. A second copy at the top of this one was the same control
    // twice, and the sidebar's is the one that is always there.
    return render(ctx, formatMonth(month), renderBudget(view, digest, { reports: config.features.reports }));
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
      /*
       * BUDGET-23 · Picking it up is committing more to the household, and only
       * that. Any of her envelopes used to do — "You have picked up ₹700" into
       * Fun, with nothing reaching the household — and so did a negative amount:
       * −₹3,000 took her commitment below zero and told the household it owed
       * her money she never paid. Call it even already refused one.
       */
      if (envelope.commits_to_budget_id !== householdBudgetId(db)) {
        throw new Refusal("Picking it up commits money to the household, from your household envelope.");
      }
      if (extra <= 0) throw new Refusal("Say how much you are picking up.");

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
      /*
       * BUDGET-11 · A commitment to a budget you can see is yours to settle when
       * that side is the one letting go, even though the envelope itself sits in
       * the member's own budget: 15 §4A.5, "for a balance with the household any
       * member may act". callItEven checks the giving side against the viewer.
       */
      const envelopeId = requiredField(ctx.body, "envelope_id");
      const envelope = getCategory(db, envelopeId);
      const settles = envelope?.commits_to_budget_id
        && visibleBudgetIds(db, viewer(ctx)).has(envelope.commits_to_budget_id);
      const call = callItEven(db, actorFor(a, "ui", ctx.req.headers["idempotency-key"] as string), {
        envelopeId: settles ? envelopeId : requireVisibleCategory(ctx, envelopeId)!,
        amount: amountField(requiredField(ctx.body, "amount"), "Amount") as Paise,
        givingCategoryId: requireVisibleCategory(ctx, field(ctx.body, "giving_category_id") || null) || undefined,
        month: monthParam(ctx),
        note: field(ctx.body, "note") || null,
        viewerMemberId: viewer(ctx),
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
    const me = viewer(ctx);
    const view = buildHouseholdView(db, month, viewer(ctx));
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
    /*
     * BUDGET-2 / BUDGET-5 · One budget's envelopes and one budget's Ready to
     * Assign. The combined view offered "Ready to Assign — ₹78,777" on a
     * household page reading ₹1,000, the difference being another member's
     * private account, and listed two budgets' envelopes side by side as if
     * money could move between them without a transfer.
     */
    const view = buildBudgetView(db, month, budgetParam(ctx), viewer(ctx));
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
      // "rta" is the screen's own first source and is not an envelope, so it
      // is not checked as one (ROUTES-1: it answered 404 "does not exist").
      const fromField = requiredField(ctx.body, "from_category_id");
      const from = fromField === "rta" ? "rta" : requireVisibleCategory(ctx, fromField)!;
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
    // D4 · The budget being looked at holds it, and it is that budget's Ready
    // to Assign it comes out of — not the sum of everybody's.
    const scope = budgetParam(ctx);
    const view = buildBudgetView(db, month, scope, viewer(ctx));
    return render(
      ctx,
      "Hold for next month",
      renderHold({
        month,
        budgetId: scope,
        currentlyHeld: getHeld(db, month, scope),
        readyToAssign: view.monthState.readyToAssign,
      }),
    );
  });

  router.post("/hold", (ctx) =>
    mutate(ctx, (a) => {
      const month = monthParam(ctx);
      const rawAmount = field(ctx.body, "amount") ?? "";
      const amount = rawAmount.trim() === "" ? 0 : amountField(rawAmount);
      setHeld(
        db, actorFor(a, "ui", ctx.req.headers["idempotency-key"] as string), month, amount,
        postedBudget(ctx),
      );
      return {
        redirect: `/?month=${month}`,
        message: amount === 0 ? "Released the held money." : `Held ${formatPaise(amount)} for next month.`,
      };
    }),
  );

  router.get("/auto-assign", (ctx) => {
    const month = monthParam(ctx);
    const scope = budgetParam(ctx);
    const plan = buildAutoAssignPlan(month, scope, viewer(ctx));
    const view = buildBudgetView(db, month, scope, viewer(ctx));
    return render(
      ctx,
      "Auto-assign",
      renderAutoAssignPreview({
        month,
        budgetId: scope,
        plan,
        categoryNames: new Map([...view.categories].map(([id, c]) => [id, c.name])),
      }),
    );
  });

  router.post("/auto-assign", (ctx) =>
    mutate(ctx, (a) => {
      const month = monthParam(ctx);
      const plan = buildAutoAssignPlan(month, postedBudget(ctx), viewer(ctx));
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
        () => copyAssignmentsFromMonth(db, actor, month, addMonths(month, -1), postedBudget(ctx)),
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
  function buildAutoAssignPlan(
    month: MonthKey, budgetId: string, viewerMemberId: string | null,
  ): AutoAssignPlan {
    /*
     * D14 · One budget's plan, from that budget's Ready to Assign.
     *
     * This read the combined view of every budget: household RTA ₹0 (₹1,000 all
     * in Groceries, target ₹1,500) plus Priya's ₹50,000 made a pool of ₹50,000,
     * so Ravi's click assigned ₹500 more to Groceries than the household had —
     * RTA −₹500 — and ₹700 into Priya's private envelope out of her money.
     * The caller has already checked the budget is one the reader may use.
     */
    const view = buildBudgetView(db, month, budgetId, viewerMemberId);
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

  /**
   * UIQ-1 · The dialog fetches a fragment; anything else navigated here — a
   * long-press "open in new tab", a middle click, a page whose script did not
   * load — and is owed a page. The fragment used to go to both, began with a
   * newline, went out as text/plain, and the browser printed the raw tags.
   */
  function explainResponse(ctx: RequestContext, opts: Parameters<typeof renderExplain>[0]): Response {
    const fetched =
      ctx.req.headers["x-fragment"] === "1" || ctx.req.headers["sec-fetch-dest"] === "empty";
    const vary = { Vary: "X-Fragment, Sec-Fetch-Dest" };
    if (fetched) return { body: renderExplain(opts), headers: { "Content-Type": "text/html; charset=utf-8", ...vary } };
    const page = render(ctx, opts.title, html`<div class="card">${renderExplain({ ...opts, headingLevel: 1 })}</div>`);
    return { ...page, headers: { ...page.headers, ...vary } };
  }
  router.get("/explain/ready-to-assign", (ctx) => {
    const month = monthParam(ctx);
    // BUDGET-2 · The figure being explained is one budget's; so is the answer.
    const view = buildBudgetView(db, month, budgetParam(ctx), viewer(ctx));
    const b = view.monthState.rtaBreakdown;

    const lines = [
      { when: "", who: "", what: `Income received up to ${formatMonth(month)}: ${formatPaise(b.incomeToDate)}` },
      { when: "", who: "", what: `Less assigned this month and earlier: ${formatPaise(-b.assignedThisMonthAndEarlier)}` },
      { when: "", who: "", what: `Less assigned in future months: ${formatPaise(-b.assignedInFutureMonths)}` },
      { when: "", who: "", what: `Less held for next month: ${formatPaise(-b.heldForNextMonth)}` },
      { when: "", who: "", what: `Less cash overspending carried in: ${formatPaise(-b.cashOverspendCarried)}` },
    ];

    return explainResponse(ctx, {
      title: "Ready to Assign",
      figure: b.total,
      summary: `Every rupee in a budget account that hasn't been given a job yet.`,
      lines,
    });
  });

  router.get("/explain/category/:id", (ctx) => {
    const month = monthParam(ctx);
    // BUDGET-2 · Computed in the envelope's own budget, which the viewer must
    // be able to see — the same answer the grid it was opened from shows.
    const own = listCategories(db, { includeHidden: true, viewerMemberId: viewer(ctx) })
      .find((c) => c.id === ctx.params.id);
    if (!own) throw new NotFound();
    const view = buildBudgetView(db, month, own.budget_id ?? householdBudgetId(db), viewer(ctx));
    const category = view.categories.get(own.id);
    if (!category) throw new NotFound();

    /*
     * BUDGET-6 · The envelope's own transactions this month, split lines
     * included, and every event on each. This read the 40 *oldest* transaction
     * events in the household and kept those in this envelope and month — so
     * past its first 40 transactions every envelope said "Nothing has affected
     * this figure yet" under a figure that plainly had been, and a split line
     * (no category on the transaction itself) was never matched at all. A row
     * in an account the viewer may not see stays out, as it does in registers.
     */
    const hidden = hiddenTransactionSql("t", viewer(ctx));
    const transactionIds = queryAll<{ id: string }>(
      db,
      `SELECT t.id FROM transactions t
        WHERE t.deleted_at IS NULL AND t.date >= ? AND t.date < ?
          AND (t.category_id = ?
               OR EXISTS (SELECT 1 FROM transaction_splits s
                           WHERE s.transaction_id = t.id AND s.category_id = ?))
          AND NOT ${hidden.sql}`,
      `${month}-01`, `${addMonths(month, 1)}-01`, category.id, category.id, ...hidden.params,
    ).map((r) => r.id);

    // J22: three events, three actors, one answer.
    const events = [
      ...historyFor(db, "assignment", `${month}:${category.id}`),
      ...transactionIds.flatMap((id) => historyFor(db, "transaction", id)),
    ].sort((a, b) => a.seq - b.seq);

    return explainResponse(ctx, {
      title: category.name,
      figure: category.state.balance,
      summary:
        `Opened at ${formatPaise(category.state.opening)}, ` +
        `${formatPaise(category.state.assigned)} assigned, ` +
        `${formatPaise(-category.state.activity)} spent.`,
      lines: events.map((e) => explainLineFor(e, memberName)),
    });
  });

  // -------------------------------------------------------------------------
  // S2 · Accounts
  // -------------------------------------------------------------------------
  router.get("/accounts", (ctx) => {
    /*
     * 15 · The accounts of the budget being looked at, plus the tracking accounts,
     * which fund no budget and so belong to the household's picture whichever one
     * is selected (FW1).
     */
    const scope = budgetParam(ctx);
    const rows: AccountRow[] = accountRows(db, { budgetId: scope, viewerMemberId: viewer(ctx) });

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
      features: config.features,
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
      const holder = text("holder_member_id") && requireMember(ctx, text("holder_member_id")!);
      const visibility = field(ctx.body, "visibility") === "private" ? "private"
        : field(ctx.body, "visibility") === "household" ? "household" : undefined;
      /*
       * FRESH-WEB-2 · "Private to me", as the form says. The visibility and the
       * holder were taken as two separate fields, so a member could mark
       * another member's account — in that member's own budget — private to
       * themselves, and it vanished from the screens of the person it belongs
       * to, Activity included, leaving them nothing to undo it from. Private
       * is only ever private to whoever is making it so.
       */
      const before = getAccount(db, id)!;
      const nextHolder = holder !== undefined ? holder : before.holder_member_id;
      const nextBudget = text("budget_id") ?? before.budget_id;
      const mine = (who: string | null) => who === null || who === a.member.id;
      if (
        (visibility ?? before.visibility) === "private" && nextHolder && (
          nextHolder !== a.member.id || !mine(before.holder_member_id)
          // An account funding somebody else's budget is theirs to hide, not mine.
          || (nextBudget !== null && !budgetsFor(db, a.member.id).some((b) => b.id === nextBudget))
        )
      ) {
        throw new Refusal(
          "Only you can be the one a private account is private to. Leave it shared, " +
          "or let whoever's name is on it make it private themselves.",
        );
      }
      /*
       * IMP-18 · A card account takes four to eight trailing digits. The form
       * shows only the last four, so the same four sent back keep any longer
       * run on file; new digits replace it, and an empty box clears both.
       */
      const cardNumber = parseCardNumber(field(ctx.body, "last4"), { card: before.kind === "credit" });
      const keepsLonger = cardNumber !== undefined && cardNumber !== null
        && cardNumber.length === 4 && cardNumber === before.last4;
      updateAccount(db, actorFor(a, "ui", ctx.req.headers["idempotency-key"] as string), id, {
        name: requiredField(ctx.body, "name"),
        nickname: text("nickname"),
        institution: text("institution"),
        last4: cardNumber === undefined ? undefined : cardNumber?.slice(-4) ?? null,
        holder_member_id: holder,
        statement_day: numberOrNull(field(ctx.body, "statement_day")),
        due_day: numberOrNull(field(ctx.body, "due_day")),
        // 15 · Moving an account between budgets is one undoable step, recorded
        // like any other edit, because it moves money's home. Only into a
        // budget this member could have picked: any id was taken, so the
        // household's joint account could be moved into another member's
        // personal budget (SECURITY-OPS-4).
        budget_id: text("budget_id") && requireVisibleBudget(ctx, text("budget_id")!),
        visibility,
      });
      if (cardNumber !== undefined && !keepsLonger) keepLongerCardDigits(db, actorFor(a), id, cardNumber);
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
      /*
       * The picker sends "kind:subtype" as one value, so the two cannot
       * disagree. The older shape — two separate fields — is still accepted,
       * because the API and anything already scripted against it send that.
       */
      const chosen = requiredField(ctx.body, "subtype");
      const [pairKind, pairSubtype] = chosen.includes(":")
        ? chosen.split(":") as [string, string]
        : [field(ctx.body, "kind") ?? "", chosen];
      const kind = pairKind as AccountKind;
      const subtype = pairSubtype;

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
      // DEPOSITS · Terms are optional, and read before anything is created so
      // terms that cannot be priced leave no account behind.
      const terms = DEPOSIT_SUBTYPES.has(subtype) && kind === "tracking" ? depositTermsField(ctx.body) : null;
      const openingDate = dateField(openingDateRaw, "Opening date");
      /*
       * UI-6 · A PPF, EPF or other deposit already running is usually entered
       * as its current balance, with the principal left blank. It was valued
       * at ₹0 — principal plus register, and the opening balance is in
       * neither — so it fell out of net worth and FIRE. With no principal, the
       * balance is the principal and its as-of date the start: worth that on
       * that day, growing from there. The account page says so.
       */
      const grewFromOpening = !!terms && terms.principal == null && opening > 0
        && READS_REGISTER.has(terms.kind as DepositKind);
      if (terms && grewFromOpening) {
        terms.principal = opening;
        terms.startDate = openingDate;
      }
      if (terms) checkTerms(terms);

      // F2.6: a credit card's balance is what you owe. Entering it as a
      // positive figure is the obvious slip, so take it as intended rather
      // than rejecting it.
      if (kind === "credit" && opening > 0) opening = -opening;

      // IMP-18 · A card account takes up to eight trailing digits; any other, four.
      const cardNumber = parseCardNumber(field(ctx.body, "last4"), { card: kind === "credit" }) ?? null;
      const account = createAccount(db, actorFor(a, "ui", ctx.req.headers["idempotency-key"] as string), {
        name: requiredField(ctx.body, "name"),
        kind,
        subtype,
        institution: field(ctx.body, "institution") || null,
        last4: cardNumber?.slice(-4) ?? null,
        openingBalance: opening,
        openingDate,
        statementDay: numberOrNull(field(ctx.body, "statement_day")),
        dueDay: numberOrNull(field(ctx.body, "due_day")),
        // 15 · Whose money it is, and who can see it, are settled at creation
        // rather than as a second edit nobody remembers to make. The budget
        // must be one this member can see (SECURITY-OPS-4): another member's
        // personal budget took the account and its opening balance.
        budgetId: guardedField(ctx, "budget_id", requireVisibleBudget) ?? undefined,
        visibility: field(ctx.body, "visibility") === "private" ? "private" : undefined,
        // FRESH-WEB-2 · "Private to me": the form sends no holder, and the
        // domain rightly refuses a private account that is private to nobody —
        // so every private account the form tried to make was refused.
        holderMemberId: field(ctx.body, "visibility") === "private" ? a.member.id : undefined,
      });
      if (terms) {
        setDepositTerms(db, actorFor(a, "ui", ctx.req.headers["idempotency-key"] as string), account.id, terms);
      }
      if (cardNumber && cardNumber.length > 4) keepLongerCardDigits(db, actorFor(a), account.id, cardNumber);

      return {
        redirect: `/accounts/${account.id}`,
        message: !terms ? `Added ${account.name}.`
          : grewFromOpening
            ? `Added ${account.name}, worth ${formatPaise(opening)} on ${formatDate(openingDate)}, growing from there.`
            : `Added ${account.name}, valued from its terms.`,
      };
    }),
  );

  /*
   * DEPOSITS · Set, change or take off a deposit's terms. Each is one event,
   * undone from Activity like any other change. The account is resolved
   * through the visibility guard first, so a private deposit's terms are its
   * holder's alone.
   */
  router.post("/accounts/:id/deposit", (ctx) =>
    mutate(ctx, (a) => {
      const account = requireVisibleAccount(ctx, ctx.params.id!);
      const terms = depositTermsField(ctx.body);
      if (!terms) throw new Refusal("Pick what kind of deposit this is.");
      const saved = setDepositTerms(
        db, actorFor(a, "ui", ctx.req.headers["idempotency-key"] as string), account.id, terms,
      );
      return {
        redirect: `/accounts/${account.id}#terms`,
        message: `${account.nickname || account.name} is now valued from its terms: ${describeTerms(saved)}.`,
      };
    }),
  );

  router.post("/accounts/:id/deposit/remove", (ctx) =>
    mutate(ctx, (a) => {
      const account = requireVisibleAccount(ctx, ctx.params.id!);
      removeDepositTerms(db, actorFor(a, "ui", ctx.req.headers["idempotency-key"] as string), account.id);
      return {
        redirect: `/accounts/${account.id}`,
        message: `Took the terms off ${account.nickname || account.name}. Undo it from Activity if that was a slip.`,
      };
    }),
  );

  router.get("/accounts/:id", (ctx) => {
    auth(ctx);
    const account = requireVisibleAccount(ctx, ctx.params.id!);

    const balances = accountBalances(db).get(account.id)!;
    const cardFilter = ctx.query.get("card");

    /*
     * 15 · Rows filed to an envelope the reader cannot see are left out, the
     * same transactions memberScope hides from the transaction page, the
     * activity log and the export. They are still read, so every running
     * balance shown is the account's real balance after that row: the account
     * is visible and so is its balance; the envelope, payee and memo are not.
     */
    const registerHidden = hiddenTransactionSql("t", viewer(ctx));
    const raws = queryAll<{
      id: string; date: string; amount: number; cleared: number; memo: string | null;
      payee: string | null; category: string | null; transfer_pair_id: string | null;
      card_label: string | null; owner_name: string | null; hidden: number; is_split: number;
      pair_kind: string | null;
    }>(
      db,
      `SELECT t.id, t.date, t.amount, t.cleared, t.memo, t.transfer_pair_id, t.is_split,
              p.name AS payee, c.name AS category, cd.label AS card_label, m.name AS owner_name,
              (SELECT pa.kind FROM transactions pt JOIN accounts pa ON pa.id = pt.account_id
                WHERE t.transfer_pair_id IS NOT NULL AND pt.transfer_pair_id = t.transfer_pair_id
                  AND pt.id <> t.id LIMIT 1) AS pair_kind,
              ${registerHidden.sql} AS hidden
         FROM transactions t
         LEFT JOIN payees p   ON p.id = t.payee_id
         LEFT JOIN categories c ON c.id = t.category_id
         LEFT JOIN cards cd   ON cd.id = t.card_id
         LEFT JOIN members m  ON m.id = t.owner_member_id
        WHERE t.account_id = ? AND t.deleted_at IS NULL
          ${cardFilter ? "AND t.card_id = ?" : ""}
        ORDER BY t.date DESC, t.created_at DESC
        LIMIT 300`,
      ...registerHidden.params,
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
        /*
         * UI-10 · Money going into a card from another account, seen from
         * either side, is a card payment; any other transfer is a transfer.
         */
        transferLabel: r.transfer_pair_id === null ? null
          : (account.kind === "credit" && r.amount > 0) || (r.pair_kind === "credit" && r.amount < 0)
            ? "Card payment"
            : "Transfer",
        isSplit: r.is_split === 1,
        /*
         * UI-2 · Review's own rule for "needs a category" (see /review): money
         * out of a budget or credit account, not a transfer, not split, with no
         * envelope. Income lands in Ready to Assign, a split's lines carry the
         * envelopes, and a tracking account has none to give.
         */
        needsCategory:
          r.category === null && r.is_split === 0 && r.transfer_pair_id === null
          && account.kind !== "tracking" && r.amount < 0,
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
      return r.hidden ? null : row;
    }).filter((row): row is RegisterRow => row !== null);

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
        features: config.features,
        account,
        cardNumberOnFile: account.kind === "credit" ? maskedCardNumber(db, account.id) : null,
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
        // UI-9 · With no statement, the next due date by the card's due day.
        dueByDay: account.kind === "credit" && account.due_day && balances.working < 0
          && !lastCardStatement(db, account.id)
          ? nextDueByDay(account.due_day)
          : null,
        lastReconciled: recon?.as_of ?? null,
        checkpointBroken: Boolean(recon?.broken_at),
        deposit: config.features.deposits && account.kind === "tracking" && DEPOSIT_SUBTYPES.has(account.subtype)
          ? (() => {
              const computed = computedDepositValue(db, account.id);
              const standing = standingValuation(db, account.id);
              return {
                terms: computed?.terms ?? null,
                description: computed ? describeTerms(computed.terms) : null,
                computed: computed?.value ?? null,
                basisDate: computed?.basisDate ?? null,
                maturity: computed?.maturity ?? null,
                standing: standing && computed
                  ? { value: standing.value, asOf: standing.asOf, source: standing.source }
                  : null,
                today: todayIST(),
              };
            })()
          : null,
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
    // The reader's last-used account. The household's could be somebody
    // else's private one, which is not in the list, so nothing was preselected.
    const lastUsedHidden = hiddenTransactionSql("t", viewer(ctx));
    const lastUsed = queryOne<{ account_id: string }>(
      db,
      `SELECT t.account_id FROM transactions t
        WHERE t.deleted_at IS NULL AND NOT ${lastUsedHidden.sql}
        ORDER BY t.created_at DESC LIMIT 1`,
      ...lastUsedHidden.params,
    );

    return render(
      ctx,
      "Add a transaction",
      renderAddTransaction({
        accounts,
        categories: [...view.categories.values()],
        payees: listPayees(db, viewer(ctx)).map((p) => {
          const stats = payeeStats(db, p.id, viewer(ctx));
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

  router.post("/add", (ctx) => {
    /*
     * MONEY-CORE-17 · A cleared entry dated inside a reconciled period changes
     * the balance the checkpoint asserted, exactly as editing one there does —
     * so it meets the same "Already reconciled" confirmation, and confirming
     * breaks the checkpoint (R7.b/c). Adding ₹700 "already cleared" on the 5th
     * under a checkpoint of the 10th left it intact at ₹10,000 while the
     * cleared balance was ₹9,300, and nothing reached Review. An uncleared
     * entry is not part of what the bank asserted, so it asks nothing.
     */
    if (field(ctx.body, "cleared") === "1") {
      const guard = guardCheckpoints(
        ctx, auth(ctx), requireVisibleAccount(ctx, requiredField(ctx.body, "account_id")).id,
        [dateField(field(ctx.body, "date"))], field(ctx.body, "confirm_checkpoint") === "1", "/add", "/add",
      );
      if (guard) return guard;
    }
    return mutate(ctx, (a) => {
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
      /*
       * Envelope lines. The first carries no amount and takes what the others
       * leave, so they cannot disagree with the total — see
       * resolveCategoryLines.
       */
      const lineValues: { categoryId: string | null; amount: Paise | null }[] = [];
      for (let i = 0; i < 10; i++) {
        const cat = field(ctx.body, `split_category_${i}`);
        const raw = String(field(ctx.body, `split_amount_${i}`) ?? "").trim();
        /*
         * The first line counts whenever the form sends it, empty or not. An
         * empty one is an instruction — "no envelope" — which on money coming
         * in is ordinary: the remainder lands in Ready to Assign. Skipping it
         * the way a blank later line is skipped promoted line 2 to first and
         * filed the *whole* amount into it, so ₹50,000 of salary with ₹5,000
         * named for PF put all ₹50,000 in PF.
         */
        if (i > 0 && !cat && !raw) continue;
        if (i === 0 && cat === undefined && !raw) continue;
        const magnitude = raw ? Math.abs(amountField(raw, `Envelope ${i + 1}`)) : null;
        lineValues.push({
          categoryId: cat ? requireVisibleCategory(ctx, cat)! : null,
          // The first line never carries one, whatever was posted.
          amount: i === 0 || magnitude === null
            ? null
            : ((direction === "in" ? magnitude : -magnitude) as Paise),
        });
      }

      /*
       * `category_id` is still accepted when no lines were sent. The form does
       * not use it any more, but the API and anything scripted against it do,
       * and silently filing their transactions as uncategorised would be a
       * poor way to find that out.
       */
      if (lineValues.length === 0) {
        const legacy = field(ctx.body, "category_id");
        if (legacy) lineValues.push({ categoryId: requireVisibleCategory(ctx, legacy)!, amount: null });
      }

      const filed = resolveCategoryLines(
        (direction === "in" ? magnitude : -magnitude) as Paise,
        lineValues,
      );

      /*
       * B99 · An expense has to name the envelope it came out of.
       *
       * "Uncategorised — I'll sort it later" was an option on this form, and
       * later mostly never came: three years of real use left a queue of them,
       * each one money that had left the household with no envelope recording
       * it. Income is different and stays optional — its job is to arrive in
       * Ready to Assign and wait to be given one, which is the whole model.
       */
      if (outgoingLacksEnvelope((direction === "in" ? magnitude : -magnitude) as Paise, filed)) {
        throw new HttpError(
          400,
          "Which envelope did this come out of? Money in doesn't need one — money out does.",
        );
      }

      breakGuardedCheckpoints(ctx, a, () => createTransaction(db, actorFor(a, "ui", ctx.req.headers["idempotency-key"] as string), {
        accountId: requireVisibleAccount(ctx, requiredField(ctx.body, "account_id")).id,
        amount: direction === "in" ? magnitude : -magnitude,
        date: dateField(dateRaw),
        payeeName: field(ctx.body, "payee") || null,
        splits: filed.splits ?? undefined,
        categoryId: filed.categoryId,
        memo: field(ctx.body, "memo") || null,
        tags,
        cleared: field(ctx.body, "cleared") === "1",
        reimbursable: field(ctx.body, "reimbursable") === "1",
        // H2 · Who spent it. A card with its own holder still wins — an add-on
        // charge belongs to whoever holds the add-on (R6.e).
        ownerMemberId: guardedField(ctx, "owner_member_id", requireMember) ?? undefined,
      }));

      return { redirect: "/", message: `Saved ${formatPaise(magnitude)}.` };
    });
  });

  // B51: the form that was missing — POST /transfer shipped, but no GET
  // rendered a form and the only link 405'd. Transfers underpin card payments,
  // asset purchases and family lending.
  router.get("/transfer", (ctx) => {
    auth(ctx);
    // Derived accounts are refused by createTransfer — each has its own screen
    // that records the money properly — so offering them would be a choice that
    // always fails. Same rule as the Add form.
    const accounts = listAccounts(db, { viewerMemberId: viewer(ctx) })
      .filter((a) => !DERIVED_VALUE_SUBTYPES.has(a.subtype));
    return render(
      ctx,
      "Record a transfer",
      renderTransfer({
        accounts,
        defaultFrom: ctx.query.get("from"),
        defaultTo: ctx.query.get("to"),
        /*
         * "Pay it off" on the Cards page links here with what the card owes.
         * The form ignored it, so the button promised an amount and delivered
         * an empty field. Rupees, parsed the way /move parses its own.
         */
        defaultAmount: ctx.query.get("amount")?.trim()
          ? Math.abs(amountField(ctx.query.get("amount")!, "Amount"))
          : null,
        today: todayIST(),
        // Only envelopes this viewer can see, and never a card's payment
        // envelope — the domain refuses one, so offering it would be a choice
        // that always fails.
        categories: [...buildBudgetView(db, undefined, undefined, viewer(ctx)).categories.values()]
          .filter((c) => !c.hidden && !c.isPaymentCategory && !c.commitsToBudgetId)
          .map((c) => ({ id: c.id, name: c.name })),
      }),
    );
  });

  router.post("/transfer", (ctx) =>
    mutate(ctx, (a) => {
      const fromAccountId = requireVisibleAccount(ctx, requiredField(ctx.body, "from_account_id")).id;
      const toAccountId = requireVisibleAccount(ctx, requiredField(ctx.body, "to_account_id")).id;
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
  //
  // SECURITY-OPS-3 · It was a GET, the one GET that wrote: a cross-site link
  // flipped the theme and logged an event (SameSite=Lax sends the cookie on a
  // top-level navigation), and it returned to any Referer that merely *began*
  // with BASE_URL — http://127.0.0.1.evil.example passed for http://127.0.0.1.
  // Now a POST through mutate, so the origin check applies, and it returns only
  // to a same-site path the palette sends, the way POST /settings/theme does.
  router.post("/settings/theme-toggle", (ctx) =>
    mutate(ctx, (a) => {
      /*
       * UIQ-4 · On "system" the server cannot see what the device shows, so
       * the client says (`seen`); without it, dark is the old guess.
       */
      const current = a.viewingAs.theme === "system" ? field(ctx.body, "seen") : a.viewingAs.theme;
      const next: Theme = current === "dark" ? "light" : "dark";
      setTheme(db, actorFor(a), a.member.id, next);
      return { redirect: safePath(field(ctx.body, "return_to"), "/") };
    }),
  );

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
      /*
       * Only your own. Settings lists only the viewer's sessions, but the
       * route revoked whatever id it was handed — so signing somebody else out
       * needed nothing but their session id. Ids are hashes of the tokens and
       * never shown to anyone else, which made it hard to reach, not safe.
       * Another member's session answers exactly like one that does not exist.
       */
      const sessionId = requiredField(ctx.body, "session_id");
      if (!listSessions(db, a.member.id).some((s) => s.id === sessionId)) {
        throw new NotFound("That session does not exist.");
      }
      revokeSession(db, actorFor(a), sessionId);
      return { redirect: "/settings", message: "Signed that device out." };
    }),
  );

  router.get("/settings", (ctx) => {
    const a = auth(ctx);
    const members = listMembers(db);
    // F1.6 · Removed is a state, not a deletion.
    const removedMembers = listMembers(db, { includeRemoved: true })
      .filter((m) => m.removed_at !== null);
    // PLAN-1 · At MAX_MEMBERS, a form to add one more would only be refused.
    const canAddMember = config.limits.maxMembers === null || members.length < config.limits.maxMembers;
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
          !config.demoMode && (config.features.gmail || config.features.gmailByo),
          () => renderGmailConnection(connectionView(db, a.member.id), {
            route: clientForConnect(db, config, a.member.id)?.source ?? null,
            byo: config.features.gmailByo,
            canSave: canSaveClients(config),
            mine: clientView(db, a.member.id),
            household: clientView(db, HOUSEHOLD),
            redirectUri: `${config.baseUrl}/gmail/callback`,
            origin: config.baseUrl,
          }),
        )}

        ${when(!config.demoMode && (config.features.gmail || config.features.gmailByo), () => renderCardDigitAsks(cardDigitAsks(ctx)))}
        ${when(!config.demoMode && pendingGoldToken(ctx, a.member.id) !== null, () => html`
          <p class="notice notice-info" id="gold-waiting">
            The same fetch read a SafeGold statement.
            <a href="/portfolio/safegold/review?token=${encodeURIComponent(pendingGoldToken(ctx, a.member.id)!)}">Review its gold entries</a>
            before they expire in half an hour.
          </p>`)}

        ${when(!config.demoMode && config.features.forwarding, () => renderForwarding(forwardingView(a.member.id)))}

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
                        <!--
                          A password link, only where one can be made and is
                          needed: somebody else, with no password, while password
                          sign-in is a way in at all, and not while viewing as
                          somebody (the POST refuses that). Offered whether or not
                          Google is configured: with both, a password is a second
                          way in that does not depend on Google, which is the
                          point of /settings/password too. A member whose private
                          records mean their link must come from the server still
                          gets the button — the refusal is what explains that, and
                          leaving the button off would explain nothing.
                        -->
                        ${when(
                          !config.demoMode && !a.impersonating
                            && passwordSignInOffered(db, config) && !hasPassword(db, m.id),
                          () => html`
                            <form method="post" action="/members/${m.id}/password-link">
                              <button class="button-small" type="submit">Make a password link</button>
                            </form>
                          `,
                        )}
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
                  ${when(!config.demoMode && canAddMember, () => html`
                    <form method="post" action="/members/invite">
                      <input type="hidden" name="email" value="${m.email}">
                      <button class="button-small" type="submit">Add back</button>
                    </form>
                  `)}
                </div>
              `,
            )}
          `)}
          ${when(!config.demoMode && !canAddMember, () => html`
            <p class="faint" style="margin-top:1rem">
              ${config.limits.maxMembers === 1
                ? "This instance is for one person, so nobody else can be added."
                : `This instance allows ${config.limits.maxMembers} members, and the household is full.`}
            </p>
          `)}
          ${when(
            !config.demoMode && canAddMember,
            () => html`
              <form method="post" action="/members/invite" style="margin-top:1rem">
                <div class="field">
                  <label for="invite-email">Add a household member</label>
                  <input id="invite-email" name="email" type="email" required
                         placeholder="partner@example.com">
                  <p class="field-hint">
                    ${Boolean(config.google.clientId && config.google.clientSecret)
                      ? "They'll be able to sign in with that Google account."
                      : oidcConfigured(config)
                        ? `They'll be able to sign in with ${config.oidc.label} using that address.`
                        : passwordSignInOffered(db, config)
                          ? "They'll need a password: once they're added, make them a password link above."
                          : "They'll be able to sign in with that address."}
                  </p>
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
                  <div class="faint">Last seen ${formatDate(s.last_seen_at.slice(0, 10))}</div>
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
              ? html`Changing it signs you out on every other device; this one
                     stays signed in.`
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
      /*
       * A new password is how somebody locks out whoever learned the old one,
       * so it has to end the sessions the old one opened. It only rewrote the
       * hash: a session signed in on another device with the old password
       * went on reading and writing the ledger, for up to SESSION_DAYS (30),
       * after the change meant to stop it. This device stays signed in.
       */
      const others = listSessions(db, a.member.id).filter((s) => s.id !== a.session.id).length;
      if (others > 0) revokeAllSessions(db, actorFor(a), a.member.id, { except: a.session.id });
      return {
        redirect: "/settings",
        message: others > 0
          ? `Password set. Signed out ${others === 1 ? "one other device" : `${others} other devices`}.`
          : "Password set.",
      };
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
      // 15 · Another member's private card purchase is not there to convert:
      // this created a loan against Ravi's ₹60,000 card spend for Priya.
      const transactionId = requireLiveTransaction(ctx, ctx.params.id!).id;
      const result = convertToEmi(db, actorFor(a, "ui", ctx.req.headers["idempotency-key"] as string), {
        transactionId,
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
          `${formatPaise(result.totalCostOfBorrowing)} in interest, GST and fees.`,
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
      const email = String(requiredField(ctx.body, "email"));
      const returning = !!findMemberByEmail(db, email)?.removed_at;
      const member = inviteMember(db, actorFor(a), { email }, { maxMembers: config.limits.maxMembers });
      /*
       * Somebody added back had their password cleared when they were removed
       * (removeMember). "Can now sign in" would tell the person re-adding them
       * that the old one still works, which it deliberately does not.
       *
       * And with no Google or OIDC door, a newcomer cannot sign in either: the
       * password form is the only way in and they have no password. Both are
       * told what does work — a link from Settings, or, for somebody whose
       * private records mean no other member may make them one, the server
       * command.
       */
      const needsLink = needsPasswordLink(db, config, member.id);
      const linkWay = setupLinkBlocker(db, a.member.id, member.id) === null
        ? "make them a password link from the Household list"
        : `whoever runs the server can make them a password link with ${serverCommandFor(member.email)}`;
      return {
        redirect: "/settings",
        message: returning
          ? `${member.name} is back in the household. Their old password was ` +
            `cleared when they were removed, so they will need a new one` +
            (needsLink ? `: ${linkWay}.` : `.`)
          : needsLink
            ? `${member.email} is on the allow-list. They have no password yet, so ${linkWay}.`
            : `${member.email} can now sign in.`,
      };
    });
  });

  /*
   * A one-time link that sets another member's first password
   * (src/auth/setup-links.ts has who may make one for whom, and why).
   *
   * Rendered rather than redirected, for the reason /tokens is: a redirect
   * would carry the link in a URL — the Location header, the notice, the
   * history — and this page is the one place it is shown. Not through mutate
   * or once, either: both remember a request's answer to replay it, and the
   * answer here is a working credential that must not be kept anywhere.
   */
  router.post("/members/:id/password-link", (ctx) => {
    refuseInDemo(config, "Making password links");
    const a = auth(ctx);
    /*
     * Not while viewing as somebody. The link would be made by whoever is at
     * the keyboard, against rules checked as them — and viewing as another
     * member is exactly how somebody comes to be looking at their records.
     */
    if (a.impersonating) {
      throw new HttpError(403, "A password link cannot be made while viewing as another member.");
    }
    if (!passwordSignInOffered(db, config)) throw new NotFound();

    const link = issueSetupLink(db, actorFor(a), ctx.params.id!, a.member.id);
    const name = getMember(db, ctx.params.id!)!.name;
    const url = `${config.baseUrl}/auth/setup/${link.token}`;
    return {
      ...render(
        ctx,
        `A password link for ${name}`,
        html`
          <div class="prose-page">
            <p class="faint"><a href="/settings">← Settings</a></p>
            <h1>A password link for ${name}</h1>
            <p>
              Send this to ${name} however you usually would. Opening it lets
              them choose a password, and signs them in.
            </p>
            <section class="card">
              <p class="notice notice-warning">
                <strong>Copy it now.</strong> Only a hash of it is kept, so this
                page is the only time it is shown. If it is lost, make another —
                that one replaces this. Reloading this page makes another too, and
                stops this one working.
              </p>
              <pre class="raw-block" style="user-select:all;white-space:pre-wrap;word-break:break-all">${url}</pre>
              <p>
                It works once, and stops working at
                ${formatDateTime(link.expiresAt)} IST if nobody has used it by then.
              </p>
            </section>
            <p class="faint">
              Whoever has this link can set ${name}'s password, so send it only
              to them.
            </p>
          </div>
        `,
      ),
      headers: { "Cache-Control": "no-store, private" },
    };
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
    /*
     * WEALTH-40 · What is left of this charge to convert. The form stayed on the
     * page after a conversion, inviting the same purchase onto a second plan;
     * once all of it is on one, the page says so and links to it instead.
     */
    const convertedAlready = convertedFrom(db, transaction.id);
    const convertLeft = config.features.loans && account.kind === "credit" && transaction.amount < 0 && !transaction.transfer_pair_id
      ? Math.abs(transaction.amount) - convertedAlready
      : 0;
    const plans = convertedAlready > 0
      ? queryAll<{ id: string; nickname: string | null; lender: string }>(
          db, `SELECT id, nickname, lender FROM loans WHERE converted_from_transaction_id = ?`, transaction.id,
        )
      : [];
    const categoryName = new Map(
      [...view.categories.values()].map((c) => [c.id, c.name]),
    );

    return render(
      ctx,
      "Transaction",
      html`
        <div class="row-between" style="align-items:flex-start">
          <div>
            <h1 style="margin-bottom:.15rem">${formatPaise(Math.abs(transaction.amount))}</h1>
            <p class="muted" style="margin:0">
              ${account.nickname || account.name} · ${formatDate(transaction.date)}
            </p>
          </div>
          <!--
            06 §7.4 · A button, not a disclosure. Converting is a thing the bank
            offers and the household decides in the moment; hiding it behind a
            summary line is how the account edit form and the loan holder control
            both ended up reported as missing.
          -->
          ${when(convertLeft > 0, () => html`
            <a class="button button-primary" href="#emi">Convert to EMI</a>
          `)}
        </div>

        ${when(plans.length > 0, () => html`
          <p class="muted">
            ${formatPaise(convertedAlready)} of this is on an EMI plan:
            ${plans.map((p, i) => html`${i > 0 ? ", " : ""}${config.features.loans
              ? html`<a href="/loans/${p.id}">${p.nickname || p.lender}</a>`
              : p.nickname || p.lender}`)}.
          </p>
        `)}

        ${when(convertLeft > 0, () => html`
          <details class="card" id="emi">
            <summary class="linkish">The bank offered to convert this to EMI</summary>
            <p class="muted" style="margin-top:.75rem">
              The converted amount comes off this card's balance and becomes a loan
              with its own instalments — so you are not asked to clear it here
              <em>and</em> pay it monthly. The processing fee is charged to the card
              like any purchase, so give it an envelope. Each instalment also carries
              ${GST_PCT}% GST on its interest, which the plan's envelope pays.
            </p>
            <form method="post" action="/transaction/${transaction.id}/convert-to-emi">
              <div class="grid-2">
                <div class="field">
                  <label for="emi-amount">How much of it</label>
                  <input id="emi-amount" name="amount" class="amount-input" type="text"
                         inputmode="decimal"
                         value="${(convertLeft / 100).toFixed(2)}">
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
                    .filter((c) => !c.isPaymentCategory && !c.commitsToBudgetId && !c.hidden)
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
            ${when(!transaction.transfer_pair_id, () => html`
              <div class="field">
                <label for="t-direction">Direction</label>
                <select id="t-direction" name="direction">
                  <option value="out" ${raw(transaction.amount < 0 ? "selected" : "")}>Money out</option>
                  <option value="in" ${raw(transaction.amount >= 0 ? "selected" : "")}>Money in</option>
                </select>
              </div>
            `)}
          </div>

          <!--
            One side of a transfer has no direction to choose and no envelope:
            the money moved between the household's own accounts. Changing the
            amount or date here changes both sides together.
          -->
          ${when(transaction.transfer_pair_id !== null, () => html`
            <p class="field-hint">
              This is one side of a transfer. Changing the amount or date changes
              both sides; it has no envelope because nothing was spent.
            </p>
          `)}
          ${when(!transaction.transfer_pair_id, () => renderCategoryLines({
            label: "Envelope",
            categories: [...view.categories.values()]
              .filter((c) => !c.isPaymentCategory && !c.commitsToBudgetId && !c.hidden)
              .map((c) => ({ id: c.id, name: c.name })),
            values: splits.length > 0
              ? splits.map((sp) => ({ categoryId: sp.category_id, amount: sp.amount as Paise }))
              : [{ categoryId: transaction.category_id, amount: null }],
            /*
             * Never fewer lines than the transaction already has. The default
             * three is right for splitting something new, but rendering a
             * five-way split into four boxes would drop the last one — and
             * saving the form would then delete it.
             */
            extraLines: Math.max(3, splits.length - 1),
            hint: html`
              The first envelope takes whatever the extra lines do not claim,
              so it never has to be worked out.
            `,
          }))}

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

          <!-- Each marker tells the handler its checkbox was on the form, since
               an unchecked box sends nothing at all — and a post that sends
               neither (an API caller moving a date) leaves the flag alone. -->
          <div class="field">
            <label>
              <input type="hidden" name="cleared_present" value="1">
              <input type="checkbox" name="cleared" value="1"
                     ${raw(transaction.cleared ? "checked" : "")}> Cleared the bank
            </label>
            <label>
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

        ${when(config.features.attachments, () => html`
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
          ${when(!config.demoMode, () => html`
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
          `)}
          ${when(config.demoMode, () => html`
            <p class="faint" style="margin-top:.6rem">
              Attaching receipts is turned off here — a public demo should not
              hold files people upload. It works on your own copy.
            </p>
          `)}
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
                    ${formatDate(e.at.slice(0, 10))} · ${memberName(e.actorMemberId)}
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
    /*
     * WEB-3 · On the demo anyone is signed in, and each receipt is up to 10 MB
     * kept in the demo's database on a small disk, with nothing capping the
     * total until the next restart. Same shape as SECURITY-OPS-24 (backups).
     */
    refuseInDemo(config, "Attaching receipts");
    const id = requireLiveTransaction(ctx, ctx.params.id!).id;
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
    const transaction = requireLiveTransaction(ctx, id);

    const dateRaw = field(ctx.body, "date");
    /*
     * Blank keeps the date it had; anything else has to read as one. A typo
     * ("31-02-2026") used to fall back to the old date too, and the page said
     * "Saved." over an edit that had quietly dropped the change asked for.
     */
    const newDate = dateRaw?.trim() ? dateField(dateRaw) : transaction.date;
    const confirmed = field(ctx.body, "confirm_checkpoint") === "1";

    /*
     * One side of a transfer. Its amount and date are shared with the other
     * side and move with it (updateTransaction does that); it has no direction
     * of its own to choose and no envelope to be filed to. See the comment in
     * updateTransaction for what editing one side alone used to do.
     */
    const partner = transaction.transfer_pair_id
      ? queryOne<{ account_id: string; date: string }>(
        db, `SELECT account_id, date FROM transactions WHERE transfer_pair_id = ? AND id <> ?`,
        transaction.transfer_pair_id, id,
      )
      : null;
    const isTransferLeg = transaction.transfer_pair_id !== null;

    // R7.b: guard against *both* dates — moving a transaction out of a
    // reconciled period falsifies that period just as much as moving one in.
    // A transfer's date and amount move on both accounts, so when either
    // changes the other side is guarded too — from its own date, which an
    // imported transfer's two statements need not share with this leg.
    const amountRaw = field(ctx.body, "amount");
    const partnerMoves = partner !== null && (
      newDate !== transaction.date ||
      (amountRaw !== undefined && amountRaw.trim() !== "" &&
        Math.abs(amountField(amountRaw)) !== Math.abs(transaction.amount))
    );
    const sides = [
      { accountId: transaction.account_id, from: transaction.date },
      ...(partner && partnerMoves ? [{ accountId: partner.account_id, from: partner.date }] : []),
    ];
    for (const side of sides) {
      const guard = guardCheckpoints(
        ctx, a, side.accountId, [side.from, newDate], confirmed,
        `/transaction/${id}`, `/transaction/${id}`,
      );
      if (guard) return guard;
    }

    // MONEY-CORE-14 · Past the guards, a retry replays rather than re-saves.
    return once(ctx, a, () => {
      // D7 · No amount field at all keeps the amount; a blank box is still refused.
      const magnitude = amountRaw === undefined
        ? Math.abs(transaction.amount)
        : Math.abs(amountField(amountRaw));
      const actor = actorFor(a, "ui", ctx.req.headers["idempotency-key"] as string);
      /*
       * A post that does not say which way the money went keeps the way it
       * went. Reading silence as "out" — /add's default — turned a ₹50,000
       * salary credit into ₹50,000 of spending, with no envelope, under
       * "Saved.", when an API caller only moved its date. Silence about tags
       * and envelopes already leaves those alone.
       */
      const direction = field(ctx.body, "direction");
      const signed = isTransferLeg || (direction !== "in" && direction !== "out")
        ? (transaction.amount < 0 ? -magnitude : magnitude)
        : direction === "in" ? magnitude : -magnitude;

      // L1 · A renamed payee is the signal. Resolved here so the rename and the
      // rest of the edit land in one update, and so the *old* name is still
      // readable when we decide whether anything actually changed.
      //
      // A payee that is not sent is kept; one sent empty is taken off, the way
      // an empty memo is. Reading blank as "keep" left no way to remove a
      // payee at all: the form saved, said "Saved.", and the name stayed.
      const payeeRaw = field(ctx.body, "payee");
      const newPayee = (payeeRaw ?? "").trim();
      const previousPayee = transaction.payee_id ? getPayee(db, transaction.payee_id)?.name ?? null : null;
      const renamed = newPayee !== "" && newPayee !== previousPayee;
      const removed = payeeRaw !== undefined && newPayee === "" && transaction.payee_id !== null;
      const payeeId = renamed
        ? resolvePayee(db, actor, newPayee, transaction.raw_narration).id
        : removed ? null : undefined;

      /*
       * F4.3 · Split lines from the form. Each filled line is an envelope and an
       * unsigned amount; the sign follows the transaction's direction. The form
       * that edits a record must carry all of it — this form once knew nothing
       * of splits, so saving any split transaction silently flattened it.
       */
      /*
       * Envelope lines. The first carries no amount and takes whatever the others
       * leave, so nothing here can fail to reconcile — see resolveCategoryLines.
       */
      const lineValues: { categoryId: string | null; amount: Paise | null }[] = [];
      for (let i = 0; i < (isTransferLeg ? 0 : 25); i++) {
        const cat = field(ctx.body, `split_category_${i}`);
        const amt = field(ctx.body, `split_amount_${i}`);
        if (cat === undefined && amt === undefined) continue;
        /*
         * An empty *first* select is an instruction — "this has no envelope" —
         * and the form always sends it. Skipping it the way a blank later line is
         * skipped would make clearing the envelope a silent no-op that still
         * reports "saved", and would leave income that was once filed somewhere
         * with no way back to ready-to-assign.
         */
        if (i > 0 && !cat && !amt?.trim()) continue;
        const magnitudeOfLine = amt?.trim() ? Math.abs(amountField(amt)) : null;
        lineValues.push({
          categoryId: cat ? requireVisibleCategory(ctx, cat) : null,
          amount: i === 0 || magnitudeOfLine === null
            ? null
            : ((signed < 0 ? -magnitudeOfLine : magnitudeOfLine) as Paise),
        });
      }

      /*
       * A caller still posting the old field is honoured — but an *empty* one on
       * a transaction that is already split means "I am not saying anything about
       * envelopes", not "file it nowhere". The old form always sent the field,
       * empty or not, so reading a blank as an instruction would wipe the split
       * off every save that only changed a memo.
       */
      if (lineValues.length === 0 && !isTransferLeg) {
        const legacy = field(ctx.body, "category_id");
        const meaningful = legacy !== undefined && (legacy !== "" || transaction.is_split !== 1);
        if (meaningful) {
          lineValues.push({ categoryId: legacy ? requireVisibleCategory(ctx, legacy) : null, amount: null });
        }
      }

      const filed = lineValues.length > 0
        ? resolveCategoryLines(signed, lineValues)
        : null;

      /*
       * B99 against the lines, not only the single-envelope case — an entry that
       * is split still has a blank first line available, and blank means no
       * envelope. See outgoingLacksEnvelope.
       */
      if (filed !== null && outgoingLacksEnvelope(signed, filed)) {
        throw new HttpError(
          400,
          "One of those envelope lines is blank, so part of this would be spending " +
          "with no envelope behind it. Money in doesn't need one — money out does.",
        );
      }

      /*
       * Nothing about envelopes was posted at all — a form that carries only the
       * amount, or an API caller changing a date. Leave what is filed alone
       * rather than reading silence as "make it uncategorised".
       */
      const keepSplit = filed === null;
      // Only a split can fall out of step with a new amount; an unsplit
      // transaction (or a transfer leg) keeps its filing and is fine.
      if (keepSplit && transaction.is_split === 1 && signed !== transaction.amount) {
        throw new HttpError(
          400,
          "This transaction is split, and the lines no longer add up to the new amount. " +
            "Change the split lines to match, or file it to one envelope.",
        );
      }

      const tagsRaw = field(ctx.body, "tags");
      const ownerRaw = field(ctx.body, "owner_member_id");
      if (ownerRaw) requireMember(ctx, ownerRaw);

      /*
       * D7 · A field the post does not carry keeps what it had. Reading a
       * missing memo as "emptied" and a missing `cleared` as "unticked" meant
       * an API caller that only moved a date wiped the memo and un-cleared the
       * entry, under "Saved.". The form always sends the memo box (an empty
       * one still clears it), and a `<name>_present` marker beside each
       * checkbox, because an unticked box sends nothing — so the marker is
       * what turns silence into "unticked". A caller that sends the field
       * itself ("1" or anything else) is heard without the marker.
       */
      const memoRaw = field(ctx.body, "memo");
      const checkbox = (name: string): boolean | undefined => {
        const value = field(ctx.body, name);
        if (value !== undefined) return value === "1";
        return field(ctx.body, `${name}_present`) === "1" ? false : undefined;
      };
      const cleared = checkbox("cleared");
      const reimbursable = checkbox("reimbursable");

      // Guard the earlier of the two dates: moving a transaction backwards means
      // the ripple starts where it lands, not where it was.
      const rippleFrom = monthOf(newDate < transaction.date ? newDate : transaction.date);
      const { recompute } = breakGuardedCheckpoints(ctx, a, () => withForwardRecompute(
          db, actor, { month: rippleFrom, cause: "Edited a transaction" },
          () =>
            updateTransaction(db, actor, id, {
            amount: signed,
            date: newDate,
            ...(keepSplit
              ? {}
              : filed!.splits
                ? { splits: filed!.splits }
                // One line: it stops being a split and becomes that envelope.
                : { splits: null, categoryId: filed!.categoryId }),
            ...(memoRaw !== undefined ? { memo: memoRaw || null } : {}),
            ...(cleared !== undefined ? { cleared } : {}),
            ...(tagsRaw !== undefined
              ? { tags: tagsRaw.split(",").map((t) => t.trim()).filter(Boolean) }
              : {}),
            ...(ownerRaw !== undefined ? { ownerMemberId: ownerRaw || null } : {}),
            ...(reimbursable !== undefined ? { reimbursable } : {}),
            ...(payeeId !== undefined ? { payeeId } : {}),
          }),
      ));

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
      const transaction = requireLiveTransaction(ctx, id);

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
      const id = requireLiveTransaction(ctx, ctx.params.id!).id;
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
    /*
     * MONEY-CORE-7 · Deleting a transfer leg deletes both (deleteTransaction),
     * so both accounts' checkpoints are at stake, as they are for an edit.
     * Guarding only this leg's account let a transfer deleted from its
     * unreconciled side take ₹3,000 out of the other account's reconciled
     * period with no confirmation and the checkpoint left intact.
     */
    /*
     * Each side from its own date: an imported transfer's legs are dated by
     * their own statements, so the other leg can sit inside its account's
     * reconciled period while this one falls after it.
     */
    const partner = transaction.transfer_pair_id
      ? queryOne<{ account_id: string; date: string }>(
        db, `SELECT account_id, date FROM transactions WHERE transfer_pair_id = ? AND id <> ? AND deleted_at IS NULL`,
        transaction.transfer_pair_id, id,
      )
      : null;
    const sides = [
      { accountId: transaction.account_id, date: transaction.date },
      ...(partner ? [{ accountId: partner.account_id, date: partner.date }] : []),
    ];
    for (const { accountId, date } of sides) {
      const guard = guardCheckpoints(
        ctx, a, accountId, [date], confirmed,
        `/transaction/${id}/delete`, `/transaction/${id}`,
      );
      if (guard) return guard;
    }

    // MONEY-CORE-14 · A retry replays the first answer rather than deleting twice.
    return once(ctx, a, () => {
      const actor = actorFor(a, "ui", ctx.req.headers["idempotency-key"] as string);
      const { recompute } = breakGuardedCheckpoints(ctx, a, () => withForwardRecompute(
        db, actor, { month: monthOf(transaction.date), cause: "Deleted a transaction" },
        () => deleteTransaction(db, actor, id),
      ));
      return {
        redirect: withNotice(
          `/accounts/${transaction.account_id}`,
          "Deleted. You can restore it for the next 30 days." + rippleNote(recompute),
        ),
      };
    });
  });

  /**
   * R7.b–R7.c in one place: demand a confirmation naming the checkpoint, then
   * break it. Returns a Response to render the confirmation, or null to carry
   * on with the edit.
   */
  function guardCheckpoints(
    ctx: RequestContext, a: AuthContext, accountId: string, dates: string[],
    confirmed: boolean, action: string, cancelHref: string,
    /**
     * False where the domain breaks them itself, inside the change's own
     * transaction — the import paths — so a change that is then refused does
     * not leave a checkpoint broken for nothing.
     */
    breakHere = true,
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

    /*
     * R7.c/R7.e: mark them broken, with both values in the log. R7.f: they are
     * never repaired — only a fresh reconciliation asserts the balance again.
     *
     * Not here, though: once the change has been made (breakGuardedCheckpoints,
     * in the change's own transaction). Breaking them on the way past meant a
     * confirmed edit that was then refused — split lines over the total, a
     * blank envelope on spending, a load-bearing delete — left the checkpoint
     * broken over a balance nothing had changed, and Review asking the
     * household to reconcile again for no reason.
     */
    if (breakHere) {
      const pending = pendingCheckpointBreaks.get(ctx) ?? new Map<string, Checkpoint>();
      for (const [id, c] of affected) pending.set(id, c);
      pendingCheckpointBreaks.set(ctx, pending);
    }
    return null;
  }

  /** What guardCheckpoints was told to break, per request, until the change lands. */
  const pendingCheckpointBreaks = new WeakMap<RequestContext, Map<string, Checkpoint>>();

  /**
   * Make the change and break the checkpoints its guard confirmed, together or
   * not at all. Call inside the idempotent section, so a replay breaks nothing.
   */
  function breakGuardedCheckpoints<T>(ctx: RequestContext, a: AuthContext, change: () => T): T {
    return transact(db, () => {
      const result = change();
      const pending = pendingCheckpointBreaks.get(ctx);
      pendingCheckpointBreaks.delete(ctx);
      if (pending?.size) {
        breakCheckpoints(db, actorFor(a), [...pending.values()], `a transaction dated on or before it was changed`);
      }
      return result;
    });
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
    // 15 · Signed in first, then visible: this route wrote a checkpoint into
    // any account by id, and its "difference" page printed the private
    // account's cleared balance back to whoever asked.
    const a = auth(ctx);
    const account = requireVisibleAccount(ctx, ctx.params.id!);

    const asOfRaw = field(ctx.body, "as_of");
    const asOf = dateField(asOfRaw, "As of");
    const bankBalance = amountField(field(ctx.body, "bank_balance"), "The bank's balance");
    const clearIds = fieldList(ctx.body, "clear");
    const allowAdjustment = field(ctx.body, "allow_adjustment") === "1";

    // MONEY-CORE-14 · What happened is kept against the key, and a retry is
    // shown that again rather than recording a second checkpoint.
    const outcome = once(ctx, a, () => {
      const result = reconcile(db, actorFor(a, "ui", ctx.req.headers["idempotency-key"] as string), {
        accountId: account.id,
        bankBalance,
        asOf,
        clearTransactionIds: clearIds,
        allowAdjustment,
      });
      return result.status === "needs-decision"
        ? { checkpointId: null, adjustment: 0 }
        : { checkpointId: result.checkpoint.id, adjustment: result.adjustment };
    });
    const checkpoint = outcome.checkpointId
      ? queryOne<Checkpoint>(db, `SELECT * FROM reconciliations WHERE id = ?`, outcome.checkpointId)
      : null;

    if (!checkpoint) {
      // F9.2: never guess. Show the difference and the uncleared list, and let
      // the user pick one of the three options.
      return render(
        ctx,
        `Reconcile ${account.name}`,
        renderReconcileDifference({
          account, preview: previewReconciliation(db, account.id, bankBalance, asOf),
        }),
      );
    }

    return render(
      ctx,
      "Reconciled",
      renderReconcileDone({ account, checkpoint, adjustment: outcome.adjustment }),
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
      const account = requireVisibleAccount(ctx, ctx.params.id!);
      const last4 = last4Field(field(ctx.body, "last4")) ?? null;
      createCard(db, actorFor(a), {
        accountId: account.id,
        label: requiredField(ctx.body, "label"),
        last4,
        isPrimary: false,
        holderMemberId: guardedField(ctx, "holder_member_id", requireMember),
      });
      return { redirect: `/accounts/${account.id}/cards`, message: "Card added." };
    }),
  );

  router.post("/accounts/:id/cards/:cardId/close", (ctx) =>
    mutate(ctx, (a) => {
      /*
       * 15 · The card is checked, not only the account in the URL. This took
       * any visible account id and then closed whatever card id followed it —
       * so Priya closed Ravi's private add-on card through the household's
       * joint account. The card has to be visible *and* be on that account.
       */
      const account = requireVisibleAccount(ctx, ctx.params.id!);
      const cardId = requireVisibleIn(ctx, "cards", ctx.params.cardId!);
      const onAccount = queryOne(db, `SELECT 1 AS n FROM cards WHERE id = ? AND account_id = ?`, cardId, account.id);
      if (!onAccount) throw new NotFound("That card does not exist.");
      closeCard(db, actorFor(a), cardId);
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
    const cards: CardDue[] = cardsDue(db, { month, budgetId: scope, viewerMemberId: viewer(ctx) });

    return render(ctx, "Cards", renderCards({ cards, month }));
  });

  router.get("/accounts/:id/statement", (ctx) => {
    auth(ctx);
    const account = requireVisibleAccount(ctx, ctx.params.id!);
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
      const account = requireVisibleAccount(ctx, ctx.params.id!);
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
    const outstanding = creditOutstanding(db, month);
    /*
     * 15 · The queue's own lists read the whole household: another member's
     * unfiled spending, reimbursable claims and broken checkpoints on their
     * private account, by payee and account name. The same rule as everywhere
     * else, from the one place it is written down.
     */
    const reviewHidden = hiddenTransactionSql("t", viewer(ctx));
    /*
     * And the envelope a payee "usually" goes to is the reader's usual, as it
     * is on /add. Counted over the household, a payee Ravi files privately
     * more often than Priya files it anywhere came out as his envelope, which
     * the page rightly would not name, so Priya got no suggestion at all.
     */
    const usualHidden = hiddenTransactionSql("prev", viewer(ctx));
    const reviewHiddenAccount = hiddenAccountSql("a", viewer(ctx));

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
        staged: listStaged(db, { viewerMemberId: viewer(ctx) }),
        transferAccounts: listAccounts(db, { viewerMemberId: viewer(ctx) })
          .filter((acc) => !DERIVED_VALUE_SUBTYPES.has(acc.subtype))
          .map((acc) => ({ id: acc.id, name: acc.name })),
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
                      AND prev.deleted_at IS NULL AND NOT ${usualHidden.sql}
                    GROUP BY prev.category_id
                    ORDER BY COUNT(*) DESC, MAX(prev.date) DESC
                    LIMIT 1) AS usual_category_id
             FROM transactions t
             JOIN accounts a ON a.id = t.account_id
             LEFT JOIN payees p ON p.id = t.payee_id
            WHERE t.deleted_at IS NULL AND t.is_split = 0 AND t.category_id IS NULL
              AND t.transfer_pair_id IS NULL AND a.kind != 'tracking'
              AND t.amount < 0 AND NOT ${reviewHidden.sql}
            ORDER BY t.date DESC LIMIT ?`,
          ...usualHidden.params, ...reviewHidden.params, UNCATEGORISED_PAGE,
        ),
        uncategorisedTotal: queryOne<{ n: number }>(
          db,
          `SELECT COUNT(*) AS n FROM transactions t
             JOIN accounts a ON a.id = t.account_id
            WHERE t.deleted_at IS NULL AND t.is_split = 0 AND t.category_id IS NULL
              AND t.transfer_pair_id IS NULL AND a.kind != 'tracking'
              AND t.amount < 0 AND NOT ${reviewHidden.sql}`,
          ...reviewHidden.params,
        )?.n ?? 0,
        claims: outstandingReimbursements(db, viewer(ctx)),
        overspent: view.overspentCategories,
        unfundedCards,
        brokenCheckpoints: queryAll<{
          accountId: string; name: string; asOf: string; reason: string | null;
        }>(
          db,
          `SELECT r.account_id AS accountId, a.name AS name, r.as_of AS asOf,
                  r.broken_reason AS reason
             FROM reconciliations r JOIN accounts a ON a.id = r.account_id
            WHERE r.broken_at IS NOT NULL AND NOT ${reviewHiddenAccount.sql}
            ORDER BY r.as_of DESC`,
          ...reviewHiddenAccount.params,
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
        // PLAN-1 · Without the rules module there is nowhere to confirm one to.
        proposedRules: !config.features.rules ? [] : queryAll<{
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
        // AIW · Only the reader's own connections' (see pendingSuggestions).
        aiSuggestions: aiEnabled
          ? pendingSuggestions(db, viewer(ctx)).map((r) => ({
            id: r.id, app: r.token_name, summary: r.summary, why: r.why, at: r.created_at,
          }))
          : [],
      }),
    );
  });

  /*
   * AIW · A member deciding on what their AI suggested. Approving makes the
   * change as them, through the same domain function the direct path uses,
   * checked again against what they can see now; a refusal leaves it waiting,
   * with the reason, so it can be rejected instead.
   */
  router.post("/review/ai/:id/approve", (ctx) => {
    if (!aiEnabled) throw new NotFound();
    return mutate(ctx, (a) => {
      if (a.impersonating) throw new HttpError(403, "A suggestion is decided by the member it was made for.");
      const done = approveSuggestion(db, a.member.id, ctx.params.id!);
      return { redirect: "/review", message: `Done: ${done.summary}. Undo it in Activity if that was wrong.` };
    });
  });

  router.post("/review/ai/:id/reject", (ctx) => {
    if (!aiEnabled) throw new NotFound();
    return mutate(ctx, (a) => {
      if (a.impersonating) throw new HttpError(403, "A suggestion is decided by the member it was made for.");
      rejectSuggestion(db, a.member.id, ctx.params.id!);
      pruneSuggestions(db);
      return { redirect: "/review", message: "Rejected. Nothing was changed." };
    });
  });

  /*
   * R7.b · Approving or merging an imported row dated on or before a
   * reconciliation changes the balance it confirmed; undoing an import removes
   * from it. Each asks first, naming the checkpoint, as deleting one
   * transaction always has. The pipeline marks it broken in the same
   * transaction as the change.
   */
  function confirmImportCheckpoints(
    ctx: RequestContext, a: AuthContext, dates: Map<string, string[]>, action: string, cancelHref: string,
  ): Response | null {
    const confirmed = field(ctx.body, "confirm_checkpoint") === "1";
    for (const [accountId, list] of dates) {
      const guard = guardCheckpoints(ctx, a, accountId, list, confirmed, action, cancelHref, false);
      if (guard) return guard;
    }
    return null;
  }

  function stagedCheckpointDates(stagedId: string, merging: boolean): Map<string, string[]> {
    const row = queryOne<{ account_id: string; date: string; status: string; duplicate_of_id: string | null }>(
      db, `SELECT account_id, date, status, duplicate_of_id FROM staged_transactions WHERE id = ?`, stagedId,
    );
    if (!row || row.status !== "pending") return new Map();
    if (!merging) return new Map([[row.account_id, [row.date]]]);
    // A merge moves nothing but the cleared flag, so only an uncleared target counts.
    const target = row.duplicate_of_id
      ? queryOne<{ account_id: string; date: string }>(
        db, `SELECT account_id, date FROM transactions WHERE id = ? AND cleared = 0 AND deleted_at IS NULL`,
        row.duplicate_of_id,
      )
      : null;
    return target ? new Map([[target.account_id, [target.date]]]) : new Map();
  }

  router.post("/review/approve", (ctx) => {
    const guard = confirmImportCheckpoints(
      ctx, auth(ctx),
      stagedCheckpointDates(requireVisibleStaged(ctx, requiredField(ctx.body, "staged_id")), false),
      "/review/approve", "/review",
    );
    if (guard) return guard;
    return mutate(ctx, (a) => {
      /*
       * IMPORTS-SCHEDULES-32 · "Transfer to/from <account>" in the envelope
       * list: money moved between the household's own accounts, recorded as
       * the pair it is rather than as spending on one side and new money on
       * the other.
       */
      const choice = field(ctx.body, "category_id") ?? "";
      if (choice.startsWith("transfer:")) {
        const other = requireVisibleAccount(ctx, choice.slice("transfer:".length));
        const result = approveStagedAsTransfer(
          db, actorFor(a, "ui", ctx.req.headers["idempotency-key"] as string),
          requireVisibleStaged(ctx, requiredField(ctx.body, "staged_id")), other.id,
        );
        return {
          redirect: "/review",
          message: result.pairedWith
            ? `Recorded as a transfer with ${other.name}, matched with its own imported row.`
            : `Recorded as a transfer with ${other.name}.`,
        };
      }

      /*
       * B99 · Approving is what puts a row in the ledger, so it is the same
       * rule as manual entry: an expense names its envelope, income does not
       * have to. Refusing here rather than at import is deliberate — the queue
       * is exactly where an unfiled row is supposed to wait.
       */
      approveStaged(db, actorFor(a, "ui", ctx.req.headers["idempotency-key"] as string),
        requireVisibleStaged(ctx, requiredField(ctx.body, "staged_id")),
        {
          categoryId: requireVisibleCategory(ctx, field(ctx.body, "category_id") || null) || null,
          // IMPORT-1 · A proposed split's lines, only into envelopes this person may see.
          mayUseCategory: (id) =>
            listCategories(db, { includeHidden: true, viewerMemberId: viewer(ctx) }).some((c) => c.id === id),
        },
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
    });
  });

  router.post("/review/reject", (ctx) =>
    mutate(ctx, (a) => {
      rejectStaged(db, actorFor(a, "ui", ctx.req.headers["idempotency-key"] as string),
        requireVisibleStaged(ctx, requiredField(ctx.body, "staged_id")));
      return { redirect: "/review", message: "Dismissed." };
    }),
  );

  router.post("/review/merge", (ctx) => {
    const guard = confirmImportCheckpoints(
      ctx, auth(ctx),
      stagedCheckpointDates(requireVisibleStaged(ctx, requiredField(ctx.body, "staged_id")), true),
      "/review/merge", "/review",
    );
    if (guard) return guard;
    return mutate(ctx, (a) => {
      mergeStaged(db, actorFor(a, "ui", ctx.req.headers["idempotency-key"] as string),
        requireVisibleStaged(ctx, requiredField(ctx.body, "staged_id")));
      return { redirect: "/review", message: "Merged into the transaction you already had." };
    });
  });

  // -------------------------------------------------------------------------
  // S10 · Import
  // -------------------------------------------------------------------------
  function importPage(
    ctx: RequestContext, error: string | null = null,
    pdf: { accountId: string; askDigits: 4 | 6; error: string } | null = null,
  ) {
    return render(ctx, "Import", renderImport({
      accounts: listAccounts(db, { viewerMemberId: viewer(ctx) }),
      batches: listBatches(db, { viewerMemberId: viewer(ctx) }),
      profiles: visibleProfiles(ctx).map((p) => ({
        id: p.id, name: p.name, last_used_at: p.last_used_at,
      })),
      casEnabled: config.features.assets,
      ways: {
        csv: config.features.importCsv,
        pdf: config.features.importPdf,
        budgetApp: config.features.importBudgetApp,
      },
      banks: BANKS.map((b) => ({ id: b.id, name: b.name, passwordHint: b.passwordHint })),
      error,
      pdf,
    }));
  }

  router.get("/import", (ctx) => importPage(ctx));

  router.post("/import", (ctx) => {
    const accountId = requireVisibleAccount(ctx, requiredField(ctx.body, "account_id")).id;
    /*
     * IMP-6 · A chosen file wins over the textarea. Its bytes are decoded
     * here by their byte-order mark, so Excel's UTF-16 "Unicode text" export
     * reads as well as a UTF-8 one; a file that is not UTF-8 at all still
     * imports, and the result says some characters were replaced.
     */
    const upload = fileField(ctx.req, "csv_file");
    const decoded = upload ? decodeCsvBytes(upload.bytes) : null;
    const text = decoded ? decoded.text : (field(ctx.body, "csv") ?? "");
    if (text.trim() === "") return importPage(ctx, "Paste the CSV or choose its file first.");
    const encodingNote = decoded?.fellBack
      ? "Some of the file was not UTF-8, so a few characters show as \uFFFD. Saving it from Excel as \u201cCSV UTF-8\u201d avoids that."
      : null;
    const fileName = field(ctx.body, "file_name") || upload?.filename || "pasted.csv";
    // An unknown account id reached the INSERT and failed its foreign key — a
    // 500 — and a private account of another member's was importable. Both
    // are the same question: can this viewer see the account?
    auth(ctx);
    requireVisibleAccount(ctx, accountId);

    /*
     * IMPORT-1 · An export from YNAB or Actual Budget, recognised by its
     * header. It covers every account the household had there, so the
     * account chosen on this form does not apply: the next step asks which
     * account each of the file's accounts is. Nothing is written yet.
     */
    const fromApp = parseBudgetApp(text);
    /*
     * PLAN-1 · The paste box is one door for two modules. Each kind of file is
     * refused here, by name, when its module is off — the page only offers the
     * box when one of them is on, and says which.
     */
    if (fromApp && !config.features.importBudgetApp) {
      return importPage(ctx, `Importing from ${BUDGET_APP_NAMES[fromApp.app]} is not available on this instance.`);
    }
    if (!fromApp && !config.features.importCsv) {
      return importPage(ctx, "Bank CSV import is not available on this instance.");
    }
    if (fromApp) return render(ctx, `Import from ${BUDGET_APP_NAMES[fromApp.app]}`, budgetAppPrompt(ctx, fromApp, text, fileName));

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
          accountId, fileName, csv: text, delimiter: delimiterName(detectDelimiter(text)),
          rows: recognition.rows,
          candidateHeaders: candidateHeaderRows(recognition.rows),
          headerRow,
          choices: columnChoices(recognition.rows, headerRow),
          note: encodingNote,
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

      // `staged` counts the auto-approved rows too, which are in the ledger,
      // not Review: "3 to review, 3 auto-approved" left nothing to review.
      const toReview = outcome.staged - outcome.autoApproved;
      const parts = [`${toReview} to review`];
      if (outcome.autoApproved) parts.push(`${outcome.autoApproved} auto-approved`);
      if (outcome.duplicates) parts.push(`${outcome.duplicates} possible duplicates`);
      if (outcome.skipped) parts.push(`${outcome.skipped} already present`);
      if (outcome.errors) parts.push(`${outcome.errors} rows I couldn't read`);

      return {
        redirect: toReview > 0 ? "/review" : "/import",
        message: `Read ${outcome.batch.rows_read} rows — ${parts.join(", ")}.` +
          (encodingNote ? ` ${encodingNote}` : ""),
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
    const accountId = requireVisibleAccount(ctx, requiredField(ctx.body, "account_id")).id;
    const upload = fileField(ctx.req, "statement");

    if (!upload) return importPage(ctx, "Choose the statement PDF first.");

    /*
     * A typed password wins; otherwise the stored identity derives candidates
     * (`10` §3.6). Typing one is still the path for a household that has not
     * opted in, and PR5's original shape — used once, never persisted — is
     * exactly what happens on that path.
     */
    const typed = field(ctx.body, "password") ?? "";
    const identity = getIdentity(db, a.member.id);
    /*
     * IMP-19 · The card's digits, typed on the form this route brings back
     * when they are what the bank's rule needs. Read here and never echoed:
     * a page that comes back has an empty box, and a notice shows the last two.
     */
    const typedDigits = (field(ctx.body, "card_digits") ?? "").replace(/[\s-]/g, "");

    let parsed;
    let opened = "";
    let savedDigits = "";
    /*
     * Which detail the bank's rule needs and this household has not saved.
     * Four institutions account for every statement a real corpus could not
     * open, and in every case the fix is one field — worth naming rather than
     * leaving somebody to conclude the file is simply unreadable.
     */
    let missing: string | null = null;
    /** IMP-19 · How many of the card's digits to ask for, when that is the fix. */
    let askDigits: 4 | 6 | null = null;
    let digitsFailed = false;
    const account = getAccount(db, accountId);
    try {
      if (typed !== "") {
        parsed = parseStatementPdf(upload.bytes, typed);
      } else if (identity) {
        // F2.9 · The destination account already stores the card/account's
        // last four digits (for SMS matching), which is exactly what Canara's
        // and SBI Card's passwords need. Hand them to the derivation.
        // The account knows its bank, so the bank's own rule is tried first.
        // detectBank cannot help here: the file is still locked.
        const bank = bankForInstitution(account?.institution);
        // IMP-18 · A card account may hold up to eight trailing digits.
        const cardDigits = [cardNumberDigits(db, accountId)];
        const isCard = account?.kind === "credit";
        const needed = isCard ? cardDigitsNeeded(bank, identity, cardDigits) : null;
        const tryDigits = needed && typedDigits !== "" ? typedDigits : null;
        if (tryDigits !== null && !/^\d{4,8}$/.test(tryDigits)) {
          askDigits = needed;
          digitsFailed = true;
          throw new StatementWrongPassword();
        }
        const withTyped = tryDigits ? [...cardDigits, tryDigits] : cardDigits;
        const result = openStatement(
          upload.bytes,
          passwordCandidates(identity, bank, { cardDigits: withTyped }),
        );
        if (!result) {
          missing = missingDetailFor(bank, identity, cardDigits);
          askDigits = needed;
          digitsFailed = tryDigits !== null;
          throw new StatementWrongPassword();
        }
        parsed = result.parse;
        opened = ` It opened with ${describeCandidate(result.candidate, identity)}.`;
        // Saved only when the typed digits are what opened it, and only when
        // they agree with the last four already on the card.
        const neededTyped = tryDigits !== null
          && !passwordCandidates(identity, bank, { cardDigits }).includes(result.candidate);
        if (neededTyped && tryDigits) {
          const name = account!.nickname || account!.name;
          if (account!.last4 && account!.last4 !== tryDigits.slice(-4)) {
            savedDigits = ` Those digits end differently from the last four recorded on ${name}, ` +
              "so they were not saved — check the account.";
          } else {
            setCardNumberDigits(db, actorFor(a, "ui"), accountId, tryDigits);
            savedDigits = ` The card's last ${tryDigits.length} digits (ending ••${tryDigits.slice(-2)}) ` +
              `are now saved on ${name}, so its next statement opens by itself.`;
          }
          opened = " It opened with the card's digits.";
        }
      } else {
        parsed = parseStatementPdf(upload.bytes, "");
      }
    } catch (error) {
      if (error instanceof StatementWrongPassword && askDigits) {
        const which = askDigits === 6 ? "last six" : "last four";
        return importPage(ctx, null, {
          accountId,
          askDigits,
          error: (digitsFailed
            ? `Those digits did not open it. Enter the card number's ${which} as printed on the ` +
              "card, or type the statement password."
            : `${missing ?? `This statement opens with the card number's ${which}.`} ` +
              `Enter the card number's ${which} below, or type the statement password.`) +
            " Choose the statement again too — a browser does not keep a chosen file between tries.",
        });
      }
      return importPage(ctx,
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

    // IMP-32 · A SafeGold statement is gold bought and sold, not this
    // account's rows: it goes to the same review its own upload does.
    if (isSafeGoldText(parsed.text)) {
      // REV-6 · With the assets module off there is no gold to confirm into.
      if (!config.features.assets) {
        return importPage(ctx,
          "That file is a SafeGold statement, not a bank or card statement, so " +
          "there are no transactions in it to import here.",
        );
      }
      return safeGoldReview(ctx, a.member.id, [parseSafeGoldText(parsed.text)]);
    }

    // A fund statement or an exchange report is not a bank account's rows, and
    // a mapping screen would invite the household to import it as one.
    if (parsed.notAStatement) {
      return importPage(ctx,
        `That file is ${parsed.notAStatement}, not a bank or card statement, so ` +
        "there are no transactions in it to import here.",
      );
    }

    // `04` §3.2's rule, applied to PDFs: a file this app cannot read is a
    // mapping task, not an error. The extracted rows go to the same screen an
    // unrecognised CSV goes to.
    if (parsed.records.length === 0) {
      const lines = parsed.text.split("\n");
      const loose = lines.map((line) => line.split(/\s{2,}/));

      // B64 · A mapping task needs columns to map. A scanned statement has
      // none, and the mapping screen would offer "Column 1" for every field
      // above a table of nothing. Say what is actually wrong instead.
      if (!looksMappable(loose)) {
        return importPage(ctx,
          "There is no text in that PDF to read — it is almost certainly a scan " +
          "or an image rather than a statement with selectable text. Ask the bank " +
          "for the text version (net banking usually offers one), or import the " +
          "CSV instead.",
        );
      }

      // The header row is found on the loose split; the cells are then cut
      // by position under it, so an empty Deposit stays an empty cell.
      const headerRow = candidateHeaderRows(loose)[0]?.index ?? 0;
      const rows = rowsByPosition(lines, headerRow);
      return render(
        ctx, "Which column is which?",
        renderMapping({
          accountId,
          fileName: upload.filename,
          csv: rows.map((r) => r.join("\t")).join("\n"),
          delimiter: "tab",
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
    const toReview = outcome.staged - outcome.autoApproved;
    if (toReview > 0) parts.push(`${toReview} to review`);
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
        toReview > 0 ? "/review" : "/import",
        `Read ${parsed.bank ? `your ${parsed.bank.name} statement` : "the statement"} — ` +
          `${parts.join(", ")}.${opened}${savedDigits}${reconciled}`,
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
      const accountId = requireVisibleAccount(ctx, requiredField(ctx.body, "account_id")).id;
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
        direction: pick("direction"),
        balance: pick("balance"),
        reference: pick("reference"),
      });

      const problem = validateMapping(mapping);
      if (problem) throw new HttpError(400, problem);

      const delimiter = MAPPING_DELIMITERS[field(ctx.body, "delimiter") ?? ""];
      const recognition = recognise(db, text, accountId, delimiter);

      /*
       * IMPORTS-SCHEDULES-30 · The order of day and month, as chosen — or,
       * left to the file, month first only when its dates prove it (a second
       * part over 12). A column that proves both ways is refused: whichever
       * reading was taken, some of its rows would land in the wrong month.
       */
      const dateFormat = field(ctx.body, "date_format") ?? "auto";
      if (dateFormat === "dd-mm-yyyy" || dateFormat === "mm-dd-yyyy" || dateFormat === "yyyy-mm-dd") {
        mapping.dateFormat = dateFormat;
      } else {
        const order = dateOrderOf(recognition.rows, mapping.headerRow, mapping.date);
        if (order === "mixed") {
          throw new HttpError(400,
            "Some dates in that column put the day first (13/09) and others the month (09/13), " +
            "so it is not clear which is which. Choose how the dates are written.");
        }
        if (order === "mm-dd-yyyy") mapping.dateFormat = order;
      }
      const result = parseWith(recognition.rows, mapping);

      // A mapping that read no transaction at all is not one to remember:
      // the next file like this would import the same nothing without asking.
      const worked = result.records.length > 0;
      if (worked) {
        saveProfile(db, actorFor(a), {
          name: requiredField(ctx.body, "profile_name"),
          accountId,
          headers: recognition.rows[mapping.headerRow] ?? [],
          mapping,
        });
      }

      const outcome = ingest(db, actorFor(a, "import"), {
        accountId, source: "csv", adapter: "csv", fileName,
        records: result.records, errors: result.errors, rowsRead: result.rowsRead,
      });

      return {
        redirect: outcome.staged > outcome.autoApproved ? "/review" : "/import",
        message: worked
          ? `Read ${outcome.batch.rows_read} rows, and remembered these columns — ` +
            `the next file like this will import without asking.`
          : `Read ${outcome.batch.rows_read} rows, but none came out as a transaction, ` +
            `so these columns were not remembered. The import history shows why each row was skipped.`,
      };
    }),
  );

  /** IMPORT-1 · The account step for a budgeting app's export. */
  function budgetAppPrompt(
    ctx: RequestContext, parse: BudgetAppParse, csv: string, fileName: string, error: string | null = null,
  ): SafeHtml {
    const accounts = listAccounts(db, { viewerMemberId: viewer(ctx) })
      .filter((acc) => !DERIVED_VALUE_SUBTYPES.has(acc.subtype));
    const fold = (s: string) => s.trim().toLowerCase();
    const rows = parseDelimited(csv, detectDelimiter(csv));
    const dateColumn = (rows[0] ?? []).findIndex((h) => fold(h) === "date");
    return renderBudgetAppMapping({
      appName: BUDGET_APP_NAMES[parse.app],
      fileName, csv,
      sources: parse.accounts.map((name) => ({
        name,
        rows: parse.accountRows[name] ?? 0,
        // Only an exact name: anything looser is the person's call.
        suggestedAccountId: accounts.find((acc) =>
          fold(acc.name) === fold(name) || (acc.nickname && fold(acc.nickname) === fold(name)))?.id ?? null,
      })),
      accounts: accounts.map((acc) => ({ id: acc.id, name: acc.nickname || acc.name })),
      needsDateOrder: parse.needsDateOrder,
      dateSamples: rows.slice(1, 4).map((r) => (r[dateColumn] ?? "").trim()).filter(Boolean),
      startingBalances: parse.startingBalances,
      error: error ?? parse.dateProblem,
    });
  }

  /**
   * IMPORT-1 · A YNAB or Actual Budget export, with the account each of its
   * accounts goes to. Every chosen account's rows go through `ingest()` as a
   * batch of their own, so each can be undone from the import log.
   */
  router.post("/import/budget-app", (ctx) => {
    const text = requiredField(ctx.body, "csv");
    const fileName = field(ctx.body, "file_name") || "budget-export.csv";
    const order = field(ctx.body, "date_order");
    const parse = parseBudgetApp(text, {
      dateOrder: order === "dd-mm-yyyy" || order === "mm-dd-yyyy" ? order : null,
    });
    if (!parse) throw new HttpError(400, "That is not an export from YNAB or Actual Budget.");
    if (parse.dateProblem) throw new HttpError(400, parse.dateProblem);
    if (parse.needsDateOrder) {
      throw new HttpError(400, "Every date in this file reads both ways round. Choose whether the day or the month comes first.");
    }

    const accounts = new Map<string, string>();
    parse.accounts.forEach((name, i) => {
      const choice = field(ctx.body, `account_${i}`) ?? "";
      if (choice === "") {
        throw new HttpError(400, `Choose an account for "${name}", or leave it out.`);
      }
      if (choice === "skip") return;
      accounts.set(name, requireVisibleAccount(ctx, choice).id);
    });
    if (accounts.size === 0) {
      return render(ctx, `Import from ${BUDGET_APP_NAMES[parse.app]}`,
        budgetAppPrompt(ctx, parse, text, fileName, "Every account was left out, so there was nothing to import."));
    }

    return mutate(ctx, (a) => {
      const { plan, outcomes } = importBudgetApp(
        db, actorFor(a, "import", ctx.req.headers["idempotency-key"] as string),
        { parse, accounts, viewerMemberId: viewer(ctx), fileName },
      );
      const sum = (pick: (o: (typeof outcomes)[number]) => number) => outcomes.reduce((s, o) => s + pick(o), 0);
      const toReview = sum((o) => o.staged - o.autoApproved);
      const parts = [`${toReview} to review`];
      if (plan.transfers) parts.push(`${plan.transfers} marked as transfers`);
      if (plan.splits) parts.push(`${plan.splits} splits`);
      if (plan.unmatched) parts.push(`${plan.unmatched} needing an envelope`);
      if (sum((o) => o.duplicates)) parts.push(`${sum((o) => o.duplicates)} possible duplicates`);
      if (sum((o) => o.skipped)) parts.push(`${sum((o) => o.skipped)} already present`);
      if (sum((o) => o.errors)) parts.push(`${sum((o) => o.errors)} rows I couldn't read`);
      return {
        redirect: toReview > 0 ? "/review" : "/import",
        message: `Read ${sum((o) => o.batch.rows_read)} rows from ${BUDGET_APP_NAMES[parse.app]} — ${parts.join(", ")}. ` +
          "Budget assignments were not imported.",
      };
    });
  });

  router.post("/import/profiles/:id/delete", (ctx) =>
    mutate(ctx, (a) => {
      deleteProfile(db, actorFor(a), requireVisibleImportProfile(ctx, ctx.params.id!));
      return { redirect: "/import", message: "Forgotten." };
    }),
  );

  router.post("/import/undo", (ctx) => {
    const guard = confirmImportCheckpoints(
      ctx, auth(ctx),
      batchUndoDates(db, requireVisibleBatch(ctx, requiredField(ctx.body, "batch_id"))),
      "/import/undo", "/import",
    );
    if (guard) return guard;
    return mutate(ctx, (a) => {
      const result = undoBatch(db, actorFor(a, "ui", ctx.req.headers["idempotency-key"] as string),
        requireVisibleBatch(ctx, requiredField(ctx.body, "batch_id")));
      return {
        redirect: "/import",
        message:
          `Removed ${result.removed} transactions` +
          (result.keptBecauseEdited.length
            ? `. ${result.keptBecauseEdited.length} had been edited since and were left alone`
            : "") +
          (result.keptBecauseOnStatement.length
            ? `. ${result.keptBecauseOnStatement.length} were also on a statement imported since and were kept`
            : "") +
          ".",
      };
    });
  });


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

      const holder = guardedField(ctx, "holder_member_id", requireMember);
      const visibility = field(ctx.body, "visibility") === "private" ? "private" : "household";
      // WEB-4 · WEB-1's rule at creation: private only to whoever adds it.
      refuseForeignPrivate(a, null, holder, visibility, "loan");

      const loan = createLoan(db, actorFor(a, "ui", ctx.req.headers["idempotency-key"] as string), {
        lender: requiredField(ctx.body, "lender"),
        nickname: field(ctx.body, "nickname") || null,
        holderMemberId: holderOrSoleMember(holder),
        visibility,
        // R15 · Where the drawn money landed, if the household said.
        disbursementDestination:
          field(ctx.body, "disbursement_destination") === "budget-account" ? "budget-account"
            : field(ctx.body, "disbursement_destination") === "third-party" ? "third-party"
              : undefined,
        disbursementAccountId: visibleAccountField(ctx, "disbursement_account_id"),
        loanType: requiredField(ctx.body, "loan_type") as LoanType,
        sanctioned: amountField(field(ctx.body, "sanctioned"), "Sanctioned amount"),
        sanctionDate: dateField(field(ctx.body, "sanction_date"), "Sanction date"),
        interestModel: (field(ctx.body, "interest_model") ?? "reducing") as
          "reducing" | "flat" | "moratorium-serviced" | "moratorium-capitalised",
        annualRatePct: Number(requiredField(ctx.body, "annual_rate")),
        tenureMonths: Number(requiredField(ctx.body, "tenure_months")),
        // "abc" is refused by createLoan (WEALTH-38), not quietly read as none.
        moratoriumMonths: field(ctx.body, "moratorium_months")?.trim()
          ? Number(field(ctx.body, "moratorium_months")) : 0,
        firstInstalmentDate: firstDue ? parseDate(firstDue) : null,
        repaymentAccountId: visibleAccountField(ctx, "repayment_account_id"),
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
    const calculator = {
      principal: rupeesFromQuery(ctx, "principal", 50_00_000) as Paise,
      rate: Number(ctx.query.get("rate") ?? 8.5),
      months: Number(ctx.query.get("months") ?? 240),
    };
    return render(
      ctx, "Prepayment calculator",
      renderPrepaymentComparison({
        comparison: comparePrepayment({
          principal: calculator.principal,
          annualRatePct: calculator.rate,
          months: calculator.months,
          prepayment: rupeesFromQuery(ctx, "amount", 5_00_000),
          atMonth: Number(ctx.query.get("at_month") ?? 24),
        }),
        loan: null,
        amount: rupeesFromQuery(ctx, "amount", 5_00_000),
        atMonth: Number(ctx.query.get("at_month") ?? 24),
        action: "/loans/what-if",
        calculator,
      }),
    );
  });

  router.post("/loans/what-if", (ctx) => {
    requireLoans();
    auth(ctx);
    /*
     * UI-PASS-12 · The form posts natively, so a refusal here used to replace
     * the page with "Something went wrong" and every figure typed was gone.
     * It is said beside the form instead, with the figures as typed.
     */
    const typed = {
      principal: field(ctx.body, "principal") ?? "",
      rate: field(ctx.body, "rate") ?? "",
      months: field(ctx.body, "months") ?? "",
      amount: field(ctx.body, "amount") ?? "",
      at_month: field(ctx.body, "at_month") ?? "",
    };
    try {
      const principal = amountField(typed.principal, "Loan amount");
      const months = Number(requiredField(ctx.body, "months"));
      const rate = Number(requiredField(ctx.body, "rate"));
      const amount = amountField(typed.amount, "Prepayment");
      const atMonth = Number(typed.at_month || 12);
      if (!Number.isInteger(months) || months < 1) {
        throw new Refusal("The tenure is a whole number of months, 1 or more.");
      }
      if (!Number.isFinite(rate) || rate < 0) {
        throw new Refusal(`"${typed.rate}" isn't a rate I can read. Enter it as a percentage, like 8.5.`);
      }
      return render(
        ctx, "Prepayment calculator",
        renderPrepaymentComparison({
          comparison: comparePrepayment({ principal, annualRatePct: rate, months, prepayment: amount, atMonth }),
          loan: null, amount: amount as Paise, atMonth, action: "/loans/what-if",
          calculator: { principal: principal as Paise, rate, months },
        }),
      );
    } catch (err) {
      if (!(err instanceof Refusal || err instanceof HttpError)) throw err;
      return {
        ...render(
          ctx, "Prepayment calculator",
          renderPrepaymentComparison({
            comparison: null, loan: null, amount: 0 as Paise, atMonth: 0,
            action: "/loans/what-if", typed, error: err.message,
          }),
        ),
        status: err.status,
      };
    }
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
        // UI-PASS-3 · Never a card's payment envelope or a commitment: the
        // charge is refused against either, so offering them is a dead end.
        categories: listCategories(db, { viewerMemberId: viewer(ctx) })
          .filter((c) => !c.payment_account_id && !c.commits_to_budget_id)
          .map((c) => ({ id: c.id, name: c.name })),
      }),
      // PRINT-1 · The schedule is the page a lender or an accountant asks for.
      { print: {} },
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
        chargeAccountId: visibleAccountField(ctx, "charge_account_id"),
        chargeCategoryId: requireVisibleCategory(ctx, field(ctx.body, "charge_category_id") || null) || null,
        /*
         * The form's one "Paid from" pays the settlement as well as the charge.
         *
         * WEALTH-19 · Through the same visibility check as the charge's account.
         * This one was read raw, so a member could name another member's private
         * account here and settle their own loan out of it: a ₹1,00,000 debit,
         * created by somebody who is told that account does not exist.
         */
        settlementAccountId:
          visibleAccountField(ctx, "settlement_account_id") ?? visibleAccountField(ctx, "charge_account_id"),
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
      const holder = guardedField(ctx, "holder_member_id", requireMember);
      const visibility = field(ctx.body, "visibility") === "private" ? "private" : "household";
      refuseForeignPrivate(
        a, getAccount(db, loan.account_id)?.holder_member_id ?? null, holder, visibility, "loan",
      );
      updateAccount(db, actorFor(a, "ui", ctx.req.headers["idempotency-key"] as string),
        // REV-3 · A sole member's form has no holder field: keep them as holder.
        loan.account_id, { holder_member_id: holderOrSoleMember(holder), visibility });
      return { redirect: `/loans/${loan.id}`, message: "Saved." };
    }),
  );

  /*
   * TAX-1 · What the house is used for, which decides whether its interest
   * goes into the tax estimate. Anyone who can see the loan can say; whose
   * estimate it reaches follows the holder.
   */
  router.post("/loans/:id/property", (ctx) =>
    mutate(ctx, (a) => {
      requireLoanVisible(ctx);
      const loan = getLoan(db, ctx.params.id!);
      if (!loan) throw new NotFound("That loan does not exist.");
      const raw = field(ctx.body, "property_use") ?? "";
      const use = raw === "self-occupied" || raw === "let-out" ? raw : raw === "" ? null : undefined;
      if (use === undefined) throw new Refusal("Choose lived in, let out, or neither.");
      setLoanPropertyUse(db, actorFor(a, "ui", ctx.req.headers["idempotency-key"] as string), loan.id, use);
      return { redirect: `/loans/${loan.id}`, message: "Saved. The tax estimate follows it." };
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
          ? visibleAccountField(ctx, "destination_account_id") : null,
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
    const gst = projection.interestGst !== null;

    const rows = [
      "number,due_date,opening,instalment,principal,interest,closing,cumulative_interest" +
        // EMI-GST-1 · A card EMI's GST on interest, the line beside each instalment.
        (gst ? ",gst_on_interest" : ""),
      ...projection.schedule.instalments.map((i) =>
        [
          i.number, i.dueDate ?? "", i.opening / 100, i.payment / 100,
          i.principal / 100, i.interest / 100, i.closing / 100, i.cumulativeInterest / 100,
          ...(gst ? [gstOnInterest(i.interest) / 100] : []),
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
        fromAccountId: visibleAccountField(ctx, "from_account_id"),
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
      /*
       * UI-PASS-4 · "abc" instalments remaining was stored as nothing and a
       * lender outstanding of −₹500 as a drift of the whole loan plus ₹500, both
       * with "Statement recorded." A statement never shows either.
       */
      const lenderOutstanding = amountField(requiredField(ctx.body, "lender_outstanding"), "Lender's outstanding");
      if (lenderOutstanding < 0) {
        throw new Refusal("The lender's outstanding is what you still owe — enter it without a minus sign.");
      }
      const interestPaidYtd = ytdRaw?.trim() ? amountField(ytdRaw, "Interest paid") : null;
      if (interestPaidYtd !== null && interestPaidYtd < 0) {
        throw new Refusal("Interest paid this year cannot be below zero.");
      }
      const instalmentsRemaining = remainingRaw?.trim() ? Number(remainingRaw.trim()) : null;
      if (instalmentsRemaining !== null && !(Number.isInteger(instalmentsRemaining) && instalmentsRemaining >= 0)) {
        throw new Refusal(`"${remainingRaw!.trim()}" is not a number of instalments. Enter a whole number, or leave it empty.`);
      }
      recordLoanStatement(db, actorFor(a, "ui", ctx.req.headers["idempotency-key"] as string), {
        loanId,
        asOf: dateField(field(ctx.body, "as_of"), "As of"),
        lenderOutstanding,
        interestPaidYtd,
        instalmentsRemaining,
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

    // WEBUX-13 · The preview takes the bounds the change itself does.
    checkAnnualRate(newRatePct);

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
      checkAnnualRate(rate);

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

    /*
     * WEALTH-37 · comparePrepayment now refuses a prepayment that would clear
     * the loan, so the page's own opening figure must not be one: ₹1,00,000 is
     * the default only where it leaves something owed after the first
     * instalment, and half of what would be left otherwise.
     */
    const leftAfterNext = projection.schedule.instalments[0]?.closing ?? 0;
    if (leftAfterNext <= 0) {
      return render(
        ctx, "Prepay",
        html`
          <h1>Prepay ${projection.loan.nickname ?? projection.loan.lender}</h1>
          <div class="card empty-state">
            <p>Only the last instalment is left, so there is nothing to prepay.</p>
            <p><a class="button" href="/loans/${projection.loan.id}">Back to the loan</a></p>
          </div>
        `,
      );
    }
    const amount = ctx.query.get("amount")
      ? rupeesFromQuery(ctx, "amount", 1_00_000)
      : Math.min(1_00_000 * 100, Math.floor(leftAfterNext / 2)) as Paise;
    const atMonth = Number(ctx.query.get("at_month") ?? 1);
    // MONEY-CORE-18 · Only the envelopes of the budget the loan is paid from —
    // recordPrepayment refuses any other.
    const view = buildBudgetView(
      db, undefined, loanPaymentBudgetId(db, projection.loan.id) ?? undefined, viewer(ctx),
    );

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
    const loanId = ctx.params.id!;
    const projection = projectLoan(db, loanId);
    if (!projection) throw new NotFound("That loan does not exist.");

    const amount = amountField(field(ctx.body, "amount"), "Prepayment");
    const atMonth = Number(field(ctx.body, "at_month") ?? 1);

    // The preview button recalculates rather than committing.
    if (field(ctx.body, "preview") === "1") {
      return { redirect: `/loans/${loanId}/prepay?amount=${amount}&at_month=${atMonth}` };
    }

    /*
     * WEALTH-17 · The commit goes through mutate(), like every other loan write.
     * This route called recordPrepayment directly, so withIdempotency never saw
     * the Idempotency-Key: a retried POST — what the client sends when the first
     * answer is lost — prepaid ₹50,000 twice, debited the bank twice and
     * shortened the tenure twice. The preview above writes nothing and stays out.
     */
    return mutate(ctx, (a) => {
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
        redirect: `/loans/${loanId}`,
        message:
          mode === "emi"
            ? `Prepaid ${formatPaise(amount)}. The instalment is now ` +
              `${formatPaise(after?.emi ?? 0)} and the closure date is unchanged.`
            // EXTRA-1 · Said from the projection, which now keeps it — "unchanged"
            // was printed beside an instalment that had moved.
            : `Prepaid ${formatPaise(amount)}. The instalment stays ${formatPaise(after?.emi ?? 0)} ` +
              `and there are ${after?.schedule.months ?? 0} left.`,
      };
    });
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
        base: config.features.reports ? "/query" : "/search",
        csv: config.features.reports,
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
    return render(
      ctx, "Overview",
      renderOverview({
        ...overviewData(db, {
          budgetId: scope, viewerMemberId: viewer(ctx), assets: config.features.assets,
          schedules: config.features.schedules, insurance: config.features.insurance,
          deposits: config.features.deposits,
        }),
        features: config.features,
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
        /*
         * BUDGET-19 · Where the money was spent, not where it was settled. A
         * card's payment envelope nets this month's charges against paying last
         * month's bill, so a ₹20,000 bill for July's food showed as August
         * spending beside August's food — the same purchase twice. A commitment
         * envelope moves money between budgets and consumes none. Both are left
         * out, as envelopeSpendBetween leaves them out of "spent".
         */
        categories: g.categories
          .filter((c) => !c.isPaymentCategory && !c.commitsToBudgetId)
          .map((c) => ({ name: c.name, value: -c.state.activity as Paise }))
          .filter((c) => c.value > 0),
      }))
      .filter((g) => g.categories.length > 0);

    return render(
      ctx, "Reports",
      renderReports({
        tax: config.features.tax,
        insights: spendingInsights(db, todayIST(), 6, viewer(ctx)),
        gains: config.features.assets ? capitalGainsByYear(db, viewer(ctx)) : [],
        trend: incomeVsExpense(db, period.from, period.to, scope, viewer(ctx)),
        categorySpend: categorySpend.map((g) => ({ label: g.label, value: g.value })),
        categoryTrends,
        tagSpend: spendByTag(db, period.from, period.to, viewer(ctx)),
        spendingCalendar: spendingCalendar(db, addDays(todayIST(), -119), todayIST(), viewer(ctx)),
        sankey: { income: monthIncome, month: bview.month, groups: sankeyGroups },
        period,
        periods: periodPresets(),
        loanInterest: config.features.loans ? loanInterestByFinancialYear(db, viewer(ctx)) : [],
        budgets: budgetsFor(db, viewer(ctx)).map((b) => ({ id: b.id, name: b.name, kind: b.kind })),
        scope: asked ?? "all",
      }),
      // PRINT-1 · Interest and realised gains by year go to whoever files.
      { print: {} },
    );
  });

  // -------------------------------------------------------------------------
  // S8 · Schedules and the cashflow calendar (F7)
  // -------------------------------------------------------------------------
  router.get("/schedules", (ctx) => {
    /*
     * The horizon arrives from a URL. Anything that is not a whole number of
     * days was a 500 ("Invalid time value" from the date arithmetic), a
     * negative one read "the next -1 days", and a few million overflowed the
     * chart's stack after five seconds of projecting. Nonsense falls back to
     * the default, as a nonsense month does; a horizon past ten years is
     * refused, because nothing scheduled here is planned that far out.
     */
    const daysRaw = ctx.query.get("days")?.trim();
    const daysAsked = daysRaw && /^\d+$/.test(daysRaw) ? Number(daysRaw) : 0;
    if (daysAsked > MAX_CASHFLOW_DAYS) {
      throw new Refusal(`The cashflow looks ahead at most ${MAX_CASHFLOW_DAYS} days.`);
    }
    const horizon = daysAsked >= 1 ? daysAsked : 60;
    const scope = budgetParam(ctx);
    const cashflow = projectCashflow(db, { days: horizon, budgetId: scope, viewerMemberId: viewer(ctx) });
    const view = buildBudgetView(db, undefined, scope, viewer(ctx));

    // 15 §3A.4 · Either end: the account it moves, or the envelope it lands in.
    const inScopeSchedule = scheduleInScope(db, { budgetId: scope, viewerMemberId: viewer(ctx) });

    return render(
      ctx, "Schedules",
      renderSchedules({
        schedules: listSchedules(db, { viewerMemberId: viewer(ctx) }).filter(inScopeSchedule),
        detected: detectSchedules(db, todayIST(), viewer(ctx)),
        cashflow,
        cashflowReading: describeCashflow(cashflow),
        subscriptions: subscriptions(db, viewer(ctx)),
        horizon,
        categoryNames: new Map([...view.categories].map(([id, c]) => [id, c.name])),
        splits: new Map(
          listSchedules(db, { viewerMemberId: viewer(ctx) }).filter(inScopeSchedule)
            .map((sch) => [sch.id, getScheduleSplits(db, sch.id)]),
        ),
        // The inline edit form needs the full lists, or saving would blank the
        // fields it does not show — the same accounts /schedules/new offers, or
        // a schedule on a tracking account saved as "Not set".
        categories: [...view.categories.values()]
          .filter((c) => !c.isPaymentCategory && !c.commitsToBudgetId && !c.hidden)
          .map((c) => ({ id: c.id, name: c.name })),
        accounts: listAccounts(db, { viewerMemberId: viewer(ctx) })
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
          .filter((c) => !c.isPaymentCategory && !c.commitsToBudgetId && !c.hidden)
          .map((c) => ({ id: c.id, name: c.name })),
        today: todayIST(),
      }),
    );
  });

  router.post("/schedules/confirm", (ctx) =>
    mutate(ctx, (a) => {
      // F7.6: a detected schedule becomes real only when confirmed, and stops
      // being marked "detected" once it is.
      /*
       * The suggestion's figures arrive as hidden fields, and hidden is not
       * checked. The amount is paise, written by the page itself, so it is a
       * whole, non-zero number or the form was not ours; the date is read like
       * any other; the payee is guarded below, as the account and envelope are.
       */
      const rawAmount = (field(ctx.body, "amount") ?? "").trim();
      const amount = /^-?\d+$/.test(rawAmount) ? Number(rawAmount) : NaN;
      if (!Number.isSafeInteger(amount) || amount === 0) {
        throw new HttpError(422, `"${rawAmount}" is not an amount this suggestion could have made.`);
      }
      createSchedule(db, actorFor(a, "ui", ctx.req.headers["idempotency-key"] as string), {
        name: requiredField(ctx.body, "name"),
        // The payee too, like the account and envelope beside it
        // (SECURITY-OPS-28): another member's private payee rode along into
        // the household register, and a made-up one was a foreign-key 500.
        payeeId: guardedField(ctx, "payee_id", requireVisiblePayee),
        accountId: visibleAccountField(ctx, "account_id"),
        categoryId: requireVisibleCategory(ctx, field(ctx.body, "category_id") || null) || null,
        amount: amount as Paise,
        recurrence: parseRecurrence(field(ctx.body, "recurrence") ?? "monthly"),
        recurrenceOrdinal: weekdayOrdinalField(ctx.body),
        recurrenceWeekday: weekdayField(ctx.body),
        nextDue: dateField(field(ctx.body, "next_due"), "Next due"),
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

      /*
       * The schedule and its lines together, or neither.
       *
       * setScheduleSplits refuses lines that do not add up, and it can only
       * check that once the schedule exists to be checked against — so a
       * refusal used to arrive *after* the schedule had been created, leaving a
       * schedule with no split and an error message suggesting nothing had
       * happened. transact makes the pair atomic.
       */
      /*
       * Envelope lines, resolved the same way a transaction's are: the first
       * carries no amount and takes what the others leave.
       */
      const lineValues: { categoryId: string | null; amount: Paise | null }[] = [];
      for (let i = 0; i < 10; i++) {
        const cat = field(ctx.body, `split_category_${i}`);
        const raw = String(field(ctx.body, `split_amount_${i}`) ?? "").trim();
        // Same rule as /add: a present-but-empty first line means "no envelope".
        if (i > 0 && !cat && !raw) continue;
        if (i === 0 && cat === undefined && !raw) continue;
        const lineMagnitude = raw ? Math.abs(amountField(raw, `Envelope ${i + 1}`)) : null;
        lineValues.push({
          categoryId: cat ? requireVisibleCategory(ctx, cat)! : null,
          amount: i === 0 || lineMagnitude === null
            ? null
            : ((direction === "in" ? lineMagnitude : -lineMagnitude) as Paise),
        });
      }
      if (lineValues.length === 0) {
        const legacy = field(ctx.body, "category_id");
        if (legacy) lineValues.push({ categoryId: requireVisibleCategory(ctx, legacy)!, amount: null });
      }

      const filed = resolveCategoryLines(
        (direction === "in" ? magnitude : -magnitude) as Paise,
        lineValues,
      );
      /*
       * B99 for schedules, against the lines. A blank line here is recorded
       * against nothing each time it is marked paid — see outgoingLacksEnvelope.
       */
      if ( outgoingLacksEnvelope((direction === "in" ? magnitude : -magnitude) as Paise, filed)) {
        throw new Refusal(
          "One of those envelope lines is blank, so each time you mark it paid, part " +
          "of it would be recorded against nothing. Money coming in can be left unassigned — it " +
          "waits in Ready to Assign — but money going out has to say where it came from.",
        );
      }

      const lines = (filed.splits ?? []).map((sp) => ({
        categoryId: sp.categoryId, amount: sp.amount,
      }));

      return transact(db, () => {
      const created = createSchedule(db, actorFor(a, "ui", ctx.req.headers["idempotency-key"] as string), {
        name: requiredField(ctx.body, "name"),
        splitsFollow: lines.length > 0,
        amount: (direction === "in" ? magnitude : -magnitude) as Paise,
        recurrence: parseRecurrence(field(ctx.body, "recurrence") ?? "monthly"),
        recurrenceOrdinal: weekdayOrdinalField(ctx.body),
        recurrenceWeekday: weekdayField(ctx.body),
        nextDue: dateField(field(ctx.body, "next_due"), "Next due"),
        categoryId: filed.categoryId,
        accountId: visibleAccountField(ctx, "account_id"),
        isSubscription: field(ctx.body, "is_subscription") === "1",
      });

      /*
       * Split lines, if any were given. Set after creation because they have to
       * add up to the schedule's amount, and there is no amount to check
       * against until the schedule exists — the same reason the edit form sets
       * them separately.
       */
      if (lines.length > 0) {
        setScheduleSplits(db, actorFor(a, "ui"), created.id, lines);
      }

      return {
        redirect: "/schedules",
        message: lines.length > 0
          ? `Schedule added, split across ${lines.length} envelopes.`
          : "Schedule added.",
      };
      });
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
      requireVisibleSchedule(ctx, ctx.params.id!);
      const amountRaw = field(ctx.body, "amount");
      const magnitude = amountRaw?.trim() ? Math.abs(amountField(amountRaw, "Amount")) : null;
      const direction = field(ctx.body, "direction") ?? "out";
      const dueRaw = field(ctx.body, "next_due");
      /*
       * IMPORTS-SCHEDULES-25 · A date that does not read is refused, as on
       * /schedules/new. It was dropped: "31/02/2027" or "someday" answered
       * "Rent updated." and kept the old date, so the change seemed made.
       * Empty still means "leave it".
       */
      const nextDue = dueRaw?.trim() ? dateField(dueRaw, "Next due") : undefined;

      /*
       * Envelope lines live on this form now, not a separate one beside it.
       * The first carries no amount and takes what the others leave, so a
       * schedule's envelopes are set the same way a transaction's are — and
       * the two can no longer disagree about what a split is.
       */
      const existing = getSchedule(db, ctx.params.id!);
      const signedAmount = magnitude === null
        ? (existing?.amount ?? 0) as Paise
        : ((direction === "in" ? magnitude : -magnitude) as Paise);

      const lineValues: { categoryId: string | null; amount: Paise | null }[] = [];
      for (let i = 0; i < 10; i++) {
        const cat = field(ctx.body, `split_category_${i}`);
        const raw = String(field(ctx.body, `split_amount_${i}`) ?? "").trim();
        if (cat === undefined && !raw) continue;
        // As on the transaction form: a present-but-empty first select clears
        // the envelope, rather than being skipped as an unused line.
        if (i > 0 && !cat && !raw) continue;
        const lineMagnitude = raw ? Math.abs(amountField(raw, `Envelope ${i + 1}`)) : null;
        lineValues.push({
          categoryId: cat ? requireVisibleCategory(ctx, cat)! : null,
          amount: i === 0 || lineMagnitude === null
            ? null
            : ((signedAmount < 0 ? -lineMagnitude : lineMagnitude) as Paise),
        });
      }
      /*
       * A caller still posting the old field is honoured, as on the transaction
       * forms — but an empty one on a schedule that is already split means "not
       * mentioned", not "file it nowhere".
       */
      if (lineValues.length === 0) {
        const legacy = field(ctx.body, "category_id");
        const alreadySplit = getScheduleSplits(db, ctx.params.id!).length > 0;
        if (legacy !== undefined && (legacy !== "" || !alreadySplit)) {
          lineValues.push({
            categoryId: legacy ? requireVisibleCategory(ctx, legacy)! : null,
            amount: null,
          });
        }
      }

      const filed = lineValues.length > 0
        ? resolveCategoryLines(signedAmount, lineValues)
        : null;

      /*
       * B99 for schedules, against the lines. A blank line here is recorded
       * against nothing each time it is marked paid — see outgoingLacksEnvelope.
       */
      if (filed !== null && outgoingLacksEnvelope(signedAmount, filed)) {
        throw new Refusal(
          "One of those envelope lines is blank, so each time you mark it paid, part " +
          "of it would be recorded against nothing. Money coming in can be left unassigned — it " +
          "waits in Ready to Assign — but money going out has to say where it came from.",
        );
      }

      return transact(db, () => {
      const schedule = updateSchedule(
        db, actorFor(a, "ui", ctx.req.headers["idempotency-key"] as string), ctx.params.id!,
        {
          name: field(ctx.body, "name") || undefined,
          amount: magnitude === null
            ? undefined
            : ((direction === "in" ? magnitude : -magnitude) as Paise),
          recurrence: field(ctx.body, "recurrence")
            ? parseRecurrence(field(ctx.body, "recurrence"))
            : undefined,
          recurrence_ordinal: weekdayOrdinalField(ctx.body),
          recurrence_weekday: weekdayField(ctx.body),
          next_due: nextDue,
          /*
           * Absent is not the same as cleared.
           *
           * A disabled select submits nothing, and this form disables the
           * envelope while the schedule is split. Treating a missing field as
           * "clear it" would wipe the stored category every time somebody
           * edited a split schedule — and it would be gone the moment they
           * removed the split. An empty *present* value still clears it, which
           * is what "Not set" means.
           */
          category_id: filed === null ? undefined : filed.categoryId,
          account_id: field(ctx.body, "account_id") === undefined
            ? undefined
            : visibleAccountField(ctx, "account_id"),
          is_subscription: field(ctx.body, "is_subscription") === "1" ? 1 : 0,
        },
        { splitsFollow: (filed?.splits?.length ?? 0) > 0, linesFollow: filed !== null },
      );
      // The lines, after the schedule itself — setScheduleSplits checks them
      // against the amount, which the update above may have just changed.
      if (filed !== null) {
        setScheduleSplits(
          db, actorFor(a, "ui"), schedule.id,
          (filed.splits ?? []).map((sp) => ({ categoryId: sp.categoryId, amount: sp.amount })),
          { priorAmount: existing?.amount ?? null },
        );
      }

      return { redirect: "/schedules", message: `${schedule.name} updated.` };
      });
    }),
  );

  router.post("/schedules/:id/delete", (ctx) =>
    mutate(ctx, (a) => {
      deleteSchedule(db, actorFor(a, "ui", ctx.req.headers["idempotency-key"] as string), requireVisibleSchedule(ctx, ctx.params.id!));
      return {
        redirect: "/schedules",
        message: "Removed. Anything it already recorded is untouched.",
      };
    }),
  );

  router.post("/schedules/:id/paid", (ctx) =>
    mutate(ctx, (a) => {
      const id = requireVisibleSchedule(ctx, ctx.params.id!);
      // D8b · The list calls this button "Arrived" on income and "Paid" on a
      // bill (the same rule: money in is income), so the reply does too.
      const income = (getSchedule(db, id)?.amount ?? 0) > 0;
      markPaid(db, actorFor(a, "ui", ctx.req.headers["idempotency-key"] as string), id);
      return { redirect: "/schedules", message: income ? "Marked arrived." : "Marked paid." };
    }),
  );

  router.post("/schedules/:id/skip", (ctx) =>
    mutate(ctx, (a) => {
      skipOccurrence(db, actorFor(a, "ui", ctx.req.headers["idempotency-key"] as string), requireVisibleSchedule(ctx, ctx.params.id!));
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
        // Only a blank field means "no date". A date parseDate cannot read
        // used to come back null and be saved as no date — silently, with
        // "Goal added" — so dateField refuses it like every other date field.
        targetDate: targetDate?.trim() ? dateField(targetDate, "Target date") : null,
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
      const id = requireVisibleGoal(ctx, ctx.params.id!);
      const targetDate = field(ctx.body, "target_date");
      const name = requiredField(ctx.body, "name");
      updateGoal(db, actor, id, {
        name,
        targetAmount: amountField(field(ctx.body, "target_amount"), "Target"),
        // As on /goals/new: an unreadable date is refused, not read as "no
        // date" — which here wiped the goal's saved date and stopped it
        // computing a monthly amount.
        targetDate: targetDate?.trim() ? dateField(targetDate, "Target date") : null,
      });
      // Keep the owned category's name in step with the goal's.
      for (const catId of goalCategoryIds(db, id)) {
        const cat = getCategory(db, catId);
        if (cat && cat.name !== name) renameCategory(db, actor, catId, name);
      }
      return { redirect: "/goals", message: "Goal updated." };
    }),
  );

  router.post("/goals/:id/delete", (ctx) =>
    mutate(ctx, (a) => {
      const actor = actorFor(a, "ui", ctx.req.headers["idempotency-key"] as string);
      const id = requireVisibleGoal(ctx, ctx.params.id!);
      const view = buildBudgetView(db, undefined, undefined, viewer(ctx));
      // B58 · The goal owns its category. On delete, hand the envelope back as a
      // normal category (moved to a "Savings" group) so its money is never lost
      // and the household can manage or empty it afterwards.
      const catIds = goalCategoryIds(db, id);
      const kept = catIds.reduce((sum, cid) => sum + (view.categories.get(cid)?.state.balance ?? 0), 0) as Paise;
      /*
       * 15 · The envelope stays in the goal's own budget. This looked for a
       * "Savings" group among *every* budget's groups and otherwise created one
       * in the household's — so deleting Ravi's personal "Jabberwock Private
       * Goal" moved its envelope into a household group, where Priya's budget
       * page and category list showed it, balance and all. A group and the
       * envelopes in it always share a budget.
       */
      const home = getGoal(db, id)?.budget_id ?? householdBudgetId(db);
      deleteGoal(db, actor, id);
      // B61: prefer a savings group the budget already has — the starting
      // template's "Savings goals" is exactly the right home — over minting a
      // third group nobody asked for.
      const groups = listGroups(db, home);
      const normal =
        groups.find((g) => g.kind === "normal" && g.name === LEGACY_GOAL_GROUP)
        ?? groups.find((g) => g.kind === "normal" && g.name === "Savings")
        ?? (catIds.length > 0 ? createGroup(db, actor, "Savings", "normal", home) : null);
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
      if (!["spend", "roll", "release"].includes(resolution)) throw new Refusal("Choose what happens to the money.");
      // BUDGET-14 · Rolling names the goal it rolls into.
      const targetDate = field(ctx.body, "target_date");
      const next = resolution === "roll"
        ? {
          name: requiredField(ctx.body, "name"),
          targetAmount: amountField(field(ctx.body, "target_amount"), "Target"),
          targetDate: targetDate?.trim() ? parseDate(targetDate) : null,
        }
        : undefined;
      const rolled = completeGoal(
        db, actorFor(a, "ui", ctx.req.headers["idempotency-key"] as string),
        requireVisibleGoal(ctx, ctx.params.id!), resolution, next,
      );
      return {
        redirect: "/goals",
        message: rolled ? `Goal completed. Its money now counts toward "${rolled.name}".`
          : resolution === "release" ? "Goal completed. Its money is back in Ready to Assign."
          : "Goal completed.",
      };
    }),
  );


  // -------------------------------------------------------------------------
  // S5 More · F5 payees · F6 rules · F3 categories · J1 first run
  // -------------------------------------------------------------------------
  router.get("/more", (ctx) =>
    render(ctx, "More", renderMore(config.features)),
  );

  router.get("/payees", (ctx) => {
    const visibleCategories = new Set(
      listCategories(db, { includeHidden: true, viewerMemberId: viewer(ctx) }).map((c) => c.id),
    );
    const rows: PayeeRow[] = listPayees(db, viewer(ctx)).map((p) => {
      // MONEY-CORE-21 · Its figures and aliases as far as this member may see.
      const stats = payeeStats(db, p.id, viewer(ctx));
      return {
        id: p.id,
        name: p.name,
        count: stats.count,
        total: stats.total,
        lastSeen: stats.lastSeen,
        aliases: payeeAliases(db, p.id, viewer(ctx)),
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
      const loser = requireVisiblePayee(ctx, requiredField(ctx.body, "loser_id"));
      const winner = requireVisiblePayee(ctx, requiredField(ctx.body, "winner_id"));
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
    const conditionField = requiredField(ctx.body, "field") as Rule["conditions"][number]["field"];
    const op = requiredField(ctx.body, "op") as Rule["conditions"][number]["op"];
    /*
     * EXTRA-2 · The field and the test are checked, not trusted. The form sends
     * one typed value, and "oneOf" with the text "Zomato" (a crafted post; the
     * form does not offer it) was saved as it stood, then threw inside every
     * import after — 500 until the rule was deleted. A test that needs a list
     * or a pair cannot be written here, and an unknown one never matches.
     */
    if (!CONDITION_FIELDS.includes(conditionField)) {
      throw new HttpError(422, `A rule can't test "${conditionField}".`);
    }
    if (!OPERATORS.includes(op)) throw new HttpError(422, `"${op}" isn't a test a rule can make.`);
    if (LIST_OPERATORS.includes(op)) {
      throw new HttpError(422, `"${op}" needs a list of values, and this form takes one. Use "is exactly" or "matches a pattern".`);
    }
    /*
     * An amount is typed in rupees and compared in paise. The typed "5000" was
     * stored as it stood and compared against 6000 paise, so "is more than
     * 5000" filed a ₹60 chai into Big spends and "is exactly 649" never met a
     * ₹649 Netflix (64900). It is read like every other amount field here.
     */
    let value: string | number = requiredField(ctx.body, "value");
    if (conditionField === "amount" || conditionField === "absoluteAmount") {
      const paise = parseAmount(value);
      if (paise === null) throw new HttpError(422, `"${value}" isn't an amount I can read.`);
      value = conditionField === "absoluteAmount" ? Math.abs(paise) : paise;
    }
    return {
      id: "draft",
      name: requiredField(ctx.body, "name"),
      stage: "default",
      match: "all",
      conditions: [
        { field: conditionField, op, value },
      ],
      actions: [{ type: "setCategory", categoryId: ruleTarget(ctx) }],
      enabled: true,
    };
  }

  /*
   * MONEY-CORE-27 · The envelope a rule files to meets the refusals of every
   * other filing path. A card's payment envelope or a commitment envelope was
   * accepted here (the picker hides them; a crafted or stale post did not), and
   * applying the rule filed spending straight into one — the identity out by
   * the amount in every month after.
   */
  function ruleTarget(ctx: RequestContext): string {
    const categoryId = requireVisibleCategory(ctx, requiredField(ctx.body, "category_id"))!;
    refusePaymentCategories(db, [categoryId]);
    return categoryId;
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
          .filter((c) => !c.isPaymentCategory && !c.commitsToBudgetId && !c.hidden)
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

    // MONEY-CORE-22 · The history the viewer can see, as the apply preview reads
    // it. This read the household's latest 500 rows, so Ravi's test matched and
    // listed a payee that exists only on Priya's private account.
    const subjects: RuleSubject[] = ruleSubjects(db, viewer(ctx), 500);

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
        value: conditionValueText(rule.conditions[0]!),
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
    const ruleId = requireVisibleRule(ctx, ctx.params.id!);
    const rules = ruleRows(db, false).concat(ruleRows(db, true));
    const rule = rules.find((r) => r.id === ruleId);
    if (!rule) throw new NotFound("That rule does not exist.");

    if (field(ctx.body, "confirm") !== "1") {
      // F6.6 requires the count and a preview *before* commit.
      const preview = previewRetroactive(db, rule, viewer(ctx));
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
                              <td>${formatDate(m.date)}</td>
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

    // MONEY-CORE-14 · A retry replays the count rather than applying again.
    const changed = once(ctx, a, () =>
      applyRetroactive(db, actorFor(a, "ui", ctx.req.headers["idempotency-key"] as string), rule));
    return {
      redirect: withNotice(
        "/rules",
        `Recategorised ${changed} ${changed === 1 ? "transaction" : "transactions"}.`,
      ),
    };
  });

  router.post("/rules/confirm", (ctx) =>
    mutate(ctx, (a) => {
      // A rule filing into another member's private envelope is theirs, as it
      // is for /rules/:id/delete (SECURITY-OPS-8).
      confirmRule(db, actorFor(a), requireVisibleRule(ctx, requiredField(ctx.body, "rule_id")));
      return { redirect: "/rules", message: "Rule confirmed." };
    }),
  );

  router.post("/rules/dismiss", (ctx) =>
    mutate(ctx, (a) => {
      // L5: dismissing a proposal suppresses that specific proposal for good.
      const id = requireVisibleRule(ctx, requiredField(ctx.body, "rule_id"));
      dismissRule(db, actorFor(a), id, ruleRows(db, true).find((r) => r.id === id));
      return { redirect: "/rules", message: "Won't suggest that again." };
    }),
  );

  router.post("/rules/:id/delete", (ctx) =>
    mutate(ctx, (a) => {
      const id = requireVisibleRule(ctx, ctx.params.id!);
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
                target: t ? { amount: t.amount ?? 0, date: t.target_date, type: t.type } : null,
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
      // A group in a budget this member can see (SECURITY-OPS-6): another
      // member's private group took the envelope into their budget, and a
      // made-up id failed its foreign key as a 500. And one of the groups the
      // form offers — the app keeps its own (card payments, loans, internal)
      // and fills them itself.
      const groupId = requireVisibleGroup(ctx, requiredField(ctx.body, "group_id"));
      const kind = queryOne<{ kind: string }>(db, `SELECT kind FROM category_groups WHERE id = ?`, groupId)!.kind;
      if (kind !== "normal") throw new Refusal("Envelopes in that group are managed by the app. Pick another group.");
      createCategory(db, actorFor(a, "ui", ctx.req.headers["idempotency-key"] as string), {
        groupId,
        name: requiredField(ctx.body, "name"),
      });
      return { redirect: "/categories", message: "Category added." };
    }),
  );

  router.post("/categories/:id/rename", (ctx) =>
    mutate(ctx, (a) => {
      renameCategory(db, actorFor(a, "ui", ctx.req.headers["idempotency-key"] as string),
        requireVisibleCategory(ctx, ctx.params.id!)!, requiredField(ctx.body, "name"));
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
      /*
       * BUDGET-17 · Every target without a date was written back as monthly, and
       * the form called them all "Monthly target". The starting template's
       * "refill up to ₹20,000" on Medical, saved unchanged, became "₹20,000 every
       * month" — the full envelope flipped to "Not funded ₹0 of ₹20,000". The
       * form now says which kind it is and sends it back; a client that sends no
       * kind keeps the stored one.
       */
      const kindRaw = field(ctx.body, "kind")?.trim()
        || (getTarget(db, ctx.params.id!)?.type === "refill" ? "refill" : "monthly");
      if (kindRaw !== "monthly" && kindRaw !== "refill") {
        throw new Refusal("A target is either an amount each month or a level to refill up to.");
      }
      const type = dateRaw?.trim() ? "by-date" : kindRaw;
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
        requireVisibleGroup(ctx, ctx.params.id!), requiredField(ctx.body, "name"),
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
        // An envelope this member can see (SECURITY-OPS-11): the refusals
        // for another member's envelope named their private card and told a
        // real id from a made-up one. Now one 404 for both.
        remapTo: requireVisibleCategory(ctx, field(ctx.body, "remap_to") || null) || null,
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
      const holder = guardedField(ctx, "holder_member_id", requireMember);
      const visibility = field(ctx.body, "visibility") === "private" ? "private" : undefined;
      // WEB-4 · WEB-1's rule at creation: private only to whoever adds it.
      refuseForeignPrivate(a, null, holder, visibility, "loan");
      const loan = createFamilyLoan(db, actorFor(a), {
        counterparty: requiredField(ctx.body, "counterparty"),
        agreedTotal: agreed ? amountField(agreed) : null,
        note: field(ctx.body, "note") || null,
        // H2 / H2.2 · Money lent to your cousin can be yours rather than the
        // household's, the same as an asset or a loan.
        holderMemberId: holder,
        visibility,
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
        .filter((c) => !c.isPaymentCategory && !c.commitsToBudgetId && !c.hidden)
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
        fromAccountId: requireVisibleAccount(ctx, requiredField(ctx.body, "account_id")).id,
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
        accountId: requireVisibleAccount(ctx, requiredField(ctx.body, "account_id")).id,
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
  // INSURANCE-1 · The policy register.
  // -------------------------------------------------------------------------

  /** A policy named in a URL, if this viewer may see it; 404 otherwise. */
  function requireVisiblePolicy(ctx: RequestContext): string {
    const id = ctx.params.id!;
    if (!canSeePolicy(db, id, viewer(ctx))) throw new NotFound("That policy does not exist.");
    return id;
  }

  /** Envelopes a premium can be paid from: the viewer's, less cards and commitments. */
  function policyEnvelopes(ctx: RequestContext) {
    return listCategories(db, { includeHidden: true, viewerMemberId: viewer(ctx) })
      .filter((c) => !c.payment_account_id && !c.commits_to_budget_id)
      .map((c) => ({ id: c.id, name: c.name }));
  }

  function policyInput(ctx: RequestContext): PolicyInput {
    const money = (name: string, label: string): number | null => {
      const raw = field(ctx.body, name);
      return raw && raw.trim() ? Math.abs(amountField(raw, label)) : null;
    };
    const date = (name: string, label: string): string | null => {
      const raw = field(ctx.body, name);
      return raw && raw.trim() ? dateField(raw, label) : null;
    };
    return {
      insurer: requiredField(ctx.body, "insurer"),
      kind: field(ctx.body, "kind") ?? "",
      policyNumber: field(ctx.body, "policy_number") || null,
      sumAssured: money("sum_assured", "Sum assured"),
      premium: money("premium", "Premium") ?? 0,
      frequency: field(ctx.body, "frequency") ?? "",
      nextDue: date("next_due", "Next due"),
      startDate: date("start_date", "Start date"),
      endDate: date("end_date", "End date"),
      nominee: field(ctx.body, "nominee") || null,
      covered: field(ctx.body, "covered") || null,
      taxGroup: field(ctx.body, "tax_group") || "none",
      senior: field(ctx.body, "senior") === "1",
      categoryId: guardedField(ctx, "category_id", requireVisibleCategory),
      holderMemberId: guardedField(ctx, "holder_member_id", requireMember),
      visibility: field(ctx.body, "visibility") === "private" ? "private" : "household",
      note: field(ctx.body, "note") || null,
    };
  }

  router.get("/insurance", (ctx) => {
    auth(ctx);
    // A private policy is its holder's alone, the same as an account (docs/privacy.md).
    return render(ctx, "Insurance", renderInsurance({
      policies: listPolicies(db, { viewerMemberId: viewer(ctx) }),
      members: listMembers(db).map((m) => ({ id: m.id, name: m.name })),
      envelopes: policyEnvelopes(ctx),
      today: todayIST(),
    }));
  });

  router.post("/insurance/new", (ctx) =>
    mutate(ctx, (a) => {
      const input = policyInput(ctx);
      // WEB-4 · WEB-1's rule at creation: private only to whoever adds it.
      refuseForeignPrivate(a, null, input.holderMemberId ?? null, input.visibility, "policy");
      input.holderMemberId = holderOrSoleMember(input.holderMemberId);
      const policy = createPolicy(
        db, actorFor(a, "ui", ctx.req.headers["idempotency-key"] as string), input,
      );
      return { redirect: `/insurance/${policy.id}`, message: "Added." };
    }),
  );

  router.get("/insurance/:id", (ctx) => {
    const id = requireVisiblePolicy(ctx);
    auth(ctx);
    const policy = getPolicy(db, id);
    if (!policy) throw new NotFound("That policy does not exist.");
    return render(ctx, policy.insurer, renderPolicy({
      policy,
      members: listMembers(db).map((m) => ({ id: m.id, name: m.name })),
      envelopes: policyEnvelopes(ctx),
      today: todayIST(),
    }));
  });

  router.post("/insurance/:id/edit", (ctx) =>
    mutate(ctx, (a) => {
      const id = requireVisiblePolicy(ctx);
      const input = policyInput(ctx);
      refuseForeignPrivate(
        a, getPolicy(db, id)?.holder_member_id ?? null, input.holderMemberId ?? null,
        input.visibility, "policy",
      );
      // REV-3 · As at creation (UI-8): a sole member's form has no holder field.
      input.holderMemberId = holderOrSoleMember(input.holderMemberId);
      updatePolicy(db, actorFor(a, "ui", ctx.req.headers["idempotency-key"] as string), id, input);
      return { redirect: `/insurance/${id}`, message: "Saved." };
    }),
  );

  router.post("/insurance/:id/paid", (ctx) =>
    mutate(ctx, (a) => {
      const id = requireVisiblePolicy(ctx);
      const next = markPremiumPaid(db, actorFor(a, "ui", ctx.req.headers["idempotency-key"] as string), id);
      return {
        // Overview's "Due soon" posts here too, and goes back to where it was.
        redirect: safePath(field(ctx.body, "back"), `/insurance/${id}`),
        message: next
          ? `Marked paid; next due ${formatDate(next)}. Nothing was posted — record the payment if it is not in the register.`
          : "Marked paid; nothing more falls due. Nothing was posted.",
      };
    }),
  );

  router.post("/insurance/:id/status", (ctx) =>
    mutate(ctx, (a) => {
      const id = requireVisiblePolicy(ctx);
      const status = field(ctx.body, "status");
      if (status !== "active" && status !== "lapsed" && status !== "ended") {
        throw new Refusal("That is not a policy status.");
      }
      setPolicyStatus(db, actorFor(a, "ui", ctx.req.headers["idempotency-key"] as string), id, status);
      return {
        redirect: `/insurance/${id}`,
        message: status === "active" ? "Reinstated." : "Kept, and listed with the lapsed and ended.",
      };
    }),
  );

  router.post("/insurance/:id/delete", (ctx) =>
    mutate(ctx, (a) => {
      const id = requireVisiblePolicy(ctx);
      deletePolicy(db, actorFor(a, "ui", ctx.req.headers["idempotency-key"] as string), id);
      return { redirect: "/insurance", message: "Deleted. Activity can undo it." };
    }),
  );

  // -------------------------------------------------------------------------
  // `08` F30 · Personal API tokens.
  // -------------------------------------------------------------------------

  router.get("/tokens", (ctx) => {
    const a = auth(ctx);
    return render(ctx, "API tokens", renderTokens({
      aiEnabled,
      tokens: listTokens(db, a.member.id),
      connections: oauth.listConnections(db, a.member.id),
      minted: null,
    }));
  });

  router.post("/tokens", (ctx) => {
    refuseInDemo(config, "Creating API tokens");
    const a = auth(ctx);
    /*
     * A token is minted for whoever the actor is, and while viewing as
     * somebody that is them: the time-boxed, logged view became a credential
     * of theirs that never expires and that nothing about ending the view
     * revokes. Impersonation is session-only (R38.12), so this is refused.
     */
    if (a.impersonating) {
      throw new HttpError(403, "API tokens cannot be created while viewing as another member.");
    }
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
      aiEnabled,
      tokens: listTokens(db, a.member.id),
      connections: oauth.listConnections(db, a.member.id),
      minted: { name: minted.token.name, secret: minted.secret },
    }));
  });

  // AI-5 · Disconnecting from Connect an AI returns there; nothing else is a
  // destination this takes, so it cannot be bent into an open redirect.
  function backToTokens(ctx: RequestContext): string {
    return field(ctx.body, "back") === "/tokens/ai" ? "/tokens/ai" : "/tokens";
  }
  router.post("/tokens/:id/revoke", (ctx) =>
    mutate(ctx, (a) => {
      revokeToken(db, actorFor(a), ctx.params.id!);
      return { redirect: backToTokens(ctx), message: "Revoked. Anything using it stops now." };
    }),
  );

  router.post("/tokens/connections/:id/revoke", (ctx) =>
    mutate(ctx, (a) => {
      oauth.revokeConnection(db, actorFor(a), ctx.params.id!);
      return { redirect: backToTokens(ctx), message: "Disconnected. The app cannot read anything from now on." };
    }),
  );

  // -------------------------------------------------------------------------
  // OAUTH · The authorization server AI apps connect through (src/auth/oauth.ts)
  // -------------------------------------------------------------------------

  const protectedResource = (): Response => ({ json: oauth.protectedResourceMetadata(config.baseUrl, { write: aiWriteOn }) });
  router.get("/.well-known/oauth-protected-resource", protectedResource);
  // RFC 9728 §3.1 · The path-suffixed form, which clients try first.
  router.get("/.well-known/oauth-protected-resource/mcp", protectedResource);
  router.get("/.well-known/oauth-authorization-server", () => ({
    json: oauth.authorizationServerMetadata(config.baseUrl, { write: aiWriteOn }),
  }));

  /** An OAuth endpoint answers in OAuth's words, never with an HTML error page. */
  function oauthJson(fn: () => Response): Response {
    try {
      return fn();
    } catch (err) {
      if (err instanceof oauth.OAuthError) return err.toResponse();
      if (err instanceof HttpError) {
        return { status: err.status, json: { error: "invalid_request", error_description: err.message } };
      }
      throw err;
    }
  }

  router.post("/oauth/register", (ctx) => oauthJson((): Response => {
    const limit = oauth.checkOAuthRateLimit("register", clientIp(ctx, config.trustProxy));
    if (!limit.allowed) {
      return {
        status: 429,
        headers: { "Retry-After": String(limit.retryAfterSeconds) },
        json: { error: "slow_down", error_description: "Too many registrations from here. Try again later." },
      };
    }
    // Refused where minting a token is: on a demo.
    if (config.demoMode) {
      throw new oauth.OAuthError("access_denied", "Connecting AI apps is disabled on the demo.", 403);
    }
    return { status: 201, json: oauth.registerClient(db, ctx.body) };
  }));

  router.post("/oauth/token", (ctx) => oauthJson((): Response => {
    const limit = oauth.checkOAuthRateLimit("token", clientIp(ctx, config.trustProxy));
    if (!limit.allowed) {
      return {
        status: 429,
        headers: { "Retry-After": String(limit.retryAfterSeconds) },
        json: { error: "slow_down", error_description: "Too many token requests. Try again shortly." },
      };
    }
    const clientId = oauth.clientIdFrom(ctx.body, ctx.req.headers.authorization);
    return {
      headers: { Pragma: "no-cache" },
      json: oauth.tokenRequest(db, config.baseUrl, ctx.body, clientId, new Date(), { write: aiWriteOn }),
    };
  }));

  router.post("/oauth/revoke", (ctx) => oauthJson(() => {
    oauth.revocationRequest(db, ctx.body, oauth.clientIdFrom(ctx.body, ctx.req.headers.authorization));
    return { json: {} };
  }));

  /**
   * The consent page, and its answer. Refused while viewing as somebody else
   * (a connection is a credential of theirs, like a token: R38.12) and on a
   * demo, as minting a token is.
   */
  function consentGate(ctx: RequestContext): AuthContext {
    refuseInDemo(config, "Connecting AI apps");
    const a = auth(ctx);
    if (a.impersonating) {
      throw new HttpError(403, "An AI app cannot be connected while viewing as another member.");
    }
    return a;
  }

  /** The parameters a consent form carries back, exactly as the app sent them. */
  const AUTHORIZE_PARAMS = [
    "client_id", "redirect_uri", "response_type", "state",
    "code_challenge", "code_challenge_method", "resource", "scope",
  ];

  router.get("/oauth/authorize", (ctx) => {
    const a = consentGate(ctx);
    const parsed = oauth.parseAuthorizeRequest(db, config.baseUrl, (n) => ctx.query.get(n) ?? undefined);
    if ("fatal" in parsed) {
      return { ...render(ctx, "Connect an app", renderConsentProblem(parsed.fatal, { apiTokens: config.features.apiTokens })), status: 400 };
    }
    if ("redirect" in parsed) return { redirect: parsed.redirect };

    const { client, redirectUri } = parsed.ok;
    const hidden: Record<string, string> = {};
    for (const name of AUTHORIZE_PARAMS) {
      const value = ctx.query.get(name);
      if (value !== null) hidden[name] = value;
    }
    hidden.redirect_uri = redirectUri;
    const registered = oauth.redirectUrisOf(client);
    const page = render(ctx, `Connect ${client.client_name}`, renderConsent({
      clientName: client.client_name,
      redirectHost: oauth.redirectHost(redirectUri),
      loopbackOnly: registered.every((u) => {
        try { return oauth.isLoopback(new URL(u)); } catch { return false; }
      }),
      memberName: a.member.name,
      hidden,
      // AIW · Offered only where AI_WRITE allows it, and never ticked for them.
      writes: aiWriteOn ? { mode: config.aiWrite as "standard" | "full", asked: parsed.ok.asksToWrite } : null,
    }));
    /*
     * The answer is a redirect to the app, and a browser holds a form's
     * redirects to the page's form-action — which is 'self' everywhere else,
     * so Chrome would block the hop to claude.ai and leave the member on a
     * blank page. This page, and only this page, also allows the one origin
     * the app registered, which the member is reading on it.
     */
    const target = new URL(redirectUri).origin;
    return {
      ...page,
      headers: {
        ...(page.headers ?? {}),
        "Content-Security-Policy": contentSecurityPolicy().replace(
          "form-action 'self'", `form-action 'self' ${target}`,
        ),
      },
    };
  });

  router.post("/oauth/authorize", (ctx) => {
    const a = consentGate(ctx);
    const parsed = oauth.parseAuthorizeRequest(db, config.baseUrl, (n) => field(ctx.body, n));
    if ("fatal" in parsed) {
      return { ...render(ctx, "Connect an app", renderConsentProblem(parsed.fatal, { apiTokens: config.features.apiTokens })), status: 400 };
    }
    if ("redirect" in parsed) return { redirect: parsed.redirect };

    const request = parsed.ok;
    if (field(ctx.body, "decision") !== "approve") {
      return {
        redirect: oauth.clientRedirect(config.baseUrl, request.redirectUri, {
          error: "access_denied", error_description: "The member declined.", state: request.state,
        }),
      };
    }
    const code = oauth.approveAuthorization(
      db, actorFor(a), request, {
        redact: field(ctx.body, "redact") === "1",
        write: aiWriteOn && field(ctx.body, "allow_changes") === "1",
      },
    );
    return {
      redirect: oauth.clientRedirect(config.baseUrl, request.redirectUri, { code, state: request.state }),
    };
  });

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
    }), { print: {} });
  });

  router.get("/months/:month/close", (ctx) => {
    auth(ctx);
    const month = ctx.params.month!;
    if (!isMonthKey(month)) throw new NotFound("That is not a month.");
    // 15 §6.1 · Each budget closes on its own, so it is the one being looked at.
    const budgetId = budgetParam(ctx);
    return render(
      ctx, `Closing ${formatMonth(month)}`,
      renderMonthClose(monthCloseView(db, month, todayIST(), budgetId, viewer(ctx))),
      { print: {} },
    );
  });

  router.post("/months/:month/close", (ctx) =>
    mutate(ctx, (a) => {
      const month = ctx.params.month!;
      if (!isMonthKey(month)) throw new NotFound("That is not a month.");

      const budgetId = postedBudget(ctx);
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
      reopenMonth(db, actorFor(a), month, postedBudget(ctx));
      return { redirect: "/months", message: `${formatMonth(month)} is open again.` };
    }),
  );

  // -------------------------------------------------------------------------
  // `04` §3.4 · Gmail ingestion — a separate, opt-in connection.
  // -------------------------------------------------------------------------

  /*
   * A mailbox link is a credential, like an API token, and it belongs to the
   * person at the keyboard. While viewing as somebody, these routes mixed the
   * two identities: connect and callback are GETs, so even a read-only view
   * replaced the viewed member's stored Gmail access with the viewer's own
   * mailbox (under the viewed member's id); with writes on, fetch read the
   * viewed member's mailbox with their refresh token, and disconnect deleted
   * their link while revoking the viewer's at Google. Impersonation is
   * session-only (R38.12), so none of them is offered during a view.
   */
  function refuseGmailWhileViewingAs(a: AuthContext): void {
    if (a.impersonating) {
      throw new HttpError(403, "Gmail cannot be connected, fetched or disconnected while viewing as another member.");
    }
  }

  /*
   * Google declining — a revoked grant, an expired refresh token, a code it
   * will not exchange — is the household's to fix by reconnecting, and
   * GmailAuthError already says so. Uncaught it was a plain Error: the
   * generic 500 page, and a fault on the health page for a mailbox somebody
   * disconnected at Google.
   */
  async function googleSaidNo<T>(call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (error) {
      if (error instanceof GmailAuthError) throw new HttpError(400, error.message);
      // DEBUG-WEB-7 · Google down or unreachable: a bad gateway, not a fault here.
      if (error instanceof GoogleUnreachable) throw new HttpError(502, error.message);
      throw error;
    }
  }

  router.get("/gmail/connect", (ctx) => {
    refuseInDemo(config, "Connecting a mailbox");
    const a = auth(ctx);
    refuseGmailWhileViewingAs(a);
    // GMAIL-BYO · The member's own keys, else the household's, else the
    // deployment's (only with FEATURE_GMAIL). None of them is a deployment
    // state, not a fault — the same 503 as /auth/google.
    const client = clientForConnect(db, config, a.member.id);
    if (!client) {
      throw new HttpError(503, config.features.gmailByo
        ? "Gmail cannot be connected yet: add your own Google keys in Settings first."
        : "Gmail cannot be connected: Google is not configured on this deployment.");
    }
    const start = beginGmailConnect({
      clientId: client.clientId,
      redirectUri: `${config.baseUrl}/gmail/callback`,
    });
    pendingGmail.set(start.state, {
      verifier: start.codeVerifier, memberId: a.member.id, clientId: client.clientId, at: Date.now(),
    });
    return { redirect: start.url };
  });

  router.get("/gmail/callback", async (ctx) => {
    const a = auth(ctx);
    refuseGmailWhileViewingAs(a);
    const state = ctx.query.get("state") ?? "";
    const pending = pendingGmail.take(state);
    if (!pending || pending.memberId !== a.member.id) {
      throw new HttpError(400, "That Gmail connection link has expired. Try again.");
    }
    const code = ctx.query.get("code");
    if (!code) return { redirect: "/settings#gmail" };

    // The code was issued to the client the connect step used; exchange it
    // under that one. If those keys changed in between, start again.
    const client = clientForConnect(db, config, a.member.id);
    if (!client || client.clientId !== pending.clientId) {
      throw new HttpError(400, "The Google keys changed while you were connecting. Connect Gmail again.");
    }
    const tokens = await googleSaidNo(() => exchangeGmailCode({
      clientId: client.clientId,
      clientSecret: client.clientSecret,
      redirectUri: `${config.baseUrl}/gmail/callback`,
      code, codeVerifier: pending.verifier, fetchImpl: deps.fetchImpl,
    }));

    saveConnection(db, actorFor(a), {
      email: a.member.email, refreshToken: tokens.refreshToken, scope: tokens.scope,
      // Null marks the deployment's own client, as connections before GMAIL-BYO.
      clientId: client.source === "deployment" ? null : client.clientId,
    }, config.secretsKey);
    return { redirect: withNotice("/settings#gmail", "Gmail connected. Fetch when you're ready.") };
  });

  router.post("/gmail/disconnect", (ctx) =>
    mutate(ctx, (a) => {
      refuseGmailWhileViewingAs(a);
      const connection = getConnection(db, a.member.id);
      if (connection) {
        // Best-effort remote revoke; the local token is deleted regardless —
        // including when it can no longer be opened here.
        let token: string | null = null;
        try { token = refreshTokenOf(connection, config.secretsKey); } catch { token = null; }
        if (token) void revokeGmailToken(token, deps.fetchImpl);
      }
      deleteConnection(db, actorFor(a));
      return { redirect: "/settings#gmail", message: "Disconnected. The stored access was deleted." };
    }),
  );

  router.post("/gmail/fetch", async (ctx) => {
    const a = auth(ctx);
    refuseGmailWhileViewingAs(a);
    const connection = getConnection(db, a.member.id);
    if (!connection) throw new HttpError(400, "Gmail is not connected.");
    // GMAIL-BYO · The token renews only under the client that issued it.
    const client = clientForConnection(db, config, a.member.id, connection.client_id);

    const result = await googleSaidNo(() => fetchGmail(db, actorFor(a, "import"), {
      clientId: client.clientId,
      clientSecret: client.clientSecret,
      secretsKey: config.secretsKey,
      fetchImpl: deps.fetchImpl,
    }));

    /*
     * Each count says where it went. Every count used to end "all in Review":
     * alerts no account matched were "to an unknown account, all in Review"
     * though nothing was staged for them, rows a rule auto-approved were
     * counted as waiting, and a statement no password opened, or no account
     * matched, was not mentioned at all.
     */
    const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
    const toReview = result.alerts.staged + result.statements.staged - result.autoApproved;
    const imported = [
      ...(result.alerts.staged ? [plural(result.alerts.staged, "alert")] : []),
      ...(result.statements.staged ? [plural(result.statements.staged, "statement row")] : []),
    ];
    const parts: string[] = [];
    if (imported.length) {
      parts.push(`${imported.join(" and ")} ${result.autoApproved
        ? `(${toReview} in Review, ${result.autoApproved} auto-approved)` : "in Review"}`);
    }
    if (result.alerts.unmatched) {
      parts.push(`${plural(result.alerts.unmatched, "alert")} for no account of yours I could pick out, not imported`);
    }
    // IMPORTS-SCHEDULES-34 · an alert it could not read is said, not dropped.
    if (result.alerts.unread) {
      parts.push(`${plural(result.alerts.unread, "alert")} it could not read — add ${result.alerts.unread === 1 ? "that one" : "those"} by hand`);
    }
    if (result.statements.locked) {
      parts.push(`${plural(result.statements.locked, "statement")} I could not open — check the statement details in Settings`);
    }
    if (result.statements.unmatched) {
      parts.push(`${plural(result.statements.unmatched, "statement")} for no single account of yours, not imported`);
    }
    // IMP-33 · SafeGold statements, read and waiting on their review.
    const goldReview = result.gold.token && result.gold.newEntries > 0 && config.features.assets;
    if (result.gold.statements) {
      parts.push(`${plural(result.gold.statements, "SafeGold statement")} — ` + (result.gold.newEntries
        ? `${result.gold.newEntries} new gold ${result.gold.newEntries === 1 ? "entry" : "entries"} to confirm`
        : "nothing new in it"));
    }
    // IMPORT-15 · Which detail would open the locked ones, as the upload says it.
    const missing = result.missingDetails.length ? ` ${result.missingDetails.join(" ")}` : "";
    /*
     * IMP-20 · The cards whose digits would open the locked ones are listed on
     * Settings, each with a box for them, so the fetch lands there rather than
     * on Review. The URL carries ids and how many digits each needs, never a
     * digit; Settings re-checks each id against what this member can see.
     */
    const asks = result.cardDigitsNeeded;
    const askNote = asks.length
      ? ` Enter ${asks.length === 1 ? "that card's digits" : "those cards' digits"} below and the next fetch will open ${result.statements.locked === 1 ? "it" : "them"}.`
      : "";
    const summary = parts.length
      ? `Read ${result.scanned} messages — ${parts.join(", ")}.${missing}${askNote}`
      : `Read ${result.scanned} messages — nothing new.`;

    // Locked cards land on Settings for their digits. The fetch has already
    // moved past the SafeGold mail, so a gold plan read in the same fetch
    // rides along as `gold=` and Settings links to its review.
    if (asks.length) {
      const list = asks.map((c) => `${encodeURIComponent(c.accountId)}:${c.digits}`).join(",");
      const gold = goldReview ? `&gold=${encodeURIComponent(result.gold.token!)}` : "";
      return { redirect: withNotice(`/settings?card_digits=${list}${gold}#card-digits`, summary) };
    }
    if (goldReview) {
      return { redirect: withNotice(`/portfolio/safegold/review?token=${encodeURIComponent(result.gold.token!)}`, summary) };
    }
    return { redirect: withNotice(toReview > 0 ? "/review" : "/settings#gmail", summary) };
  });

  /**
   * GMAIL-BYO · Your own Google OAuth client, or the household's. Any member
   * may set the household's — a household has no admin — and the event log
   * says who did. A blank secret with `clear=1` removes the keys; a saved
   * connection made with them then asks to be reconnected.
   */
  router.post("/gmail/keys", (ctx) =>
    mutate(ctx, (a) => {
      refuseInDemo(config, "Saving Google keys");
      refuseGmailWhileViewingAs(a);
      const scope = field(ctx.body, "scope") === HOUSEHOLD ? "household" : "member";
      if (field(ctx.body, "clear") === "1") {
        clearClient(db, actorFor(a), scope);
        return {
          redirect: "/settings#gmail",
          message: scope === "household" ? "Removed the household's Google keys." : "Removed your Google keys.",
        };
      }
      saveClient(db, config, actorFor(a), {
        scope,
        clientId: requiredField(ctx.body, "client_id"),
        clientSecret: requiredField(ctx.body, "client_secret"),
      });
      return {
        redirect: "/settings#gmail",
        message: (scope === "household" ? "Saved the household's Google keys." : "Saved your Google keys.") +
          " Connect Gmail when you're ready.",
      };
    }),
  );

  /**
   * IMP-20 · The card's digits, from the list a Gmail fetch left on Settings.
   * Saved on the card account as the import saves them: the last four for SMS
   * matching, up to eight kept beside them for statement passwords. Not
   * checked against a statement here — there is none — so the next fetch is
   * what tries them. Never echoed: the notice shows the last two.
   */
  // -------------------------------------------------------------------------
  // FWD · The forwarding address (src/forwarding/, docs/forwarding.md)
  // -------------------------------------------------------------------------

  function forwardingView(memberId: string): import("./web/pages/forwarding.ts").ForwardingView {
    const row = addressRow(db, memberId);
    return {
      ready: config.inbound.domain !== null && config.inbound.secret !== null,
      address: row ? formatAddress(config.inbound, row.token) : null,
      createdAt: row?.created_at ?? null,
      lastReceivedAt: row?.last_received_at ?? null,
      confirmation: row ? pendingConfirmation(db, memberId) : null,
      recent: listForwardedMail(db, memberId),
      held: listHeld(db, memberId),
      canHold: config.secretsKey !== null,
      senders: bankSenders(),
    };
  }

  /** An address is the member's own, like a Gmail connection: not while viewing as another. */
  function refuseForwardingWhileViewingAs(a: AuthContext): void {
    refuseInDemo(config, "A forwarding address");
    if (a.impersonating) {
      throw new HttpError(403, "A forwarding address cannot be changed while viewing as another member.");
    }
  }

  router.post("/forwarding/create", (ctx) =>
    mutate(ctx, (a) => {
      refuseForwardingWhileViewingAs(a);
      if (!config.inbound.domain || !config.inbound.secret) {
        throw new Refusal("Forwarding is not set up on this server yet (INBOUND_DOMAIN and INBOUND_SECRET).");
      }
      const replacing = addressRow(db, a.member.id) !== null;
      issueAddress(db, actorFor(a));
      return {
        redirect: "/settings#forwarding",
        message: replacing
          ? "New address made. The old one no longer takes mail: update your filter."
          : "Your forwarding address is ready. Set up the filter below.",
      };
    }),
  );

  router.post("/forwarding/remove", (ctx) =>
    mutate(ctx, (a) => {
      refuseForwardingWhileViewingAs(a);
      removeAddress(db, actorFor(a));
      return { redirect: "/settings#forwarding", message: "Forwarding is off. Mail to the old address is refused." };
    }),
  );

  router.post("/forwarding/held/:id/delete", (ctx) =>
    mutate(ctx, (a) => {
      refuseForwardingWhileViewingAs(a);
      if (!deleteHeld(db, a.member.id, ctx.params.id!)) throw new NotFound();
      return { redirect: "/settings#forwarding", message: "Deleted that statement." };
    }),
  );

  router.post("/forwarding/retry", async (ctx) => {
    const a = auth(ctx);
    refuseForwardingWhileViewingAs(a);
    const { result, opened, still, unmatched, unreadable } = await retryHeld(db, actorFor(a, "import"), config.secretsKey);
    const imported = result.alerts.staged + result.statements.staged;
    const parts = [
      opened ? `Opened ${opened} ${opened === 1 ? "statement" : "statements"}` +
        (imported ? `: ${imported} ${imported === 1 ? "row" : "rows"} imported` : "") : null,
      still ? `${still} still locked.${result.missingDetails.length ? ` ${result.missingDetails.join(" ")}` : ""}` : null,
      // MAIL-3 · Opened but kept: say why, so the account can be set up.
      unmatched ? `${unmatched} opened but ${unmatched === 1 ? "is" : "are"} for no single account of yours, so ` +
        `${unmatched === 1 ? "it is" : "they are"} kept: add the account (or close the duplicate) and try again` : null,
      unreadable ? `${unreadable} could not be read back (SECRETS_KEY changed); delete ${unreadable === 1 ? "it" : "them"} and forward again` : null,
    ].filter((p): p is string => p !== null);
    const message = parts.length ? parts.join(". ") : "Nothing was waiting.";
    return { redirect: withNotice(imported > result.autoApproved ? "/review" : "/settings#forwarding-held", message) };
  });

  router.post("/gmail/card-digits", (ctx) =>
    mutate(ctx, (a) => {
      refuseGmailWhileViewingAs(a);
      const account = requireVisibleAccount(ctx, requiredField(ctx.body, "account_id"));
      if (account.kind !== "credit" || account.closed_at) {
        throw new Refusal("Only an open card account records a card's digits.");
      }
      const digits = parseCardNumber(field(ctx.body, "card_digits") ?? "", { card: true });
      if (!digits) throw new Refusal("Enter the card number's last four to eight digits.");
      if (account.last4 && account.last4 !== digits.slice(-4)) {
        throw new Refusal(
          `Those digits end differently from the last four recorded on ${account.nickname || account.name}. ` +
          "Check the card, or change the account's number on its page.",
        );
      }
      setCardNumberDigits(db, actorFor(a), account.id, digits);
      return {
        redirect: "/settings#gmail",
        message: `Saved the card's last ${digits.length} digits (ending ••${digits.slice(-2)}) on ` +
          `${account.nickname || account.name}. The next fetch will try them.`,
      };
    }),
  );

  /**
   * IMP-20 · The cards a fetch asked digits for, from `?card_digits=id:n,…`,
   * kept only when this member can see the account, it is an open card, and
   * it still has fewer than n digits on file. A forged list can therefore show
   * a member nothing but forms for their own cards that genuinely lack digits.
   */
  /** A SafeGold plan a fetch staged before landing on Settings, if still open for this member. */
  function pendingGoldToken(ctx: RequestContext, memberId: string): string | null {
    const token = ctx.query.get("gold");
    return token && peekSafeGoldPlan(token, memberId) ? token : null;
  }

  function cardDigitAsks(ctx: RequestContext): { accountId: string; name: string; digits: 4 | 6 }[] {
    const raw = ctx.query.get("card_digits");
    if (!raw) return [];
    const visible = new Map(
      listAccounts(db, { viewerMemberId: viewer(ctx) }).map((acc) => [acc.id, acc] as const),
    );
    const asks: { accountId: string; name: string; digits: 4 | 6 }[] = [];
    for (const item of raw.split(",").slice(0, 20)) {
      const [id, n] = item.split(":");
      const digits = n === "6" ? 6 : n === "4" ? 4 : null;
      const account = id ? visible.get(id) : undefined;
      if (!digits || !account || account.kind !== "credit" || account.closed_at) continue;
      if ((cardNumberDigits(db, account.id) ?? "").length >= digits) continue;
      if (asks.some((x) => x.accountId === account.id)) continue;
      asks.push({ accountId: account.id, name: account.nickname || account.name, digits });
    }
    return asks;
  }

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
        // Shown masked and never sent back, so a blank box keeps the saved ID.
        customerIds: Object.fromEntries(
          (["axis", "hdfc"] as const)
            .map((bank) => [bank, field(ctx.body, `customer_id_${bank}`)] as const)
            .filter(([, value]) => Boolean(value)),
        ),
        // IMPORT-15 · Masked the same way, so a blank box keeps the saved six.
        hsbcCardLast6: field(ctx.body, "hsbc_card_last6") || undefined,
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
    const scope = holderScopeParam(ctx);
    return render(
      ctx, "Portfolio",
      renderPortfolio(portfolioData(db, { viewerMemberId: viewer(ctx), scope })),
    );
  });

  // -------------------------------------------------------------------------
  // `07` F19.14 · CAS import. A MUST at P1 per Q17 and errata E10.
  // -------------------------------------------------------------------------

  router.get("/portfolio/cas", (ctx) => {
    requireAssets();
    auth(ctx);
    return render(ctx, "Import a CAS", renderCasUpload({
      accounts: casDestinations(db, viewer(ctx)),
      error: ctx.query.get("error") === "expired"
        ? "That statement is no longer open — read it again and confirm within half an hour."
        : null,
    }));
  });

  router.post("/portfolio/cas", (ctx) => {
    requireAssets();
    const a = auth(ctx);

    const upload = fileField(ctx.req, "statement");
    if (!upload) {
      return render(ctx, "Import a CAS", renderCasUpload({
        accounts: casDestinations(db, viewer(ctx)),
        error: "Choose the statement PDF first.",
      }));
    }

    // PR5 · The password lives exactly this long. It is read from the request,
    // handed to the parser, and never assigned to anything that outlives the
    // call — not the plan, not the stash, not the event log.
    const password = field(ctx.body, "password") ?? "";
    const accountId = requireVisibleAccount(ctx, requiredField(ctx.body, "account_id")).id;

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
        accounts: casDestinations(db, viewer(ctx)), error: message,
      }));
    }

    if (statement.schemes.length === 0) {
      return render(ctx, "Import a CAS", renderCasUpload({
        accounts: casDestinations(db, viewer(ctx)),
        error:
          "That PDF opened, but no folios were found in it. If it is a CAS, " +
          "it may be a format this app has not seen — nothing was imported.",
      }));
    }

    const plan = planCasImport(db, statement, accountId, viewer(ctx));
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

      // REV-1 · Left in the stash until it is applied: a refusal can be retried.
      const token = requiredField(ctx.body, "token");
      const plan = peekPlan(token, a.member.id);
      if (!plan) {
        return {
          // A fixed key, not the text: the page shows only errors it knows
          // (SECURITY-D4), so a link cannot put its own words there.
          redirect: "/portfolio/cas?error=expired",
        };
      }

      const chosen = fieldList(ctx.body, "scheme").map(Number).filter(Number.isInteger);
      if (chosen.length === 0) {
        return { redirect: "/portfolio", message: "Nothing was ticked, so nothing was imported." };
      }

      const result = applyCasPlan(
        db, actorFor(a, "ui", ctx.req.headers["idempotency-key"] as string), plan, chosen,
      );
      takePlan(token, a.member.id);

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

  // -------------------------------------------------------------------------
  // IMP-32 · SafeGold statement import — digital gold, the way a CAS is funds.
  // -------------------------------------------------------------------------

  /** Plan, stash and show what the statements would record. Nothing is written. */
  function safeGoldReview(ctx: RequestContext, memberId: string, statements: SafeGoldStatement[]) {
    const plan = planSafeGoldImport(db, statements, viewer(ctx));
    const token = newId();
    stashSafeGoldPlan(token, plan, memberId);
    return render(ctx, "What this SafeGold statement says", renderSafeGoldReview({ plan, token }));
  }

  router.get("/portfolio/safegold", (ctx) => {
    requireAssets();
    auth(ctx);
    return render(ctx, "Import a SafeGold statement", renderSafeGoldUpload({
      error: ctx.query.get("error") === "expired"
        ? "That statement is no longer open — read it again and confirm within half an hour."
        : null,
    }));
  });

  router.post("/portfolio/safegold", (ctx) => {
    requireAssets();
    const a = auth(ctx);
    const again = (error: string) =>
      render(ctx, "Import a SafeGold statement", renderSafeGoldUpload({ error }));
    const upload = fileField(ctx.req, "statement");
    if (!upload) return again("Choose the statement PDF first.");

    // PR5 · Typed, or worked out from the saved details; used here and gone.
    const typed = field(ctx.body, "password") ?? "";
    const identity = getIdentity(db, a.member.id);
    const candidates = typed !== "" ? [typed] : identity ? [...passwordCandidates(identity, null, {}), ""] : [""];
    let statement: SafeGoldStatement | null = null;
    let text = "";
    let notAStatement: string | null = null;
    for (const candidate of candidates) {
      try {
        const parsed = parseStatementPdf(upload.bytes, candidate);
        text = parsed.text;
        notAStatement = parsed.notAStatement ?? null;
        statement = isSafeGoldText(text) ? parseSafeGoldText(text) : null;
        break;
      } catch (error) {
        if (error instanceof StatementWrongPassword || error instanceof WrongPassword) continue;
        return again(`That file could not be read. ${(error as Error).message}`);
      }
    }
    if (!text && !statement) {
      return again(identity && typed === ""
        ? "None of the passwords worked out from your saved details opened this. Type it above."
        : "That password did not open the statement. It is the first four letters of your name " +
          "in capitals, then your mobile's last four.");
    }
    // IMP-35 · Gold bought through a partner bank's app: a balance with no rows.
    if (!statement && notAStatement === SAFEGOLD_DISTRIBUTOR_BALANCE) {
      return again(`That PDF is ${SAFEGOLD_DISTRIBUTOR_BALANCE}. It lists no transactions, so there is nothing to import.`);
    }
    if (!statement) {
      return again("That PDF opened, but it is not a SafeGold statement — nothing was imported.");
    }
    return safeGoldReview(ctx, a.member.id, [statement]);
  });

  /** The review of a plan read elsewhere — a Gmail fetch — while it is still open. */
  router.get("/portfolio/safegold/review", (ctx) => {
    requireAssets();
    const a = auth(ctx);
    const token = ctx.query.get("token") ?? "";
    const plan = peekSafeGoldPlan(token, a.member.id);
    if (!plan) return { redirect: "/portfolio/safegold?error=expired" };
    return render(ctx, "What this SafeGold statement says", renderSafeGoldReview({ plan, token }));
  });

  router.post("/portfolio/safegold/confirm", (ctx) =>
    mutate(ctx, (a) => {
      requireAssets();
      // REV-1 · Left in the stash until it is applied: a refused confirmation
      // can be retried with "import it anyway".
      const token = requiredField(ctx.body, "token");
      const plan = peekSafeGoldPlan(token, a.member.id);
      if (!plan) return { redirect: "/portfolio/safegold?error=expired" };
      const result = applySafeGoldPlan(
        db, actorFor(a, "ui", ctx.req.headers["idempotency-key"] as string), plan,
        { acceptMismatch: field(ctx.body, "accept_mismatch") === "1" },
      );
      takeSafeGoldPlan(token, a.member.id);
      if (result.lots + result.sales === 0) {
        return { redirect: "/portfolio", message: "Nothing new in that statement, so nothing was recorded." };
      }
      const parts = [`${result.lots} ${result.lots === 1 ? "purchase" : "purchases"}`];
      if (result.sales > 0) parts.push(`${result.sales} ${result.sales === 1 ? "sale" : "sales"}`);
      return {
        redirect: "/portfolio",
        message: `Recorded ${parts.join(", ")} of SafeGold gold. Undo it from Activity if it is not right.`,
      };
    }),
  );

  router.get("/portfolio/add", (ctx) => {
    requireAssets();
    const query = ctx.query.get("q") ?? "";
    const view = buildBudgetView(db, undefined, undefined, viewer(ctx));
    // WEALTH-12 · The scheme just chosen from the search, which the purchase
    // form now carries through to the purchase.
    const chosenId = ctx.query.get("instrument");
    const chosen = chosenId ? getInstrument(db, requireVisibleInstrument(ctx, chosenId)) : null;

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
            .filter((c) => !c.isPaymentCategory && !c.commitsToBudgetId && !c.hidden)
            .map((c) => ({ id: c.id, name: c.name })),
          searchResults: results,
          query,
          today: todayIST(),
          chosen: chosen
            ? { id: chosen.id, name: chosen.name, kind: chosen.kind, currency: chosen.currency }
            : null,
          accountId: ctx.query.get("account"),
        }),
      ),
    );
  });

  router.post("/portfolio/add", (ctx) =>
    mutate(ctx, (a) => {
      requireAssets();
      const actor = actorFor(a, "ui", ctx.req.headers["idempotency-key"] as string);

      const schemeCode = field(ctx.body, "scheme_code");
      /*
       * WEALTH-12 · A purchase of an instrument already chosen goes to it. The
       * form after "Choose" was the blank by-hand one, so the purchase made a
       * second, manual instrument with no scheme code — the chosen AMFI scheme
       * was left with nothing in it and the holding never got a NAV.
       */
      const chosenId = field(ctx.body, "instrument_id");
      const typedInstrument = () => {
        const symbol = schemeCode ?? field(ctx.body, "symbol") ?? null;
        const typed = {
          name: requiredField(ctx.body, "name"),
          kind: (field(ctx.body, "kind") ?? "mutual-fund") as InstrumentKind,
          currency: field(ctx.body, "currency") || "INR",
        };
        // BONDS-1 · The by-hand form asks whether a bond is listed; a tick is
        // a yes and no tick a no. Any other kind leaves it unrecorded.
        /*
         * ENG-15 · And whether a share is listed on a recognised stock exchange,
         * ticked to start. Only a form that asked (share_listed_asked) can say
         * no by leaving it unticked; a post that never asked leaves it
         * unrecorded, which a share is taxed as listed for.
         */
        const listed = typed.kind === "bond"
          ? field(ctx.body, "listed") === "1"
          : typed.kind === "equity" && field(ctx.body, "share_listed_asked") === "1"
            ? field(ctx.body, "share_listed") === "1"
            : null;
        // WEALTH-11 · The same name typed again is the same instrument.
        const found = symbol ? null : findManualInstrument(db, typed, memberScope(db, viewer(ctx)).instruments);
        if (found) {
          if (listed !== null) setInstrumentListed(db, actor, found.id, listed);
          return getInstrument(db, found.id)!;
        }
        return findOrCreateInstrument(db, actor, { ...typed, symbol, listed, provider: schemeCode ? "mfapi" : "manual" });
      };
      const instrument = chosenId
        ? getInstrument(db, requireVisibleInstrument(ctx, chosenId))!
        : typedInstrument();

      // Choosing a scheme from the search is step one; the purchase follows.
      if (field(ctx.body, "step") === "details") {
        return {
          redirect: `/portfolio/add?instrument=${encodeURIComponent(instrument.id)}`,
          message: `${instrument.name} is ready — enter the purchase below.`,
        };
      }

      const amountRaw = field(ctx.body, "amount");
      const unitPrice = unitPriceField(field(ctx.body, "unit_price"));

      const feesRaw = field(ctx.body, "fees");
      // R33 · Blank means "use the stored rate for the trade date" — the domain
      // looks it up and refuses when there is none, rather than booking at 1.
      const fxRaw = field(ctx.body, "fx_rate")?.trim();
      const lot = recordPurchase(db, actor, {
        accountId: requireVisibleAccount(ctx, requiredField(ctx.body, "account_id")).id,
        instrumentId: instrument.id,
        tradeDate: dateField(field(ctx.body, "trade_date"), "Trade date"),
        price: unitPrice,
        amount: amountRaw?.trim() ? amountField(amountRaw) : undefined,
        units: amountRaw?.trim() ? undefined : toUnits(Number(field(ctx.body, "units") ?? 0)),
        fees: feesRaw?.trim() ? amountField(feesRaw) : 0,
        fxRate: fxRaw ? Number(fxRaw) : null,
        fromAccountId: visibleAccountField(ctx, "from_account_id"),
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
    const a = assetAllocation(db, todayIST(), "INR", { viewerMemberId: viewer(ctx) });
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
      classifyInstrument(db, actorFor(a), requireVisibleInstrument(ctx, ctx.params.id!), { assetClass });
      return { redirect: "/portfolio/allocation", message: assetClass ? "Classified." : "Cleared." };
    }),
  );

  // BONDS-1 · Whether a bond is listed, from its holding page. ENG-15 · A share's too.
  router.post("/portfolio/instrument/:id/listed", (ctx) =>
    mutate(ctx, (a) => {
      requireAssets();
      const id = requireVisibleInstrument(ctx, ctx.params.id!);
      setInstrumentListed(db, actorFor(a), id, field(ctx.body, "listed") === "1");
      const holdingId = field(ctx.body, "holding_id");
      return {
        redirect: holdingId ? `/portfolio/${encodeURIComponent(requireVisibleHolding(ctx, holdingId))}` : "/portfolio",
        message: "Saved.",
      };
    }),
  );

  router.get("/portfolio/:id", (ctx) => {
    requireAssets();
    const view = viewHolding(db, requireVisibleHolding(ctx, ctx.params.id!));
    if (!view) throw new NotFound("That holding does not exist.");
    const account = listAssetAccounts(db, { viewerMemberId: viewer(ctx) }).find((a) => a.id === view.holding.account_id);

    return render(
      ctx, view.instrument.name,
      renderHoldingDetail({
        features: config.features,
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
    const view = viewHolding(db, requireVisibleHolding(ctx, ctx.params.id!));
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
      const view = viewHolding(db, requireVisibleHolding(ctx, ctx.params.id!));
      if (!view) throw new NotFound("That holding does not exist.");
      recordPrice(db, {
        instrumentId: view.instrument.id,
        price: unitPriceField(field(ctx.body, "price")),
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
    const view = viewHolding(db, requireVisibleHolding(ctx, ctx.params.id!));
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
      const view = viewHolding(db, requireVisibleHolding(ctx, ctx.params.id!));
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
    const view = viewHolding(db, requireVisibleHolding(ctx, ctx.params.id!));
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
      const view = viewHolding(db, requireVisibleHolding(ctx, ctx.params.id!));
      if (!view) throw new NotFound("That holding does not exist.");
      const ratio = Number(requiredField(ctx.body, "ratio"));
      if (!Number.isFinite(ratio) || ratio <= 0) {
        throw new HttpError(400, "A merger ratio has to be a number above zero.");
      }
      recordMerger(db, actorFor(a, "ui", ctx.req.headers["idempotency-key"] as string), {
        holdingId: view.holding.id,
        date: dateField(field(ctx.body, "date")),
        ratio,
        intoInstrumentId: field(ctx.body, "into_instrument_id")
          ? requireVisibleInstrument(ctx, field(ctx.body, "into_instrument_id")!)
          : null,
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
    const view = viewHolding(db, requireVisibleHolding(ctx, ctx.params.id!));
    if (!view) throw new NotFound("That holding does not exist.");

    const unitsRaw = ctx.query.get("units") ?? "";
    const priceRaw = ctx.query.get("price") ?? (view.quote ? String(view.quote.price / 1_000_000) : "");
    const fxRaw = ctx.query.get("fx_rate")?.trim() ?? "";

    let preview = null;
    let error: string | null = null;
    if (unitsRaw && priceRaw) {
      const quantity = toUnits(Number(unitsRaw));
      const unitPrice = toUnitPrice(parseUnitPrice(priceRaw) ?? NaN);
      if (quantity > 0 && unitPrice > 0 && quantity <= view.units) {
        try {
          preview = previewHoldingSale(db, view.holding.id, quantity, unitPrice, {
            saleDate: todayIST(),
            fxRate: fxRaw ? Number(fxRaw) : null,
          });
        } catch (err) {
          // A foreign holding with no rate for today: say so on the form.
          if (!(err instanceof Refusal)) throw err;
          error = err.message;
        }
      }
    }

    return render(
      ctx, `Sell ${view.instrument.name}`,
      renderSalePreview({
        view, preview,
        unitsToSell: unitsRaw,
        priceInput: priceRaw,
        fxInput: fxRaw,
        error,
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
      const holdingId = requireVisibleHolding(ctx, ctx.params.id!);
      const chargesRaw = field(ctx.body, "charges");
      const fxRaw = field(ctx.body, "fx_rate")?.trim();
      const preview = recordSale(db, actorFor(a, "ui", ctx.req.headers["idempotency-key"] as string), {
        holdingId,
        units: toUnits(Number(requiredField(ctx.body, "units"))),
        price: unitPriceField(field(ctx.body, "price")),
        // R27 · Realised gains are reported by financial year, so a sale
        // recorded late under today's date lands in the wrong year's figure.
        date: dateField(field(ctx.body, "date"), "Date of sale"),
        charges: chargesRaw?.trim()
          ? (Math.abs(amountField(chargesRaw, "Charges")) as Paise)
          : undefined,
        toAccountId: visibleAccountField(ctx, "to_account_id"),
        // R33 · Converted at the sale-date rate; blank uses the stored one.
        fxRate: fxRaw ? Number(fxRaw) : null,
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

    // EXTRA-5 · Bounded: a few seconds a provider, twelve in all, and what
    // was not reached in that time is reported rather than waited for.
    const outcome = await refreshPrices(db, actorFor(a, "ui"), {
      force: true,
      alphaVantageKey: config.alphaVantageKey,
      fetchImpl: deps.fetchImpl,
      ...MANUAL_REFRESH,
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
        (outcome.failed === 0 && outcome.unfinished === 0
          ? `Refreshed ${outcome.updated} prices.`
          : `Refreshed ${outcome.updated}. ` +
            (outcome.failed ? `${outcome.failed} couldn't be fetched` : "") +
            (outcome.failed && outcome.unfinished ? `, and ` : "") +
            (outcome.unfinished
              ? `${outcome.unfinished} weren't reached before the providers ran out of time`
              : "") +
            ` — cached prices are still shown, with their dates.`) +
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
        features: config.features,
        scope,
        members: listMembers(db).map((m) => ({ id: m.id, name: m.name })),
        statement,
        change: previous ? netWorthChange(db, previous.as_of, todayIST()) : null,
        history,
      }),
      { print: {} },
    );
  });

  router.post("/net-worth/snapshot", (ctx) =>
    mutate(ctx, (a) => {
      requireAssets();
      const snapshot = snapshotNetWorth(db, actorFor(a));
      return {
        redirect: "/net-worth",
        message: `Recorded ${formatPaise(snapshot.net_worth)} as of ${formatDate(snapshot.as_of)}.`,
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
      features: config.features,
      today: todayIST(),
      subtype: ctx.query.get("subtype"),
      members: listMembers(db).map((m) => ({ id: m.id, name: m.name })),
      payFrom: listAccounts(db, { viewerMemberId: viewer(ctx) })
        .filter((acc) => acc.kind === "budget")
        .map((acc) => ({ id: acc.id, name: acc.name })),
      categories: [...buildBudgetView(db, undefined, undefined, viewer(ctx)).categories.values()]
        .filter((c) => !c.hidden && !c.isPaymentCategory && !c.commitsToBudgetId)
        .map((c) => ({ id: c.id, name: c.name })),
    }));
  });

  router.post("/portfolio/asset/new", (ctx) =>
    mutate(ctx, (a) => {
      requireAssets();
      // UI-4 · An investment account is worth its holdings (derivedWorth), so a
      // value typed for one would be stored and never read.
      const subtype = requiredField(ctx.body, "subtype") as "physical";
      const valueRaw = (subtype as string) === "investment" ? undefined : field(ctx.body, "value");
      const holder = guardedField(ctx, "holder_member_id", requireMember);
      const visibility = field(ctx.body, "visibility") === "private" ? "private" : "household";
      // WEB-4 · WEB-1's rule at creation: private only to whoever adds it.
      refuseForeignPrivate(a, null, holder, visibility, "asset");
      const account = createAssetAccount(db, actorFor(a), {
        holderMemberId: holderOrSoleMember(holder),
        visibility,
        name: requiredField(ctx.body, "name"),
        subtype,
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
          // Only the kinds you state by hand, and deposits with terms — whose
          // computed figure a passbook can correct. A deposit without terms is
          // worth its balance.
          .filter((a) => statable(a))
          .filter((a) => listHoldings(db, a.id).length === 0)
          .map((a) => {
            const valuation = standingValuation(db, a.id);
            return {
              id: a.id, name: a.name, subtype: a.subtype, currency: a.currency,
              value: valuation?.value ?? (0 as Paise),
              asOf: valuation?.asOf ?? null,
              stale: valuation?.stale ?? false,
              valued: valuation !== null,
              source: valuation?.source ?? null,
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
        .filter((x) => statable(x))
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
  /*
   * WEALTH-27 · "Add to it" and "Sell" are for what is valued by hand. They
   * took any visible account: adding ₹10,000 to a fixed deposit stated its
   * value as ₹10,000, overriding the ₹1,00,000 balance it is worth; "Sell" on
   * a demat closed it with its shares in it, and on the bank closed the bank.
   * The same test /revalue makes, plus: an account whose worth is its unit
   * holdings has no stated value to change.
   */
  /**
   * DEPOSITS · Whose worth can be stated by hand: the hand-valued kinds, and a
   * deposit with terms, where a passbook figure dated on or after the computed
   * one's basis date wins over it (standingValuation).
   */
  function statable(account: { id: string; subtype: string }): boolean {
    return REVALUABLE_SUBTYPES.has(account.subtype) || getDepositTerms(db, account.id) !== null;
  }

  function requireHandValuedAsset(ctx: RequestContext, id: string) {
    const account = listValuableAccounts(db, { viewerMemberId: viewer(ctx) }).find((acc) => acc.id === id);
    if (!account) throw new NotFound("That asset does not exist.");
    if (!REVALUABLE_SUBTYPES.has(account.subtype)) {
      throw new Refusal(
        `${account.name} is worth its balance, so there is no stated value to change. ` +
        "Record money paid in or taken out as a transfer, and closing it from its account page.",
      );
    }
    if (queryOne(db, `SELECT 1 FROM holdings WHERE account_id = ? AND closed_at IS NULL`, account.id)) {
      throw new Refusal(
        `${account.name} is worth its holdings. Buy and sell them from the portfolio instead.`,
      );
    }
    return getAccount(db, account.id)!;
  }

  router.get("/portfolio/asset/:id/add", (ctx) => {
    requireAssets();
    auth(ctx);
    const account = requireHandValuedAsset(ctx, ctx.params.id!);
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
        .filter((c) => !c.hidden && !c.isPaymentCategory && !c.commitsToBudgetId)
        .map((c) => ({ id: c.id, name: c.name })),
    }));
  });

  router.post("/portfolio/asset/:id/add", (ctx) =>
    mutate(ctx, (a) => {
      requireAssets();
      const account = requireHandValuedAsset(ctx, ctx.params.id!);
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
    const account = requireHandValuedAsset(ctx, ctx.params.id!);
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
      const account = requireHandValuedAsset(ctx, ctx.params.id!);
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
    const valuation = standingValuation(db, account.id);
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
      if (!statable(account)) {
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
  function healthGroups(viewerMemberId: string | null): HealthGroup[] {
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
    const queue = reviewCount(db, viewerMemberId);
    const visibleCount = hiddenTransactionSql("t", viewerMemberId);

    return [
      {
        name: "Application",
        checks: [
          {
            name: "Version",
            state: "healthy",
            reason: `${VERSION}, running in ${config.environment}.`,
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
            // PLAN-1 · The preset, and what differs from everything-on, so the
            // operator can see at 2am which modules this instance has.
            reason: (() => {
              const off = FEATURE_NAMES.filter((name) => !config.features[name]).map((name) => FEATURE_ENV[name]);
              const members = config.limits.maxMembers === null ? "no member limit" : `up to ${config.limits.maxMembers} members`;
              const backups = config.limits.backupRetentionDays === null
                ? "the newest 14 backups kept"
                : config.limits.backupRetentionDays === Number.POSITIVE_INFINITY
                  ? "daily backups kept with no age limit"
                  : `backups kept ${config.limits.backupRetentionDays} days`;
              return `Plan ${config.plan}: ${off.length === 0 ? "every module on" : `off: ${off.join(", ")}`}; ${members}; ${backups}.`;
            })(),
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
              ?? `Cover the current financial year. Last checked ${formatDate(RATES_VERIFIED_ON)} against ${RATES_SOURCE}.`,
          },
        ],
      },
      {
        name: "Data",
        checks: [
          {
            name: "Database",
            state: "healthy",
            // 15 · The transactions the reader can see: a household-wide count
            // moved whenever somebody spent privately.
            reason: `Connected. ${queryOne<{ n: number }>(
              db,
              `SELECT COUNT(*) AS n FROM transactions t
                WHERE t.deleted_at IS NULL AND NOT ${visibleCount.sql}`,
              ...visibleCount.params,
            )?.n ?? 0} transactions, ` +
              `${queryOne<{ n: number }>(db, `SELECT COUNT(*) AS n FROM events`)?.n ?? 0} events.`,
          },
          {
            name: "Review queue",
            state: queue === 0 ? "healthy" : queue > 25 ? "degraded" : "healthy",
            reason:
              queue === 0
                ? "Nothing waiting."
                : `${queue} item${queue === 1 ? "" : "s"} waiting for a decision.`,
            action: queue > 0 ? { label: "Open", href: "/review", method: "get" } : null,
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

  router.get("/health", (ctx) => render(ctx, "Health", renderHealth(healthGroups(viewer(ctx)), { aiEnabled })));

  /*
   * SECURITY-OPS-24 · On the demo anyone is signed in, and each of these is a
   * synchronous full-database read on the one event loop — a backup also a
   * whole VACUUM INTO copy on a disk the reset does not clear. Twenty POSTs
   * were twenty files until the six-hourly prune. The demo's job runs them
   * anyway; a visitor has no reason to. And a manual backup now prunes like the
   * scheduled one, so a household pressing the button cannot fill the disk
   * either.
   */
  router.post("/health/backup", (ctx) =>
    mutate(ctx, (a) => {
      refuseInDemo(config, "Taking backups");
      const backup = createBackup(db, config.backupDir);
      pruneBackups(config.backupDir);
      recordJobRun(db, "backup", "ok", `${backup.path} (${backup.bytes} bytes)`);
      appendEvent(db, actorFor(a, "job"), {
        entity: "backup", entityId: backup.path, action: "create",
        summary: `Backed up to ${backup.path}`,
      });
      return { redirect: "/health", message: `Backed up ${backup.bytes} bytes.` };
    }, { atomic: false }),
  );

  router.post("/health/verify", (ctx) =>
    mutate(ctx, () => {
      refuseInDemo(config, "Verifying a restore");
      const result = verifyRestore(db, config.backupDir);
      recordJobRun(db, "restore-verification", result.ok ? "ok" : "failed", result.summary);

      // Fired without awaiting: a slow monitor must not hold up the page, and
      // a ping that never arrives is itself the alert (R40.8.2).
      if (result.ok && config.heartbeatUrl) {
        // DEBUG-WEB-8 · Through the app's fetch, and the record is best-effort:
        // a write that fails after the response (database closed at shutdown)
        // was an unhandled rejection, which ends the process.
        void pingHeartbeat(config.heartbeatUrl, deps.fetchImpl).then((beat) =>
          recordJobRun(
            db, "heartbeat", beat.ok ? "ok" : "failed",
            beat.ok
              ? "Acknowledged by the external monitor."
              : "The monitor could not be reached. It will alert on the missing ping.",
          ),
        ).catch(() => {
          // The ping itself went out or did not; the monitor judges that.
        });
      }

      return { redirect: "/health", message: result.summary };
    }),
  );

  /**
   * F15.1: the member's budget, in one action, in an open documented format.
   *
   * The member's, not the household's: this was `exportEverything(db)` — the
   * operator's complete backup — so any signed-in member downloaded every other
   * member's private accounts, envelopes and transactions. The complete copy is
   * the backup job's, on the server; see member-export.ts for which is which.
   */
  router.get("/export.json", (ctx) => {
    const a = auth(ctx);
    return {
      body: JSON.stringify(exportForMember(db, a.member.id), null, 2),
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename="pathayam-${todayIST()}.json"`,
      },
    };
  });

  /*
   * AI-4 · A summary of the member's figures for an AI tool or a spreadsheet:
   * overview, budgets, spending by month, loans, portfolio, net worth, cashflow
   * and the tax estimate, as the member sees them on screen. Not a backup and
   * not the register — /export.json is both. A GET that changes nothing, so a
   * read-only token reaches it the way it reaches /export.json.
   */
  router.get("/export/analysis.json", (ctx) => {
    // AI-7 · Part of the AI feature set: off with FEATURE_AI, like /mcp.
    if (!aiEnabled) throw new NotFound();
    const a = auth(ctx);
    const raw = ctx.query.get("months")?.trim();
    let months: number | undefined;
    if (raw) {
      months = /^[0-9]+$/.test(raw) ? Number(raw) : NaN;
      if (!Number.isInteger(months) || months < 1 || months > SNAPSHOT_MAX_MONTHS) {
        throw new Refusal(`months is a whole number from 1 to ${SNAPSHOT_MAX_MONTHS}.`);
      }
    }
    const snapshot = aiSnapshot(db, a.member.id, { months }, { features: config.features });
    // AI-3 · The snapshot tool's answer, downloaded: a connection that asked
    // for masking gets it masked here as over /mcp, or the same token handed
    // the account numbers whole to whoever fetched this instead.
    const token = ctx.locals.token as ApiToken | undefined;
    const masked = token && isAiToken(token) && tokenRedacts(token);
    return {
      body: JSON.stringify(masked ? redactValue(snapshot) : snapshot, null, 2),
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename="pathayam-analysis-${todayIST()}.json"`,
      },
    };
  });

  router.get("/export.csv", (ctx) => {
    const a = auth(ctx);
    return {
      body: exportTransactionsCsvForMember(db, a.member.id),
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="transactions-${todayIST()}.csv"`,
      },
    };
  });

  // -------------------------------------------------------------------------
  // AI-2 · The MCP endpoint: Claude, ChatGPT, Gemini and the rest, read-only.
  //
  // The middleware has already made sure this is a bearer token (a cookie is
  // not looked at here) and has answered a missing one with the 401 that
  // starts an AI app's sign-in. The tools are built per request for the
  // token's member, so there is no state between calls to leak across them.
  // -------------------------------------------------------------------------
  const mcpOrigins = new Set([
    new URL(config.baseUrl).origin,
    ...String(process.env.MCP_ALLOWED_ORIGINS ?? "").split(",").map((o) => o.trim()).filter(Boolean),
  ]);
  router.post("/mcp", (ctx) => {
    const a = auth(ctx);
    const token = ctx.locals.token as ApiToken | undefined;
    if (!token) return oauth.mcpUnauthorized(config.baseUrl);
    /*
     * The spec's DNS-rebinding rule: an Origin, when there is one, must be
     * ours. A connector calls from its own servers and sends none; a browser
     * page that names another origin is refused unless the operator listed it
     * in MCP_ALLOWED_ORIGINS. A token is still required either way.
     */
    const origin = ctx.req.headers.origin;
    if (origin && !mcpOrigins.has(origin)) {
      return { status: 403, json: { jsonrpc: "2.0", id: null, error: { code: -32600, message: "That Origin may not call this server." } } };
    }
    /*
     * AIW · The change tools exist for this call only when all three locks are
     * open: the deployment allows changes, this is an AI's token, and the
     * member ticked "allow changes" for it (read-write). Otherwise they are not
     * listed at all, and a call to one by name is an unknown tool.
     */
    const connectionId = aiConnectionId(token);
    const write: AiWriteContext | undefined =
      aiWriteOn && config.aiWrite !== "off" && isAiToken(token) && token.scope === "read-write"
        ? {
          db, memberId: a.member.id, mode: config.aiWrite, features: config.features,
          connection: { id: connectionId, name: token.name, tokenId: token.id },
        }
        : undefined;
    const reply = handleMcp(
      { headers: ctx.req.headers, rawBody: rawBodies.get(ctx.req) ?? "" },
      {
        server: {
          name: "pathayam", title: "Pathayam", version: VERSION,
          instructions: write ? writeInstructions(write.mode) : MCP_INSTRUCTIONS,
        },
        tools: buildTools(db, a.member.id, { features: config.features }, write),
        transformResult: tokenRedacts(token) ? redactValue : undefined,
        onToolCall: (c) => recordAiAccess(db, {
          tokenId: token.id, tokenName: token.name, memberId: a.member.id, tool: c.tool, args: c.args, ok: c.ok, bytes: c.bytes,
          connectionId, wrote: c.ok && isWriteTool(c.tool),
        }),
      },
    );
    if (reply.json === undefined) return { status: reply.status, body: "" };
    return { status: reply.status, json: reply.json, headers: reply.headers };
  });
  // The 2025 revisions opened a GET stream and ended sessions with DELETE;
  // with no sessions and no server-sent requests, both are 405 (the spec's
  // own answer for a server that offers neither).
  router.get("/mcp", () => ({ status: 405, headers: { Allow: "POST" }, body: "" }));
  router.add("DELETE", "/mcp", () => ({ status: 405, headers: { Allow: "POST" }, body: "" }));

  // -------------------------------------------------------------------------
  // AI-5 · Connect an AI. Under /tokens, so no bearer token can reach it.
  // -------------------------------------------------------------------------
  function connectAiProps(memberId: string) {
    // AIW · An AI app's access tokens are for_ai too; they are listed by their connection.
    const handMinted = queryAll<{ id: string; name: string; redact: number; scope: string; created_at: string; last_used_at: string | null }>(
      db,
      `SELECT id, name, redact, scope, created_at, last_used_at FROM api_tokens
        WHERE member_id = ? AND for_ai = 1 AND oauth_grant_id IS NULL AND revoked_at IS NULL ORDER BY created_at DESC`,
      memberId,
    );
    // AIW · What each connection changed today, so its undo says how much it undoes.
    const changedToday = (connectionId: string): number => queryOne<{ n: number }>(
      db,
      `SELECT COUNT(*) AS n FROM events WHERE idempotency_key = ? AND undo_of_event_id IS NULL AND undone_by_event_id IS NULL`,
      aiIdempotencyKey(connectionId),
    )!.n;
    return {
      mcpUrl: `${config.baseUrl}/mcp`,
      snapshotUrl: "/export/analysis.json",
      writes: aiWriteOn ? config.aiWrite as "standard" | "full" : null,
      connections: [
        ...oauth.listConnections(db, memberId).map((c) => ({
          id: c.id, name: c.clientName, how: `Signed in from ${c.redirectHost}`, redact: c.redact,
          canWrite: aiWriteOn && c.canWrite, changedToday: changedToday(c.id),
          created_at: c.createdAt, last_used_at: c.lastUsedAt, revoke_url: `/tokens/connections/${c.id}/revoke`,
        })),
        ...handMinted.map((t) => ({
          id: t.id, name: t.name, how: "Token", redact: t.redact === 1,
          canWrite: aiWriteOn && t.scope === "read-write", changedToday: changedToday(t.id),
          created_at: t.created_at, last_used_at: t.last_used_at, revoke_url: `/tokens/${t.id}/revoke`,
        })),
      ],
      log: listAiAccess(db, memberId),
    };
  }
  router.get("/tokens/ai", (ctx) => {
    const a = auth(ctx);
    return render(ctx, "Connect an AI", renderConnectAi({ ...connectAiProps(a.member.id), minted: null }));
  });
  router.post("/tokens/ai", (ctx) => {
    refuseInDemo(config, "Connecting an AI");
    const a = auth(ctx);
    // As for /tokens: a token minted while viewing as somebody would be theirs.
    if (a.impersonating) {
      throw new HttpError(403, "An AI cannot be connected while viewing as another member.");
    }
    const days = Number(field(ctx.body, "expires_in_days"));
    const redact = field(ctx.body, "redact") === "1";
    // AIW · Read-only unless the deployment allows changes and the member
    // ticked the box; always expiring, because one forgotten in a config file
    // should stop on its own. Either way it is an AI token, confined to /mcp.
    const writes = aiWriteOn && field(ctx.body, "allow_changes") === "1";
    const minted = mintToken(db, actorFor(a), {
      name: requiredField(ctx.body, "name").slice(0, 80),
      scope: writes ? "read-write" : "read",
      expiresInDays: [30, 90, 365].includes(days) ? days : 90,
    });
    execute(db, `UPDATE api_tokens SET for_ai = 1, redact = ? WHERE id = ?`, redact ? 1 : 0, minted.token.id);
    // F30.4 · Rendered, not redirected: a redirect would carry the secret in a URL.
    return render(ctx, "Connect an AI", renderConnectAi({
      ...connectAiProps(a.member.id),
      minted: { name: minted.token.name, secret: minted.secret, redact, canWrite: writes },
    }));
  });

  /*
   * AIW · "Undo this AI's changes today": every change one connection made
   * today shares one idempotency key, and undoByIdempotencyKey reverses them
   * newest first. R37.9 holds for the group as for one change: when somebody
   * has changed one of those records since, the page lists what undoing would
   * discard and asks again, and only "Undo anyway" discards it. Approved
   * suggestions are not in the group — a member looked at those — and undo
   * one by one in Activity. Under /tokens, so no token can press it.
   */
  router.post("/tokens/ai/undo-today", (ctx) => {
    const a = auth(ctx);
    if (a.impersonating) throw new HttpError(403, "Not while viewing as another member.");
    const connectionId = requiredField(ctx.body, "connection_id");
    const props = connectAiProps(a.member.id);
    const connection = props.connections.find((c) => c.id === connectionId);
    // Only one's own connections, and not saying whether the id exists.
    if (!connection) throw new NotFound("That connection does not exist.");
    const key = aiIdempotencyKey(connectionId);
    const force = field(ctx.body, "force") === "1";
    const check = checkUndoByIdempotencyKey(db, key);
    if (check.events.length === 0) {
      return { redirect: withNotice("/tokens/ai", `${connection.name} has changed nothing today that is still in place.`) };
    }
    if (check.supersededBy.length > 0 && !force) {
      return render(ctx, "Connect an AI", renderAiUndoConfirm({
        connectionId, name: connection.name, count: check.events.length,
        supersededBy: check.supersededBy.map((e) => ({ at: e.at, summary: e.summary ?? `${e.action} ${e.entity}` })),
      }));
    }
    return mutate(ctx, (auth) => {
      const actor = actorFor(auth, "ui");
      const intact = intactCheckpointBalances(db);
      let results;
      try {
        results = undoByIdempotencyKey(db, key, actor, { force });
      } catch (err) {
        if (err instanceof UndoRefused) throw new HttpError(422, err.message);
        throw err;
      }
      breakCheckpoints(db, actor, checkpointsMovedSince(db, intact), "an undo changed a transaction dated on or before it");
      const undone = results.filter((r) => r.ok).length;
      const left = results.length - undone;
      return {
        redirect: "/tokens/ai",
        message: `Undid ${undone} ${undone === 1 ? "change" : "changes"} ${connection.name} made today.` +
          (left > 0 ? ` ${left} could not be undone; Activity says why.` : ""),
      };
    });
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
  // 15 · Each of these is the reader's, like the page it downloads.
  router.get("/portfolio/holdings.csv", (ctx) => {
    requireAssets(); auth(ctx);
    return csvDownload("holdings", exportHoldingsCsv(db, { viewerMemberId: viewer(ctx) }));
  });
  router.get("/portfolio/lots.csv", (ctx) => {
    requireAssets(); auth(ctx);
    return csvDownload("lots", exportLotsCsv(db, { viewerMemberId: viewer(ctx) }));
  });
  router.get("/portfolio/prices.csv", (ctx) => {
    requireAssets(); auth(ctx);
    const hideInstruments = memberScope(db, viewer(ctx)).instruments;
    return csvDownload("prices", exportPriceHistoryCsv(db, { hideInstruments }));
  });
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
    // FRESH-WEB-3 · 1e308 is an integer too; past year 9998 a date stops being one.
    const fy = Number.isInteger(fyParam) && fyParam > 2000 && fyParam < 9999
      ? fyParam : fiscalYearOf(todayIST());

    const insurance = config.features.insurance;
    const model = taxPageModel(db, a.member.id, fy, insurance && ctx.query.get("from") === "policies");
    // PLAN-1 · Without the insurance module there are no policies to suggest from.
    return { ...model, fromPolicies: insurance ? model.fromPolicies : undefined, features: config.features };
  }

  router.get("/tax", (ctx) => {
    const a = auth(ctx);
    // PRINT-1 · On paper the caveat travels with every sheet, not only the
    // first: the page's own notice is at the top, and a second page has none.
    return render(ctx, "Tax estimate", renderTax(taxPageProps(ctx, a)), {
      print: { caveat: TAX_PRINT_CAVEAT },
    });
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
        // EXTRA-6 · Parents are a second 80D deduction, with a ceiling of their own.
        s80dParents: money("s80d_parents"),
        s80dParentsSenior: field(ctx.body, "s80d_parents_senior") === "1",
        s80dCheckup: money("s80d_checkup"),
        s80dParentsCheckup: money("s80d_parents_checkup"),
        other: money("other"),
        // ENG-7 · Employer NPS, allowed under both regimes.
        s80ccd2: money("s80ccd2"),
        s80ccd2Government: field(ctx.body, "s80ccd2_government") === "1",
        hra: (received || rentPaid || basic)
          ? { received, rentPaid, basic, metro: field(ctx.body, "hra_metro") === "1" }
          : null,
        // TAX-1 · Blank uses what the ledger accrued; a figure, even 0, is theirs.
        s24bOverride: String(field(ctx.body, "s24b") ?? "").trim() ? money("s24b") : null,
        tds: money("tds"),
      });

      return { redirect: `/tax?fy=${fy}`, message: "Saved. The estimate is recalculated." };
    }),
  );

  /*
   * TAX-2 · Advance and self-assessment tax paid, a challan at a time. The
   * member's own: written against the viewer, and a delete names one of the
   * viewer's rows or finds nothing.
   */
  router.post("/tax/payments", (ctx) =>
    mutate(ctx, (a) => {
      const fy = Number(field(ctx.body, "fy"));
      if (!Number.isInteger(fy)) throw new Refusal("Pick a financial year.");
      const kind = field(ctx.body, "kind") as TaxPaymentKind;
      addTaxPayment(db, a.member.id, {
        fy, kind,
        date: dateField(field(ctx.body, "date")),
        amount: amountField(String(field(ctx.body, "amount") ?? ""), "Amount"),
        note: field(ctx.body, "note") ?? null,
      });
      return { redirect: `/tax?fy=${fy}`, message: "Recorded. The balance is recalculated." };
    }),
  );

  router.post("/tax/payments/:id/delete", (ctx) =>
    mutate(ctx, (a) => {
      const removed = deleteTaxPayment(db, a.member.id, ctx.params.id!);
      return { redirect: `/tax?fy=${removed.fy}`, message: "Removed." };
    }),
  );

  /*
   * Liveness, not perfection.
   *
   * This is what the platform polls to decide whether to send traffic here, and
   * it used to return 503 whenever *any* check read "failed" — including
   * "a request failed in the last 24 hours". So one bad request took the whole
   * app out of rotation for a day: the proxy stopped routing, every visitor got
   * 503, and the recorded failure that caused it could not be cleared because
   * nobody could reach the app to clear it. A diagnostic observation was wired
   * to an outage switch.
   *
   * The body still reports everything, and /health still shows it to an
   * operator. What decides the status code is only whether this instance can
   * serve a request at all — which is answered by the database opening, since
   * nothing works without it.
   */
  router.get("/healthz", (ctx) => {
    /*
     * 15 · Public, so it says only whether this instance is alive. It used to
     * hand every passer-by the whole diagnosis: how many transactions and
     * events the household has, how many items wait in review, which backups
     * are missing and whether a development-login bypass is in the build — a
     * map of the instance for anyone who asked. A monitor (and the Fly and
     * Docker checks) needs one bit; the operator reads the rest on /health, or
     * here with a session or an API token.
     *
     * The bit is whether the database answers, read directly rather than from
     * the checks, so nothing recorded in the past can fail it.
     */
    let canServe = true;
    try {
      queryOne(db, `SELECT 1 FROM members LIMIT 1`);
    } catch {
      canServe = false;
    }
    if (!ctx.locals.auth) {
      return {
        status: canServe ? 200 : 503,
        json: { status: canServe ? "ok" : "unavailable", serving: canServe, version: VERSION },
      };
    }

    const groups = healthGroups(viewer(ctx));
    const overall = overallState(groups);

    return {
      status: canServe ? 200 : 503,
      json: {
        status: overall,
        serving: canServe,
        version: VERSION,
        checks: groups.flatMap((g) =>
          g.checks.map((c) => ({ group: g.name, name: c.name, state: c.state, reason: c.reason })),
        ),
      },
    };
  });

  return { router, middleware };

  function asset(body: string, type: string, versioned = false): Response {
    return {
      body,
      headers: {
        "Content-Type": `${type}; charset=utf-8`,
        // Static assets are code, not data — ordinary HTTP caching is
        // explicitly permitted by R35.
        "Cache-Control": versioned ? "public, max-age=31536000, immutable" : "public, max-age=3600",
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