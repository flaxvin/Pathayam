/**
 * PLAN-1 · One of every page a module draws, for the crawl to visit by name.
 * Not a `.test.ts` file: the plan tests import it.
 */

import { queryAll, type DB } from "../db/db.ts";

export function detailPages(db: DB): string[] {
  const ids = (sql: string) => queryAll<{ id: string }>(db, sql).map((r) => r.id);
  return [
    ...ids(`SELECT id FROM accounts`).map((id) => `/accounts/${id}`),
    ...ids(`SELECT id FROM loans`).map((id) => `/loans/${id}`),
    ...ids(`SELECT id FROM family_loans`).map((id) => `/family/${id}`),
    ...ids(`SELECT id FROM insurance_policies`).map((id) => `/insurance/${id}`),
    ...ids(`SELECT id FROM holdings LIMIT 3`).map((id) => `/portfolio/${id}`),
    ...ids(`SELECT DISTINCT transaction_id AS id FROM attachments LIMIT 2`).map((id) => `/transaction/${id}`),
    // A card purchase converted to EMI, and one that could be.
    ...ids(`SELECT t.id FROM transactions t JOIN accounts a ON a.id = t.account_id
             WHERE a.kind = 'credit' AND t.amount < 0 AND t.deleted_at IS NULL LIMIT 2`).map((id) => `/transaction/${id}`),
    ...ids(`SELECT converted_from_transaction_id AS id FROM loans WHERE converted_from_transaction_id IS NOT NULL LIMIT 2`)
      .map((id) => `/transaction/${id}`),
  ];
}
