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
import { queryAll, queryOne } from "./db/db.ts";
import type { Config } from "./config.ts";
import {
  Router, field, fieldList, requiredField, HttpError, NotFound,
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
import { parseDate, todayIST, monthOf, isMonthKey, formatMonth, type MonthKey } from "./core/dates.ts";
import { buildBudgetView, reviewCount } from "./web/viewmodel.ts";
import { renderBudget } from "./web/pages/budget.ts";
import {
  renderAccountList, renderAccountDetail, renderNewAccountForm, type AccountRow, type RegisterRow,
} from "./web/pages/accounts.ts";
import {
  renderAddTransaction, renderMoveMoney, renderAutoAssignPreview, renderHold,
  renderExplain, explainLineFor, renderNotFound,
} from "./web/pages/actions.ts";
import { renderReview, renderImport } from "./web/pages/review.ts";
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
import { accountBalances, creditOutstanding, loadAutoAssignRules, loadEngineInput } from "./engine/repository.ts";
import { computeBudget, planAutoAssign, suggestCoverSources, cardFunding } from "./engine/engine.ts";
import { historyFor, queryEvents } from "./core/events.ts";

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
    const month = monthParam(ctx);
    const view = buildBudgetView(db, month);
    return render(ctx, formatMonth(month), renderBudget(view));
  });

  router.post("/assign", (ctx) =>
    mutate(ctx, (a) => {
      const month = monthParam(ctx);
      const categoryId = requiredField(ctx.body, "category_id");
      const rawAmount = field(ctx.body, "amount") ?? "";
      const amount = rawAmount.trim() === "" ? 0 : amountField(rawAmount);

      setAssigned(db, actorFor(a, "ui", ctx.req.headers["idempotency-key"] as string), month, categoryId, amount);
      const category = getCategory(db, categoryId);
      return {
        redirect: `/?month=${month}`,
        message: `Assigned ${formatPaise(amount)} to ${category?.name ?? "that category"}.`,
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
      moveMoney(db, actorFor(a, "ui", ctx.req.headers["idempotency-key"] as string), {
        month,
        fromCategoryId: requiredField(ctx.body, "from_category_id"),
        toCategoryId: requiredField(ctx.body, "to_category_id"),
        amount: amountField(field(ctx.body, "amount")),
      });
      return { redirect: `/?month=${month}`, message: "Money moved." };
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
    updateTransaction(db, actorFor(a, "ui", ctx.req.headers["idempotency-key"] as string), id, {
      amount: field(ctx.body, "direction") === "in" ? magnitude : -magnitude,
      date: newDate,
      categoryId: field(ctx.body, "category_id") || null,
      memo: field(ctx.body, "memo") || null,
      cleared: field(ctx.body, "cleared") === "1",
    });

    return { redirect: withNotice(`/accounts/${transaction.account_id}`, "Saved.") };
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

    deleteTransaction(db, actorFor(a, "ui", ctx.req.headers["idempotency-key"] as string), id);
    return {
      redirect: withNotice(
        `/accounts/${transaction.account_id}`,
        "Deleted. You can restore it for the next 30 days.",
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
        proposedRules: queryAll<{ id: string; name: string }>(
          db, `SELECT id, name FROM rules WHERE proposed = 1 AND dismissed_at IS NULL`,
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
      return { redirect: "/review", message: "Added to your ledger." };
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
    })),
  );

  router.post("/import", (ctx) =>
    mutate(ctx, (a) => {
      const text = requiredField(ctx.body, "csv");
      const accountId = requiredField(ctx.body, "account_id");
      const fileName = field(ctx.body, "file_name") || "pasted.csv";

      const { result, mapping } = parseStatement(text);
      if (!mapping) {
        // 03 §5: a file with no recognisable columns is a mapping task, not an
        // error — but the mapping UI is not built yet, so say so plainly
        // rather than failing with something opaque.
        throw new HttpError(
          400,
          "I couldn't find a header row with a date, a description and an amount. " +
            "Check that the header line is included in what you pasted.",
        );
      }

      const outcome = ingest(db, actorFor(a, "import", ctx.req.headers["idempotency-key"] as string), {
        accountId, source: "csv", adapter: "csv", fileName,
        records: result.records, errors: result.errors, rowsRead: result.rowsRead,
      });

      const parts = [`${outcome.staged} to review`];
      if (outcome.autoApproved) parts.push(`${outcome.autoApproved} auto-approved`);
      if (outcome.duplicates) parts.push(`${outcome.duplicates} possible duplicates`);
      if (outcome.skipped) parts.push(`${outcome.skipped} already present`);
      if (outcome.errors) parts.push(`${outcome.errors} rows I couldn't read`);

      return {
        redirect: outcome.staged > 0 ? "/review" : "/import",
        message: `Read ${outcome.batch.rows_read} rows — ${parts.join(", ")}.`,
      };
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
  // Placeholders for screens still to come, so navigation never dead-ends
  // -------------------------------------------------------------------------
  for (const [path, title] of [
    ["/more", "More"],
    ["/reports", "Reports"],
    ["/query", "Query"],
    ["/schedules", "Schedules"],
    ["/goals", "Goals"],
    ["/payees", "Payees"],
    ["/rules", "Rules"],
    ["/search", "Search"],
    ["/categories", "Categories"],
  ] as const) {
    router.get(path, (ctx) =>
      render(
        ctx,
        title,
        html`
          <div class="card empty-state">
            <h2>${title}</h2>
            <p>This screen isn't built yet.</p>
            <p><a class="button" href="/">Back to the budget</a></p>
          </div>
        `,
      ),
    );
  }

  /** F27.3: a machine-readable endpoint for external monitoring. */
  router.get("/healthz", () => ({
    json: {
      status: "ok",
      version: "0.1.0",
      database: queryOne<{ n: number }>(db, `SELECT COUNT(*) AS n FROM members`) ? "connected" : "unknown",
    },
  }));

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
