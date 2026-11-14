/**
 * PDF-1 · Every PDF the app reads is read here, in a worker thread.
 *
 * Reading a PDF is the one thing a visitor can make this server do for
 * seconds at a time: a 30-60 KB file that stays inside every memory cap
 * (IMPORT-1..6) still cost 2.5-5.5 s of CPU, on the thread that answers every
 * other request — the public demo included, where /import/pdf is open to
 * anyone. So the reading moves to a worker:
 *
 * - **A deadline.** A file that takes longer than PDF_READ_DEADLINE_MS is
 *   abandoned (the worker is terminated) and the person told so. No genuine
 *   statement comes near it: the largest real one reads in well under a second.
 * - **A memory cap.** The worker's heap is limited; a file that needs more
 *   ends the worker, not the server.
 * - **One at a time.** One worker reads one file. An upload that arrives while
 *   another is being read is answered "try again in a moment" (PdfBusy); a
 *   background read — a Gmail fetch, a forwarded statement, a held one being
 *   retried — waits its turn instead, since nobody is there to try again.
 *
 * The result types are the ones the synchronous readers return
 * (`parseStatementPdf`, `parseCasPdf`), which stay for tests and tools.
 */
import { Worker } from "node:worker_threads";
import { Refusal } from "../core/refusal.ts";
import { WrongPassword } from "../pdf/decrypt.ts";
import { BANKS, type StatementParse } from "./pdf-statements.ts";
import type { CasStatement } from "./cas.ts";
import type { PdfReadJob, PdfReadKind, PdfReadReply } from "./pdf-read-thread.ts";

/** How long one file may take, candidates included. */
export const PDF_READ_DEADLINE_MS = 10_000;
/** The worker's heap. A real statement needs a few MB; IMPORT-6's worst case fits in 256. */
export const PDF_READ_HEAP_MB = 256;

const limits = { deadlineMs: PDF_READ_DEADLINE_MS, heapMb: PDF_READ_HEAP_MB };

/** Tests only: a shorter deadline or a smaller heap. Restarts the worker. */
export function setPdfReadLimits(next: Partial<typeof limits>): void {
  if (next.deadlineMs !== undefined) limits.deadlineMs = next.deadlineMs;
  if (next.heapMb !== undefined) limits.heapMb = next.heapMb;
  stopPdfReader();
}

/** The file could not be read in its time or memory; nothing was imported. */
export class PdfReadFailed extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PdfReadFailed";
  }
}

/** Another file is being read and this caller does not wait. */
export class PdfBusy extends Error {
  readonly status = 503;
  constructor() {
    super("Another statement is being read, try again in a moment.");
    this.name = "PdfBusy";
  }
}

export const PDF_TOO_SLOW =
  "This PDF took too long to read, so nothing was imported from it. A bank statement reads in a " +
  "second or two — download it from the bank again and try once more.";
export const PDF_TOO_LARGE =
  "This PDF needed more memory to read than any statement does, so nothing was imported from it.";
export const PDF_READER_FAILED =
  "Reading this PDF stopped part-way, so nothing was imported from it. Try once more.";

export interface PdfReadOptions {
  /**
   * Background reads wait for the reader; an upload is told to try again.
   * Default false: the interactive answer.
   */
  wait?: boolean;
}

// ---------------------------------------------------------------------------
// One at a time
// ---------------------------------------------------------------------------

let busy = false;
const waiting: (() => void)[] = [];

async function acquire(wait: boolean): Promise<void> {
  if (!busy) { busy = true; return; }
  if (!wait) throw new PdfBusy();
  await new Promise<void>((resolve) => waiting.push(resolve));
  // `release` hands the slot over without clearing `busy`.
}

function release(): void {
  const next = waiting.shift();
  if (next) next();
  else busy = false;
}

/** Whether a read is running or waiting (tests, health). */
export function pdfReaderBusy(): boolean {
  return busy;
}

// ---------------------------------------------------------------------------
// The worker
// ---------------------------------------------------------------------------

/*
 * The worker's source sits beside this file: `.ts` when the app runs from
 * source (dev, tests, `--experimental-strip-types`), `.js` in the built image
 * (`node dist/main.js`). tsc rewrites import specifiers, not URLs, so the
 * extension follows this module's own.
 */
const WORKER_URL = new URL(
  import.meta.url.endsWith(".ts") ? "./pdf-read-thread.ts" : "./pdf-read-thread.js",
  import.meta.url,
);

let worker: Worker | null = null;
let nextId = 1;

function spawn(): Worker {
  const w = new Worker(WORKER_URL, {
    resourceLimits: { maxOldGenerationSizeMb: limits.heapMb },
    // execArgv is left to inherit: Node passes the parent's per-thread flags
    // (--experimental-strip-types) and drops process-wide ones (--watch, the
    // test runner's). Naming them explicitly makes Node refuse the worker.
  });
  // Idle, it must not keep the process alive (tests, a clean shutdown).
  w.unref();
  return w;
}

/** Ends the worker, if any; the next read starts a new one. */
export function stopPdfReader(): void {
  const w = worker;
  worker = null;
  if (w) void w.terminate();
}

function runInWorker(job: Omit<PdfReadJob, "id">): Promise<PdfReadReply> {
  const w = worker ?? (worker = spawn());
  const id = nextId++;
  return new Promise<PdfReadReply>((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      w.off("message", onMessage);
      w.off("error", onError);
      w.off("exit", onExit);
      w.unref();
      fn();
    };
    const discard = () => {
      if (worker === w) worker = null;
      void w.terminate();
    };
    const onMessage = (reply: PdfReadReply) => {
      if (reply.id === id) finish(() => resolve(reply));
    };
    const onError = (error: Error & { code?: string }) => {
      discard();
      finish(() => reject(new PdfReadFailed(
        error?.code === "ERR_WORKER_OUT_OF_MEMORY" ? PDF_TOO_LARGE : PDF_READER_FAILED,
      )));
    };
    const onExit = () => {
      if (worker === w) worker = null;
      finish(() => reject(new PdfReadFailed(PDF_READER_FAILED)));
    };
    const timer = setTimeout(() => {
      discard();
      finish(() => reject(new PdfReadFailed(PDF_TOO_SLOW)));
    }, limits.deadlineMs);

    w.on("message", onMessage);
    w.on("error", onError);
    w.on("exit", onExit);
    w.ref();
    w.postMessage({ ...job, id });
  });
}

function rebuild(error: { name: string; message: string }): Error {
  if (error.name === "Refusal") return new Refusal(error.message);
  const e = new Error(error.message);
  e.name = error.name;
  return e;
}

async function read(
  kind: PdfReadKind, bytes: Uint8Array, candidates: string[], options: PdfReadOptions,
): Promise<{ index: number; result: unknown } | null> {
  await acquire(options.wait === true);
  try {
    const reply = await runInWorker({ kind, bytes, candidates });
    if (!reply.ok) throw rebuild(reply.error);
    if (reply.index < 0 || !("result" in reply)) return null;
    return { index: reply.index, result: reply.result };
  } finally {
    release();
  }
}

// ---------------------------------------------------------------------------
// What callers use
// ---------------------------------------------------------------------------

/**
 * A bank statement, opened with the first candidate that works — null when
 * none does. Any other failure throws: a Refusal or reader error as the
 * synchronous reader would, PdfReadFailed past the deadline or memory cap,
 * PdfBusy when another file is being read and `wait` is not set.
 */
export async function readStatementPdf(
  bytes: Uint8Array, candidates: string[], options: PdfReadOptions = {},
): Promise<{ parse: StatementParse; candidate: string } | null> {
  const read_ = await read("statement", bytes, candidates, options);
  if (!read_) return null;
  const parse = read_.result as StatementParse;
  // Cloned across the thread: point back at the one profile, as parseStatementText does.
  if (parse.bank) parse.bank = BANKS.find((b) => b.id === parse.bank!.id) ?? parse.bank;
  return { parse, candidate: candidates[read_.index]! };
}

/** A CAS, as `parseCasPdf` reads it; WrongPassword when the password does not open it. */
export async function readCasPdf(
  bytes: Uint8Array, password: string, options: PdfReadOptions = {},
): Promise<CasStatement> {
  const read_ = await read("cas", bytes, [password], options);
  if (!read_) throw new WrongPassword();
  return read_.result as CasStatement;
}
