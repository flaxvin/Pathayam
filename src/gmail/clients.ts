/**
 * GMAIL-BYO · Which Google OAuth client a Gmail connection runs under.
 *
 * There are three places a client can come from, tried in this order:
 *
 *   1. the member's own — a Google Cloud project they made, for their mailbox;
 *   2. the household's — one project any member without their own may use;
 *   3. the deployment's — GOOGLE_CLIENT_ID, only when FEATURE_GMAIL is on.
 *
 * (1) and (2) are what let every plan connect Gmail (FEATURE_GMAIL_BYO): the
 * person consents to an application they own, and this server only runs it.
 *
 * A refresh token renews only under the client that issued it, so the
 * connection records the client id it was made with, and a fetch uses that
 * client again — not whichever one would be picked for a new connection. If
 * those keys have since been removed or replaced, the fetch says to reconnect
 * rather than failing at Google with a message nobody can act on.
 *
 * The secret is sealed with SECRETS_KEY and never leaves this module except to
 * be sent to Google. A screen sees the client id (it is public: it is in every
 * consent URL) and whether a secret is on file — never the secret.
 */

import type { DB } from "../db/db.ts";
import { transact, queryOne, execute } from "../db/db.ts";
import { appendEvent, type Actor } from "../core/events.ts";
import { nowIST } from "../core/dates.ts";
import { Refusal } from "../core/refusal.ts";
import type { Config } from "../config.ts";
import { seal, open, SecretUnreadable } from "./secrets.ts";

export const HOUSEHOLD = "household";

export type ClientSource = "member" | "household" | "deployment";

export interface GoogleClient {
  source: ClientSource;
  clientId: string;
  clientSecret: string;
}

/** What Settings may show about a saved client. */
export interface GoogleClientView {
  clientId: string;
  setAt: string;
  /** A member's name for the household's keys; null for your own. */
  setBy: string | null;
}

interface Row {
  owner: string;
  client_id: string;
  client_secret: string;
  set_by: string;
  set_at: string;
}

/*
 * A Google OAuth web client id is `<digits>-<hash>.apps.googleusercontent.com`.
 * Checked loosely — Google has changed the hash part before — but enough to
 * catch the secret pasted into the id box, or a project number on its own.
 */
const CLIENT_ID = /^[0-9]+-[a-z0-9_-]+\.apps\.googleusercontent\.com$/i;

function aad(owner: string): string {
  return `gmail-client:${owner}`;
}

function ownerFor(actor: Actor, scope: "member" | "household"): string {
  if (scope === HOUSEHOLD) return HOUSEHOLD;
  if (!actor.memberId) throw new Error("A member's keys belong to a member.");
  return actor.memberId;
}

/** Can keys be saved here at all? Only with a key to seal them. */
export function canSaveClients(config: Config): boolean {
  return config.features.gmailByo && config.secretsKey !== null;
}

export function saveClient(
  db: DB, config: Config, actor: Actor,
  input: { scope: "member" | "household"; clientId: string; clientSecret: string },
): void {
  if (!config.features.gmailByo) throw new Refusal("Bringing your own Google keys is turned off on this server.");
  if (!config.secretsKey) {
    throw new Refusal(
      "This server has no SECRETS_KEY set, so it cannot store a Google client secret safely. " +
      "Ask whoever runs it to set one.",
    );
  }
  const clientId = input.clientId.trim();
  const clientSecret = input.clientSecret.trim();
  if (!CLIENT_ID.test(clientId)) {
    throw new Refusal("That is not a Google OAuth client ID. It ends in .apps.googleusercontent.com.");
  }
  if (clientSecret.length < 10 || clientSecret.length > 200 || /\s/.test(clientSecret)) {
    throw new Refusal("That does not look like a Google client secret. Copy it again from the Google Cloud console.");
  }
  if (clientSecret === clientId) throw new Refusal("The secret and the client ID are the same. Paste the secret.");

  const owner = ownerFor(actor, input.scope);
  const sealed = seal(config.secretsKey, clientSecret, aad(owner));
  transact(db, () => {
    execute(
      db,
      `INSERT INTO gmail_clients (owner, client_id, client_secret, set_by, set_at) VALUES (?,?,?,?,?)
       ON CONFLICT(owner) DO UPDATE SET client_id = excluded.client_id,
         client_secret = excluded.client_secret, set_by = excluded.set_by, set_at = excluded.set_at`,
      owner, clientId, sealed, actor.memberId ?? "system", nowIST(),
    );
    // The client id is public; the secret is never logged.
    appendEvent(db, actor, {
      entity: "gmail", entityId: owner, action: "set-client",
      after: { scope: input.scope, client_id: clientId },
      summary: input.scope === HOUSEHOLD
        ? "Saved the household's own Google keys for Gmail"
        : "Saved your own Google keys for Gmail",
    });
  });
}

export function clearClient(db: DB, actor: Actor, scope: "member" | "household"): void {
  const owner = ownerFor(actor, scope);
  transact(db, () => {
    execute(db, `DELETE FROM gmail_clients WHERE owner = ?`, owner);
    appendEvent(db, actor, {
      entity: "gmail", entityId: owner, action: "clear-client",
      after: { scope },
      summary: scope === HOUSEHOLD
        ? "Removed the household's own Google keys for Gmail"
        : "Removed your own Google keys for Gmail",
    });
  });
}

export function clientView(db: DB, owner: string): GoogleClientView | null {
  const row = queryOne<Row & { name: string | null }>(
    db,
    `SELECT c.*, m.name AS name FROM gmail_clients c LEFT JOIN members m ON m.id = c.set_by WHERE c.owner = ?`,
    owner,
  );
  return row
    ? { clientId: row.client_id, setAt: row.set_at, setBy: owner === HOUSEHOLD ? (row.name ?? "a former member") : null }
    : null;
}

/** A saved client, opened; null when none is saved or it cannot be opened here. */
function savedClient(db: DB, config: Config, owner: string, source: ClientSource): GoogleClient | null {
  if (!config.features.gmailByo || !config.secretsKey) return null;
  const row = queryOne<Row>(db, `SELECT * FROM gmail_clients WHERE owner = ?`, owner);
  if (!row) return null;
  try {
    return { source, clientId: row.client_id, clientSecret: open(config.secretsKey, row.client_secret, aad(owner)) };
  } catch (error) {
    if (error instanceof SecretUnreadable) return null;
    throw error;
  }
}

function deploymentClient(config: Config): GoogleClient | null {
  return config.features.gmail && config.google.clientId && config.google.clientSecret
    ? { source: "deployment", clientId: config.google.clientId, clientSecret: config.google.clientSecret }
    : null;
}

/** The client a new connection for this member would use, by the order above. */
export function clientForConnect(db: DB, config: Config, memberId: string): GoogleClient | null {
  return savedClient(db, config, memberId, "member")
    ?? savedClient(db, config, HOUSEHOLD, "household")
    ?? deploymentClient(config);
}

/**
 * The client an existing connection was made with. `connectionClientId` null
 * is the deployment's own, as every connection before GMAIL-BYO was.
 */
export function clientForConnection(
  db: DB, config: Config, memberId: string, connectionClientId: string | null,
): GoogleClient {
  const candidates = [
    savedClient(db, config, memberId, "member"),
    savedClient(db, config, HOUSEHOLD, "household"),
    deploymentClient(config),
  ];
  const match = candidates.find((c) => c !== null && (
    connectionClientId === null ? c.source === "deployment" : c.clientId === connectionClientId
  ));
  if (match) return match;
  throw new Refusal(
    "The Google keys this mailbox was connected with are no longer available here. " +
    "Disconnect and connect Gmail again.",
  );
}

/** Which way, if any, this member could connect a mailbox right now — for Settings. */
export function connectRoute(db: DB, config: Config, memberId: string): ClientSource | null {
  return clientForConnect(db, config, memberId)?.source ?? null;
}
