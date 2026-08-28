import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { openDatabase, ensureHousehold, execute, type DB } from "../db/db.ts";
import type { Actor } from "../core/events.ts";
import { nowIST } from "../core/dates.ts";
import { rupees } from "../core/money.ts";
import { historyFor, undoEvent } from "../core/events.ts";
import { createAccount } from "./accounts.ts";
import { createTransaction } from "./transactions.ts";
import {
  addAttachment, listAttachments, getBytes, deleteAttachment, mimeFor,
} from "./attachments.ts";
import { controlTotals } from "../ops/backup.ts";

const RAVI = "m-ravi";
const actor: Actor = { memberId: RAVI, source: "ui" };

function setup() {
  const db = openDatabase({ path: ":memory:", verbose: false });
  ensureHousehold(db);
  execute(db, `INSERT INTO members (id,email,name,created_at) VALUES (?,?,?,?)`,
    RAVI, "ravi@example.com", "Ravi", nowIST());
  const bank = createAccount(db, actor, {
    name: "HDFC", kind: "budget", subtype: "savings", openingDate: "2026-08-01",
  });
  const txn = createTransaction(db, actor, {
    accountId: bank.id, amount: rupees(-450), date: "2026-08-10",
  });
  return { db, txnId: txn.id };
}

// A tiny valid JPEG header, enough to be bytes with a known sha.
const PHOTO = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);

describe("Q10 · receipt attachments", () => {
  test("a photo attaches and reads back byte-for-byte", () => {
    const { db, txnId } = setup();
    const meta = addAttachment(db, actor, { transactionId: txnId, filename: "receipt.jpg", bytes: PHOTO });
    assert.equal(meta.mime, "image/jpeg");
    assert.equal(meta.size, PHOTO.length);

    const back = getBytes(db, meta.id)!;
    assert.deepEqual(Buffer.from(back.bytes), Buffer.from(PHOTO));
    db.close();
  });

  test("the listing never carries the bytes", () => {
    const { db, txnId } = setup();
    addAttachment(db, actor, { transactionId: txnId, filename: "r.jpg", bytes: PHOTO });
    const list = listAttachments(db, txnId);
    assert.equal(list.length, 1);
    assert.ok(!("bytes" in list[0]!), "the metadata query omits the blob");
    db.close();
  });

  test("an identical re-upload is a no-op, not a duplicate", () => {
    const { db, txnId } = setup();
    const a = addAttachment(db, actor, { transactionId: txnId, filename: "r.jpg", bytes: PHOTO });
    const b = addAttachment(db, actor, { transactionId: txnId, filename: "r.jpg", bytes: PHOTO });
    assert.equal(a.id, b.id);
    assert.equal(listAttachments(db, txnId).length, 1);
    db.close();
  });

  test("only images and PDFs are accepted", () => {
    const { db, txnId } = setup();
    assert.throws(
      () => addAttachment(db, actor, { transactionId: txnId, filename: "x.exe", mime: "application/x-msdownload", bytes: PHOTO }),
      /image or a PDF/,
    );
    db.close();
  });

  test("mime is inferred from the extension when the browser is vague", () => {
    assert.equal(mimeFor("bill.pdf", "application/octet-stream"), "application/pdf");
    assert.equal(mimeFor("photo.HEIC", null), "image/heic");
    assert.equal(mimeFor("scan.png", "image/png"), "image/png");
  });

  test("Q10 / R40.2 · attachment bytes are in the control totals", () => {
    const { db, txnId } = setup();
    addAttachment(db, actor, { transactionId: txnId, filename: "r.jpg", bytes: PHOTO });
    const totals = controlTotals(db);
    assert.equal(totals.counts.attachments, 1);
    assert.equal(totals.attachmentBytesTotal, PHOTO.length);
    db.close();
  });

  test("R37 · undoing the upload removes it", () => {
    const { db, txnId } = setup();
    const meta = addAttachment(db, actor, { transactionId: txnId, filename: "r.jpg", bytes: PHOTO });
    const event = historyFor(db, "attachment", meta.id).find((e) => e.action === "add")!;
    undoEvent(db, event.id, actor);
    assert.equal(listAttachments(db, txnId).length, 0);
    db.close();
  });

  test("deleting is possible and returns its transaction", () => {
    const { db, txnId } = setup();
    const meta = addAttachment(db, actor, { transactionId: txnId, filename: "r.jpg", bytes: PHOTO });
    assert.equal(deleteAttachment(db, actor, meta.id), txnId);
    assert.equal(listAttachments(db, txnId).length, 0);
    db.close();
  });

  test("deleting the transaction cascades its attachments", () => {
    const { db, txnId } = setup();
    addAttachment(db, actor, { transactionId: txnId, filename: "r.jpg", bytes: PHOTO });
    execute(db, `DELETE FROM transactions WHERE id = ?`, txnId);
    assert.equal(listAttachments(db, txnId).length, 0);
    db.close();
  });
});
