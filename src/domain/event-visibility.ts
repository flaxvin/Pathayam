/**
 * 15 / H2.2 · Which events a member may read.
 *
 * The activity log narrates everything the household does, in words: *"Added the
 * account Zzyzx Private Account"*, *"Paid ₹4,321 to Vantablack Merchant"*, *"Set
 * a monthly target of ₹9,000 on Qwertyuiop Envelope"*. Every other surface had
 * been taught whose money it was showing and this one had not, so the screen
 * whose whole purpose is to say what happened said what happened in somebody
 * else's private budget — account names, payees, envelopes, amounts, dates, and
 * an undo button beside each one.
 *
 * An event is readable when the thing it is about is. Where an event is about
 * nothing in particular — a household setting, a member, a session — it is the
 * household's business and everybody sees it.
 */

import type { DB } from "../db/db.ts";
import { queryOne } from "../db/db.ts";
import type { LoggedEvent } from "../core/events.ts";
import { visiblePayeeIds } from "./transactions.ts";
import { memberScope } from "./member-scope.ts";

/** Cached per call site: the sweep asks about a hundred events at a time. */
export interface EventVisibility {
  (event: LoggedEvent): boolean;
}

/*
 * The household's own business whatever else they say: a setting, a member, a
 * session, a backup, the price feed, a snapshot of the shared net worth.
 *
 * This used to be the other way round — a switch over the kinds somebody had
 * remembered, ending in `default: return true`. Goals were looked up in the
 * categories table, found nothing there, and were shown; schedules, demat
 * accounts and instruments had no case at all and fell through to the default.
 * So Priya's log read "Added the goal Jabberwock Private Goal", "Added the
 * schedule Snorlax Secret Subscription" and "Added Quokka Private Demat", each
 * with an undo button beside it. A kind added tomorrow is now hidden until
 * somebody says here that it is the household's — the safer of the two ways to
 * be wrong.
 */
const HOUSEHOLD_ENTITIES = new Set([
  "household", "member", "settings", "session", "impersonation", "api-token",
  "gmail", "statement-identity", "digest", "backup", "recompute", "prices",
  "category-order", "group-order", "held", "net-worth", "cas-import", "month-close",
]);

/** Kinds whose id is not a row but names what they are about, and is judged alone. */
const JUDGED_BY_ID = new Set(["assignment", "target", "transfer"]);

/** The table behind each kind of event that is about one row. */
const TABLES: Record<string, string> = {
  account: "accounts", "asset-account": "accounts", category: "categories",
  "category-group": "category_groups", transaction: "transactions", schedule: "schedules",
  goal: "goals", holding: "holdings", asset: "holdings", instrument: "instruments",
  card: "cards", "card-statement": "card_statements", reconciliation: "reconciliations",
  loan: "loans", "family-loan": "family_loans", attachment: "attachments",
  "import-batch": "import_batches", "import-profile": "import_profiles",
  "staged-transaction": "staged_transactions", "even-call": "even_calls",
};

export function eventVisibility(db: DB, viewerMemberId: string | null): EventVisibility {
  const scope = memberScope(db, viewerMemberId);
  let payeeIds: Set<string> | null = null;
  const payeesVisible = (): Set<string> => (payeeIds ??= visiblePayeeIds(db, viewerMemberId));

  return (event: LoggedEvent): boolean => {
    /*
     * What the event itself names: its id — or each part of one, since an
     * assignment is `month:categoryId` — and every id in what it recorded
     * before and after. The second is what keeps a deletion private: a
     * schedule that is gone has no row left to ask about, but its delete event
     * still carries the account it posted into, and an undone transaction's
     * create event still carries the account it was on.
     */
    if ((event.entityId ?? "").split(":").some((part) => scope.hides(part))) return false;
    if (scope.mentionsHidden(event.before) || scope.mentionsHidden(event.after)) return false;

    const id = event.entityId;
    if (!id || HOUSEHOLD_ENTITIES.has(event.entity) || JUDGED_BY_ID.has(event.entity)) return true;

    if (event.entity === "payee") {
      // A payee only ever seen on a private account is not a household fact:
      // "Added the payee Vantablack Merchant" says where somebody spent.
      return payeesVisible().has(id);
    }
    if (event.entity === "rule") {
      // A rule about an envelope you cannot see names it — "Vantablack →
      // Qwertyuiop Envelope" — the same test the Rules screen applies.
      const rule = queryOne<{ actions_json: string }>(
        db, `SELECT actions_json FROM rules WHERE id = ?`, id,
      );
      return !rule || !scope.mentionsHidden(JSON.parse(rule.actions_json));
    }

    const table = TABLES[event.entity];
    if (!table) return false;
    // The row, and everything it hangs off: a reconciliation's account, a
    // staged row's account and envelope, an import profile's account.
    const columns = table === "attachments" ? "id, transaction_id" : "*";
    const row = queryOne<Record<string, unknown>>(db, `SELECT ${columns} FROM ${table} WHERE id = ?`, id);
    if (row) return !scope.mentionsHidden(row);
    // Gone, and the event recorded nothing to judge it by: somebody who could
    // not have seen the thing does not get to read that it went.
    return event.before !== undefined || event.after !== undefined;
  };
}
