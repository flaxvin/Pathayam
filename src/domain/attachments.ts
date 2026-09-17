/**
 * Q10 / F4.5 · Receipt attachments on a transaction.
 *
 * Bytes are stored in the database as a BLOB — see migration 0014 for why that
 * is the right call on a one-box deployment. Nothing here touches the disk.
 *
 * R35: a receipt is never cached on the device. The route that serves one sets
 * no-store, and there is no client copy — every view is a fresh fetch. This
 * module just holds and returns the bytes; the caching discipline is the
 * route's (see `app.ts`).
 */

import { createHash } from "node:crypto";
import type { DB } from "../db/db.ts";
import { newId, transact, queryAll, queryOne, execute } from "../db/db.ts";
import { appendEvent, registerUndoHandler, type Actor } from "../core/events.ts";
import { nowIST } from "../core/dates.ts";
import { Refusal } from "../core/refusal.ts";

/** What a listing shows: metadata only, never the bytes. */
export interface AttachmentMeta {
  id: string;
  transaction_id: string;
  filename: string;
  mime: string;
  size: number;
  sha256: string;
  uploaded_by: string | null;
  created_at: string;
}

/** Accepted receipt types. A receipt is a photo or a PDF, nothing executable. */
const ALLOWED_MIME = new Set([
  "image/jpeg", "image/png", "image/webp", "image/heic", "image/heif", "application/pdf",
]);

/** 10 MB — a phone photo, comfortably, and no more. */
const MAX_BYTES = 10 * 1024 * 1024;

export function mimeFor(filename: string, declared?: string | null): string {
  if (declared && ALLOWED_MIME.has(declared)) return declared;
  const ext = filename.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  switch (ext) {
    case "jpg": case "jpeg": return "image/jpeg";
    case "png": return "image/png";
    case "webp": return "image/webp";
    case "heic": return "image/heic";
    case "heif": return "image/heif";
    case "pdf": return "application/pdf";
    default: return declared ?? "application/octet-stream";
  }
}

/** A refusal written for the person holding the file, not the error log. */
export class AttachmentRefused extends Refusal {}

export function addAttachment(
  db: DB, actor: Actor,
  input: { transactionId: string; filename: string; mime?: string | null; bytes: Uint8Array },
): AttachmentMeta {
  const mime = mimeFor(input.filename, input.mime);
  if (!ALLOWED_MIME.has(mime)) {
    throw new AttachmentRefused("A receipt must be an image or a PDF.");
  }
  if (input.bytes.length === 0) throw new AttachmentRefused("That file is empty.");
  if (input.bytes.length > MAX_BYTES) throw new AttachmentRefused("That file is too large — 10 MB is the limit.");

  return transact(db, () => {
    const transaction = queryOne<{ id: string }>(
      db, `SELECT id FROM transactions WHERE id = ? AND deleted_at IS NULL`, input.transactionId,
    );
    if (!transaction) throw new Error("That transaction does not exist.");

    const sha256 = createHash("sha256").update(input.bytes).digest("hex");

    // An identical re-upload to the same transaction is a no-op, not a
    // duplicate — the same photo attached twice is a mistake, not two receipts.
    const existing = queryOne<AttachmentMeta>(
      db,
      `SELECT id, transaction_id, filename, mime, size, sha256, uploaded_by, created_at
         FROM attachments WHERE transaction_id = ? AND sha256 = ?`,
      input.transactionId, sha256,
    );
    if (existing) return existing;

    const id = newId();
    execute(
      db,
      `INSERT INTO attachments
         (id,transaction_id,filename,mime,size,sha256,bytes,uploaded_by,created_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      id, input.transactionId, input.filename, mime, input.bytes.length, sha256,
      input.bytes, actor.memberId, nowIST(),
    );

    appendEvent(db, actor, {
      entity: "attachment", entityId: id, action: "add",
      after: { transactionId: input.transactionId, filename: input.filename, size: input.bytes.length },
      summary: `Attached ${input.filename} to a transaction`,
    });

    return getMeta(db, id)!;
  });
}

export function listAttachments(db: DB, transactionId: string): AttachmentMeta[] {
  return queryAll<AttachmentMeta>(
    db,
    `SELECT id, transaction_id, filename, mime, size, sha256, uploaded_by, created_at
       FROM attachments WHERE transaction_id = ? ORDER BY created_at`,
    transactionId,
  );
}

export function getMeta(db: DB, id: string): AttachmentMeta | null {
  return queryOne<AttachmentMeta>(
    db,
    `SELECT id, transaction_id, filename, mime, size, sha256, uploaded_by, created_at
       FROM attachments WHERE id = ?`,
    id,
  );
}

/** The bytes, for the view route. Kept out of the listing query on purpose. */
export function getBytes(db: DB, id: string): { meta: AttachmentMeta; bytes: Uint8Array } | null {
  const row = queryOne<AttachmentMeta & { bytes: Uint8Array }>(
    db, `SELECT * FROM attachments WHERE id = ?`, id,
  );
  if (!row) return null;
  const { bytes, ...meta } = row;
  return { meta, bytes: bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes) };
}

export function deleteAttachment(db: DB, actor: Actor, id: string): string | null {
  return transact(db, () => {
    const meta = getMeta(db, id);
    if (!meta) return null;
    execute(db, `DELETE FROM attachments WHERE id = ?`, id);
    appendEvent(db, actor, {
      entity: "attachment", entityId: id, action: "delete",
      before: { transactionId: meta.transaction_id, filename: meta.filename },
      summary: `Removed the attachment ${meta.filename}`,
    });
    return meta.transaction_id;
  });
}

// R37 · Undoing an *add* removes the attachment — the common "I attached the
// wrong photo" case. A *delete* cannot be undone, because the bytes are gone
// with the row; the event log keeps the record that it happened.
registerUndoHandler("attachment", (db, event) => {
  if (event.action === "add") {
    execute(db, `DELETE FROM attachments WHERE id = ?`, event.entityId);
    return "Removed the attachment.";
  }
  return "That receipt's file was deleted and cannot be restored.";
});
