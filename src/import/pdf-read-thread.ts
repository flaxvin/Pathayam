/**
 * PDF-1 · The worker side of `pdf-read.ts`: reads one PDF per message.
 *
 * Runs the same steps the synchronous readers do — read the objects, decrypt
 * with the first candidate that opens the file, expand object streams, extract
 * the text, parse it — but off the request thread, so a slow or hostile file
 * costs this thread's time and memory, never the server's.
 *
 * The file is read once and each candidate is tried against it: a wrong
 * password is refused by `fileKey` before any object is touched, so the
 * outcome is the same as re-reading the file for every candidate.
 */
import { parentPort } from "node:worker_threads";
import { readDocument, expandObjectStreams } from "../pdf/objects.ts";
import { decryptDocument, isEncrypted, WrongPassword } from "../pdf/decrypt.ts";
import { extractText } from "../pdf/text.ts";
import { parseStatementText } from "./pdf-statements.ts";
import { parseCasText } from "./cas.ts";

export type PdfReadKind = "statement" | "cas";

export interface PdfReadJob {
  id: number;
  kind: PdfReadKind;
  bytes: Uint8Array;
  candidates: string[];
}

type Outcome =
  | { ok: true; index: number; result: unknown }
  | { ok: true; index: -1 }
  | { ok: false; error: { name: string; message: string } };

export type PdfReadReply = Outcome & { id: number };

function read(job: PdfReadJob): Outcome {
  if (job.candidates.length === 0) return { ok: true, index: -1 };
  const doc = readDocument(job.bytes);
  let index = 0;
  if (isEncrypted(doc)) {
    index = -1;
    for (const [i, candidate] of job.candidates.entries()) {
      try {
        decryptDocument(doc, candidate);
        index = i;
        break;
      } catch (error) {
        if (error instanceof WrongPassword) continue;
        throw error;
      }
    }
    if (index < 0) return { ok: true, index: -1 };
  }
  expandObjectStreams(doc);
  const text = extractText(doc);
  const result = job.kind === "cas" ? parseCasText(text) : parseStatementText(text);
  return { ok: true, index, result };
}

parentPort?.on("message", (job: PdfReadJob) => {
  let reply: PdfReadReply;
  try {
    reply = { id: job.id, ...read(job) };
  } catch (error) {
    const e = error as Error;
    reply = { id: job.id, ok: false, error: { name: e?.name ?? "Error", message: e?.message ?? String(error) } };
  }
  parentPort!.postMessage(reply);
});
