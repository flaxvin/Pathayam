/**
 * FWD-2 · A receive-only SMTP server: the subset of RFC 5321 a mail exchanger
 * needs to accept forwarded bank mail for one domain and hand it on.
 *
 * It never relays, never queues and never writes to disk. A message is held in
 * memory only between the end of DATA and the hand-off's answer; whatever the
 * hand-off says becomes the reply to DATA, so a failure is the sending server's
 * to retry (4xx) or bounce (5xx) and nothing is ever silently dropped here.
 *
 * Supported: EHLO/HELO, MAIL (SIZE, BODY, SMTPUTF8 params), RCPT, DATA, RSET,
 * NOOP, VRFY (252), QUIT, STARTTLS (RFC 3207) and PIPELINING (RFC 2920), which
 * costs nothing here because commands are read from one buffer in order.
 */

import net from "node:net";
import tls from "node:tls";

export type SmtpReply = { code: number; message: string };

export type DeliverInput = {
  recipients: string[];
  /**
   * The message, in the order received. MAIL-8: it is held in the pieces it
   * was read into rather than copied into one buffer, which for a moment held
   * every message twice.
   */
  raw: readonly Uint8Array[];
  /** Its length in bytes: the pieces' lengths added up. */
  size: number;
  mailFrom: string;
  helo: string;
  remoteAddress: string;
};

export type RecipientVerdict = "ok" | SmtpReply;

export type SmtpServerOptions = {
  /** Our name in the banner and the EHLO reply. */
  hostname: string;
  /** The largest message accepted, in bytes as stored (CRLF line endings). */
  maxBytes: number;
  /** PEM certificate and key; STARTTLS is offered only when given. */
  tls?: { cert: string; key: string };
  /**
   * Decides each RCPT TO before any message data is taken. It may ask
   * somebody (MAIL-9); the session reads nothing more until it has answered.
   */
  checkRecipient(address: string): RecipientVerdict | Promise<RecipientVerdict>;
  /** Hands a finished message on; one reply per recipient, in order. */
  deliver(input: DeliverInput): Promise<SmtpReply[]>;
  log?(entry: Record<string, unknown>): void;
  /** Close a connection silent this long with a 421. Default five minutes. */
  idleTimeoutMs?: number;
  /**
   * MAIL-8 · Close any session this old with a 421, however busy it is: the
   * idle timer alone lets a byte every few minutes keep one open for ever.
   * Default ten minutes.
   */
  sessionTimeoutMs?: number;
  /** MAIL-8 · Bytes all sessions together may hold as messages. Default 96 MiB. */
  memoryBytes?: number;
  /** MAIL-8 · Sessions open at once; more are told 421. Default 20. */
  maxConnections?: number;
  /** MAIL-8 · Sessions open at once from one address; more are told 421. Default 3. */
  maxPerAddress?: number;
  /**
   * MAIL-8 · Each connection starts with a PROXY protocol v1 line naming the
   * real client, as Fly's proxy sends with `handlers = ["proxy_proto"]`.
   * Without it every client looks like the proxy and shares one address.
   */
  proxyProtocol?: boolean;
  /** Runs `fn` after `ms` and returns a cancel; tests pass a fake clock. */
  schedule?(fn: () => void, ms: number): () => void;
};

function schedule(fn: () => void, ms: number): () => void {
  const timer = setTimeout(fn, ms);
  return () => clearTimeout(timer);
}

/** RFC 5321 §4.5.3.1.4 says 512 octets; real clients send longer, so allow 4 KiB. */
export const MAX_COMMAND_LINE = 4096;
/** RFC 5321 §4.5.3.1.8 asks for at least 100; forwarding needs one or two. */
export const MAX_RECIPIENTS = 20;
/** Error replies before the connection is dropped: stops address probing. */
export const MAX_BAD_COMMANDS = 10;
export const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60_000;
export const DEFAULT_SESSION_TIMEOUT_MS = 10 * 60_000;
export const DEFAULT_MEMORY_BYTES = 96 * 1024 * 1024;
export const DEFAULT_MAX_CONNECTIONS = 20;
export const DEFAULT_MAX_PER_ADDRESS = 3;
/** How long a connection has to send its PROXY line. */
const PROXY_HEADER_TIMEOUT_MS = 10_000;
/** RFC: a v1 PROXY line is at most 107 bytes with its CRLF. */
const PROXY_HEADER_MAX = 107;

/**
 * MAIL-8 · A message is copied into slabs as it arrives: the first small, each
 * next one twice the last, up to SLAB_MAX. Nothing is ever copied twice, and a
 * slab is paid for from the shared budget before it is allocated.
 */
const SLAB_FIRST = 64 * 1024;
const SLAB_MAX = 1024 * 1024;
/** What a whole message may cost beyond its own size: one part-filled slab. */
export const SLAB_OVERHEAD = SLAB_MAX;
/**
 * A DATA line longer than this is taken in pieces rather than buffered whole.
 * RFC 5321 caps text lines at 1000 octets but real mail breaks that, so long
 * lines are tolerated; only the total is limited (by maxBytes).
 */
const DATA_PIECE = 64 * 1024;

const CRLF = Buffer.from("\r\n");
const EMPTY = Buffer.alloc(0);
const LF = 0x0a;
const CR = 0x0d;
const DOT = 0x2e;

export type SmtpServer = net.Server & {
  /**
   * TLS-1 · Swaps the certificate (or adds one to a server started without):
   * connections from now on offer STARTTLS with it, and a session already
   * open keeps the one it started with. A bad key pair throws and changes
   * nothing.
   */
  setTlsCertificate(pair: { cert: string; key: string }): void;
};

/** Creates the server; the caller listens on it. A bad TLS key pair throws here. */
export function createSmtpServer(opts: SmtpServerOptions): SmtpServer {
  let secureContext = opts.tls
    ? tls.createSecureContext({ cert: opts.tls.cert, key: opts.tls.key })
    : undefined;
  const shared: Shared = {
    budget: new Budget(opts.memoryBytes ?? DEFAULT_MEMORY_BYTES),
    open: 0,
    perAddress: new Map(),
  };
  const maxConnections = opts.maxConnections ?? DEFAULT_MAX_CONNECTIONS;
  const server = net.createServer((socket) => {
    try {
      admit(socket, opts, shared, maxConnections, secureContext);
    } catch (err) {
      safeLog(opts, { level: "error", msg: "smtp session failed", error: String(err) });
      socket.destroy();
    }
  }) as SmtpServer;
  server.setTlsCertificate = (pair) => {
    secureContext = tls.createSecureContext({ cert: pair.cert, key: pair.key });
  };
  // A backstop beyond the polite 421s below: past this the kernel's queue waits.
  server.maxConnections = maxConnections * 2;
  return server;
}

/** MAIL-8 · Bytes held as messages, across every session. */
export class Budget {
  used = 0;
  readonly limit: number;
  constructor(limit: number) {
    this.limit = limit;
  }
  take(n: number): boolean {
    if (this.used + n > this.limit) return false;
    this.used += n;
    return true;
  }
  give(n: number): void {
    this.used = Math.max(0, this.used - n);
  }
}

type Shared = { budget: Budget; open: number; perAddress: Map<string, number> };

/** Turns a refused connection away with a 421 and lets it go. */
function turnAway(socket: net.Socket, message: string): void {
  socket.on("error", () => {});
  socket.end(`421 ${message}\r\n`);
  setTimeout(() => socket.destroy(), 5_000).unref?.();
}

/**
 * MAIL-8 · Counts the connection, learns who it is from (from a PROXY line
 * when configured), applies the caps, then starts the SMTP session.
 */
function admit(
  socket: net.Socket, opts: SmtpServerOptions, shared: Shared, maxConnections: number,
  secureContext: tls.SecureContext | undefined,
): void {
  shared.open += 1;
  let address: string | null = null;
  socket.once("close", () => {
    shared.open -= 1;
    if (address === null) return;
    const n = (shared.perAddress.get(address) ?? 1) - 1;
    if (n <= 0) shared.perAddress.delete(address);
    else shared.perAddress.set(address, n);
  });
  if (shared.open > maxConnections) {
    safeLog(opts, { level: "warn", msg: "too many connections", open: shared.open - 1 });
    return turnAway(socket, `4.7.0 ${opts.hostname} Too many connections, try again later`);
  }
  const start = (remote: string, early: Buffer) => {
    const limit = opts.maxPerAddress ?? DEFAULT_MAX_PER_ADDRESS;
    const already = shared.perAddress.get(remote) ?? 0;
    if (already >= limit) {
      safeLog(opts, { level: "warn", msg: "too many connections from one address", remoteAddress: remote });
      return turnAway(socket, `4.7.0 ${opts.hostname} Too many connections from your address, try again later`);
    }
    address = remote;
    shared.perAddress.set(remote, already + 1);
    handleConnection(socket, opts, secureContext, shared.budget, remote, early);
  };
  if (!opts.proxyProtocol) return start(socket.remoteAddress ?? "unknown", EMPTY);

  let head: Buffer = EMPTY;
  const timer = setTimeout(() => socket.destroy(), PROXY_HEADER_TIMEOUT_MS);
  const done = () => {
    clearTimeout(timer);
    socket.removeListener("data", onHead);
  };
  const onHead = (chunk: Buffer) => {
    head = head.length === 0 ? chunk : Buffer.concat([head, chunk]);
    const end = head.indexOf("\r\n");
    if (end < 0) {
      if (head.length > PROXY_HEADER_MAX) { done(); socket.destroy(); }
      return;
    }
    done();
    const remote = parseProxyLine(head.subarray(0, end).toString("latin1"), socket.remoteAddress ?? "unknown");
    if (remote === null) {
      safeLog(opts, { level: "warn", msg: "bad PROXY line; is MX_PROXY_PROTOCOL set without the proxy sending one?" });
      socket.destroy();
      return;
    }
    start(remote, head.subarray(end + 2));
  };
  socket.on("data", onHead);
  socket.on("error", () => { done(); socket.destroy(); });
}

/** The client's address from a PROXY v1 line; the socket's own for UNKNOWN; null if malformed. */
export function parseProxyLine(line: string, fallback: string): string | null {
  const parts = line.split(" ");
  if (parts[0] !== "PROXY") return null;
  if (parts[1] === "UNKNOWN") return fallback;
  if ((parts[1] !== "TCP4" && parts[1] !== "TCP6") || parts.length !== 6) return null;
  const source = parts[2]!;
  if (net.isIP(source) !== (parts[1] === "TCP4" ? 4 : 6)) return null;
  return source;
}

/**
 * MAIL-8 · One message as it is read: slabs paid for from the budget, filled
 * in order. `append` answers false when the budget has no room for the next
 * slab; the caller then lets everything go.
 */
class MessageBuffer {
  private slabs: Buffer[] = [];
  private fill = 0;
  /** Bytes taken from the budget for the slabs now held. */
  private held = 0;
  size = 0;
  private readonly budget: Budget;

  constructor(budget: Budget) {
    this.budget = budget;
  }

  append(piece: Uint8Array): boolean {
    let at = 0;
    while (at < piece.length) {
      let slab = this.slabs.at(-1);
      if (!slab || this.fill === slab.length) {
        const next = slab ? Math.min(SLAB_MAX, slab.length * 2) : SLAB_FIRST;
        if (!this.budget.take(next)) return false;
        this.held += next;
        slab = Buffer.allocUnsafe(next);
        this.slabs.push(slab);
        this.fill = 0;
      }
      const n = Math.min(piece.length - at, slab.length - this.fill);
      slab.set(piece.subarray(at, at + n), this.fill);
      this.fill += n;
      at += n;
    }
    this.size += piece.length;
    return true;
  }

  /** The filled part of every slab, without copying. */
  parts(): Uint8Array[] {
    return this.slabs.map((s, i) => (i === this.slabs.length - 1 ? s.subarray(0, this.fill) : s));
  }

  release(): void {
    this.budget.give(this.held);
    this.held = 0;
    this.slabs = [];
    this.fill = 0;
    this.size = 0;
  }
}

function safeLog(opts: SmtpServerOptions, entry: Record<string, unknown>): void {
  try {
    opts.log?.(entry);
  } catch {
    // A broken logger must not take a session down with it.
  }
}

type Transaction = { mailFrom: string; recipients: string[]; declaredSize: number };

function handleConnection(
  raw: net.Socket, opts: SmtpServerOptions, secureContext: tls.SecureContext | undefined,
  budget: Budget, remoteAddress: string, early: Buffer,
): void {
  const idleMs = opts.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;

  let sock: net.Socket = raw;
  let secure = false;
  let closed = false;
  /** Set while a message is handed on or a recipient checked; input waits in `buf` until then. */
  let busy = false;
  let mode: "command" | "data" = "command";
  let buf: Buffer = EMPTY;
  /** Skipping the rest of an over-long command line, up to its LF. */
  let discarding = false;
  let bad = 0;
  let helo = "";
  let tx: Transaction | null = null;

  // DATA state: the message so far, its size, and where the current line is.
  let message = new MessageBuffer(budget);
  let size = 0;
  let oversize = false;
  /** MAIL-8 · The shared budget had no room: read to the dot, then 451. */
  let overBudget = false;
  let lineStart = true;

  // MAIL-8 · However the session is spent, it ends this long after it began.
  const cancelSessionTimer = (opts.schedule ?? schedule)(() => {
    reply(421, `4.4.2 ${opts.hostname} Session time limit reached, closing connection`);
    safeLog(opts, { level: "info", msg: "session time limit", remoteAddress });
    hangUp();
    freeMessage();
  }, opts.sessionTimeoutMs ?? DEFAULT_SESSION_TIMEOUT_MS);

  /** Lets go of the message being read, and its share of the budget. */
  function freeMessage(): void {
    message.release();
  }

  function reply(code: number, message: string): void {
    if (closed) return;
    sock.write(`${code} ${message}\r\n`);
  }

  function replyLines(code: number, lines: string[]): void {
    if (closed) return;
    const text = lines.map((l, i) => `${code}${i === lines.length - 1 ? " " : "-"}${l}\r\n`).join("");
    sock.write(text);
  }

  /** Ends the session from our side; a peer that never closes is cut off shortly after. */
  function hangUp(): void {
    if (closed) return;
    closed = true;
    sock.end();
    setTimeout(() => sock.destroy(), 5_000).unref?.();
  }

  function fail(code: number, message: string): void {
    reply(code, message);
    bad += 1;
    if (bad >= MAX_BAD_COMMANDS) {
      reply(421, `4.7.0 ${opts.hostname} Too many errors, closing connection`);
      hangUp();
    }
  }

  function resetTransaction(): void {
    tx = null;
    freeMessage();
    size = 0;
    oversize = false;
    overBudget = false;
    lineStart = true;
  }

  function onData(chunk: Buffer): void {
    if (closed) return;
    buf = buf.length === 0 ? chunk : Buffer.concat([buf, chunk]);
    pump();
  }

  function onTimeout(): void {
    reply(421, `4.4.2 ${opts.hostname} Idle timeout, closing connection`);
    hangUp();
  }

  function onError(err: Error): void {
    // Resets and TLS failures are routine on a public port 25; never rethrow.
    if (!closed) safeLog(opts, { level: "debug", msg: "smtp socket error", remoteAddress, error: err.message });
    closed = true;
    sock.destroy();
  }

  function onClose(): void {
    closed = true;
    cancelSessionTimer();
    freeMessage();
  }

  function attach(s: net.Socket): void {
    s.on("data", onData);
    s.on("error", onError);
    s.on("close", onClose);
    s.on("timeout", onTimeout);
    s.setTimeout(idleMs);
  }

  /** Works through every complete line in the buffer, which is what makes pipelining work. */
  function pump(): void {
    while (!busy && !closed) {
      if (mode === "data") {
        if (!takeDataLine()) break;
        continue;
      }
      const lf = buf.indexOf(LF);
      if (discarding) {
        if (lf < 0) { buf = EMPTY; break; }
        buf = buf.subarray(lf + 1);
        discarding = false;
        continue;
      }
      if (lf < 0) {
        if (buf.length > MAX_COMMAND_LINE) {
          buf = EMPTY;
          discarding = true;
          fail(500, "5.5.2 Line too long");
        }
        break;
      }
      if (lf + 1 > MAX_COMMAND_LINE) {
        buf = buf.subarray(lf + 1);
        fail(500, "5.5.2 Line too long");
        continue;
      }
      let line = buf.subarray(0, lf);
      buf = buf.subarray(lf + 1);
      if (line.at(-1) === CR) line = line.subarray(0, -1);
      command(line.toString("utf8"));
    }
  }

  /**
   * Takes one line of message data. Lines may end in CRLF or a bare LF; both
   * are stored as CRLF, which is what the hand-off contract promises.
   */
  function takeDataLine(): boolean {
    const lf = buf.indexOf(LF);
    if (lf < 0) {
      if (buf.length < DATA_PIECE) return false;
      // A very long line: take what we have, keeping a trailing CR in case its LF is next.
      const end = buf.at(-1) === CR ? buf.length - 1 : buf.length;
      let piece = buf.subarray(0, end);
      buf = buf.subarray(end);
      if (lineStart && piece[0] === DOT) piece = piece.subarray(1);
      append(piece);
      lineStart = false;
      return true;
    }
    let line = buf.subarray(0, lf);
    buf = buf.subarray(lf + 1);
    if (line.at(-1) === CR) line = line.subarray(0, -1);
    if (lineStart && line.length === 1 && line[0] === DOT) {
      endData();
      return true;
    }
    if (lineStart && line[0] === DOT) line = line.subarray(1); // RFC 5321 §4.5.2 dot-unstuffing
    append(line);
    append(CRLF);
    lineStart = true;
    return true;
  }

  /**
   * Over the size limit, or out of shared memory, we keep reading to the final
   * dot (so the reply lines up) but stop storing and let go of what was held.
   */
  function append(piece: Buffer): void {
    size += piece.length;
    if (oversize || overBudget) return;
    if (size > opts.maxBytes) {
      oversize = true;
      freeMessage();
      return;
    }
    if (!message.append(piece)) {
      overBudget = true;
      freeMessage();
    }
  }

  function endData(): void {
    mode = "command";
    const t = tx!;
    const base = {
      msg: "message", remoteAddress, helo, tls: secure, mailFrom: t.mailFrom,
      recipients: t.recipients.length, bytes: size,
    };
    if (oversize) {
      reply(552, `5.3.4 Message exceeds fixed maximum message size of ${opts.maxBytes} bytes`);
      safeLog(opts, { level: "info", ...base, codes: [], reply: 552 });
      resetTransaction();
      return;
    }
    if (overBudget) {
      reply(451, `4.3.1 ${opts.hostname} Insufficient system storage, try again later`);
      safeLog(opts, { level: "warn", ...base, codes: [], reply: 451, reason: "memory budget" });
      resetTransaction();
      return;
    }
    // The pieces go with the hand-off; the session reads any next message into new ones.
    const sent = message;
    message = new MessageBuffer(budget);
    busy = true;
    sock.pause();
    let results: SmtpReply[] = [];
    opts.deliver({
      recipients: [...t.recipients], raw: sent.parts(), size: sent.size, mailFrom: t.mailFrom, helo, remoteAddress,
    })
      .then(
        (r) => { results = r; },
        (err) => {
          safeLog(opts, { level: "error", msg: "delivery failed", remoteAddress, error: String(err) });
          results = t.recipients.map(() => ({ code: 451, message: "4.3.0 Temporary local problem, try again later" }));
        },
      )
      .finally(() => {
        sent.release();
        const failed = results.find((r) => r.code < 200 || r.code >= 300);
        const answer = failed ?? (results.length > 0
          ? { code: 250, message: "2.0.0 OK: message accepted" }
          : { code: 451, message: "4.3.0 Temporary local problem, try again later" });
        reply(answer.code, answer.message);
        safeLog(opts, {
          level: answer.code >= 500 ? "warn" : "info", ...base,
          codes: results.map((r) => r.code), reply: answer.code,
        });
        resetTransaction();
        busy = false;
        if (!closed) {
          sock.resume();
          pump();
        }
      });
  }

  function command(line: string): void {
    const sp = line.indexOf(" ");
    const verb = (sp < 0 ? line : line.slice(0, sp)).toUpperCase();
    const arg = sp < 0 ? "" : line.slice(sp + 1).trim();

    switch (verb) {
      case "EHLO": {
        if (!arg) return fail(501, "5.5.4 EHLO requires a domain");
        helo = arg;
        resetTransaction();
        const lines = [
          `${opts.hostname} greets ${arg}`,
          `SIZE ${opts.maxBytes}`,
          "8BITMIME",
          "PIPELINING",
          "SMTPUTF8",
        ];
        if (secureContext && !secure) lines.push("STARTTLS");
        return replyLines(250, lines);
      }
      case "HELO":
        if (!arg) return fail(501, "5.5.4 HELO requires a domain");
        helo = arg;
        resetTransaction();
        return reply(250, opts.hostname);
      case "MAIL":
        return mail(arg);
      case "RCPT":
        return rcpt(arg);
      case "DATA":
        if (arg) return fail(501, "5.5.4 DATA takes no arguments");
        if (!tx) return fail(503, "5.5.1 Need MAIL command");
        if (tx.recipients.length === 0) return fail(503, "5.5.1 Need RCPT command");
        // MAIL-8 · No room for even the message it said it would send: come back later.
        if (budget.used + Math.max(SLAB_FIRST, tx.declaredSize) > budget.limit) {
          safeLog(opts, { level: "warn", msg: "memory budget full at DATA", remoteAddress, used: budget.used });
          return reply(452, `4.3.1 ${opts.hostname} Insufficient system storage, try again later`);
        }
        mode = "data";
        freeMessage();
        size = 0;
        oversize = false;
        overBudget = false;
        lineStart = true;
        return reply(354, "End data with <CR><LF>.<CR><LF>");
      case "RSET":
        resetTransaction();
        return reply(250, "2.0.0 OK");
      case "NOOP":
        return reply(250, "2.0.0 OK");
      case "VRFY":
        return reply(252, "2.5.0 Cannot VRFY user, but will accept message and attempt delivery");
      case "QUIT":
        reply(221, `2.0.0 ${opts.hostname} closing connection`);
        return hangUp();
      case "STARTTLS":
        return startTls(arg);
      default:
        return fail(500, "5.5.2 Command not recognized");
    }
  }

  function mail(arg: string): void {
    if (!helo) return fail(503, "5.5.1 Send HELO/EHLO first");
    if (tx) return fail(503, "5.5.1 Sender already specified");
    const parsed = parsePath(arg, "FROM");
    if (!parsed) return fail(501, "5.5.4 Syntax: MAIL FROM:<address>");
    let declaredSize = 0;
    for (const [key, value] of parsed.params) {
      if (key === "SIZE") {
        if (!value || !/^\d+$/.test(value)) return fail(501, "5.5.4 Bad SIZE parameter");
        if (Number(value) > opts.maxBytes) {
          return reply(552, `5.3.4 Message size exceeds fixed maximum of ${opts.maxBytes} bytes`);
        }
        declaredSize = Number(value);
      } else if (key === "BODY") {
        if (value !== "7BIT" && value !== "8BITMIME") return fail(501, "5.5.4 Bad BODY parameter");
      } else if (key === "SMTPUTF8") {
        if (value !== undefined) return fail(501, "5.5.4 SMTPUTF8 takes no value");
      } else {
        return fail(555, `5.5.4 Unsupported parameter ${key}`);
      }
    }
    tx = { mailFrom: parsed.address, recipients: [], declaredSize };
    return reply(250, "2.1.0 OK");
  }

  function rcpt(arg: string): void {
    if (!tx) return fail(503, "5.5.1 Need MAIL command");
    const parsed = parsePath(arg, "TO");
    if (!parsed || !parsed.address) return fail(501, "5.5.4 Syntax: RCPT TO:<address>");
    if (parsed.params.length > 0) return fail(555, "5.5.4 Unsupported RCPT parameter");
    if (tx.recipients.length >= MAX_RECIPIENTS) return reply(452, "4.5.3 Too many recipients");
    const t = tx;
    const address = parsed.address;
    const answer = (verdict: RecipientVerdict) => {
      if (verdict === "ok") {
        t.recipients.push(address);
        return reply(250, "2.1.5 OK");
      }
      // Refused recipients count as errors, so one connection cannot probe for valid addresses.
      if (verdict.code >= 500) return fail(verdict.code, verdict.message);
      return reply(verdict.code, verdict.message);
    };
    let verdict: RecipientVerdict | Promise<RecipientVerdict>;
    try {
      verdict = opts.checkRecipient(address);
    } catch (err) {
      safeLog(opts, { level: "error", msg: "recipient check failed", remoteAddress, error: String(err) });
      verdict = { code: 451, message: "4.3.0 Temporary local problem, try again later" };
    }
    if (!(verdict instanceof Promise)) return answer(verdict);
    // MAIL-9 · The answer is somebody else's to give: read nothing more until it comes.
    busy = true;
    sock.pause();
    verdict
      .catch((err): RecipientVerdict => {
        safeLog(opts, { level: "error", msg: "recipient check failed", remoteAddress, error: String(err) });
        return { code: 451, message: "4.3.0 Temporary local problem, try again later" };
      })
      .then((v) => {
        busy = false;
        if (closed) return;
        answer(v);
        sock.resume();
        pump();
      });
  }

  function startTls(arg: string): void {
    if (!secureContext) return fail(502, "5.5.1 STARTTLS not available");
    if (secure) return fail(503, "5.5.1 TLS already active");
    if (arg) return fail(501, "5.5.4 STARTTLS takes no arguments");
    reply(220, "2.0.0 Ready to start TLS");
    // RFC 3207 §5: anything pipelined after STARTTLS was sent in the clear and
    // must not be acted on once TLS is up (the CVE-2011-0411 injection).
    buf = EMPTY;
    discarding = false;
    raw.removeListener("data", onData);
    raw.removeListener("timeout", onTimeout);
    raw.setTimeout(0);
    const t = new tls.TLSSocket(raw, { isServer: true, secureContext });
    sock = t;
    secure = true; // From here on nothing is read in the clear; a failed handshake errors out.
    helo = ""; // RFC 3207 §4.2: forget everything learned before the handshake.
    resetTransaction();
    attach(t);
  }

  attach(raw);
  reply(220, `${opts.hostname} ESMTP pathayam-mx`);
  if (early.length > 0) onData(early);
}

/**
 * Parses `FROM:<addr> PARAMS` / `TO:<addr> PARAMS`. Tolerates a space after
 * the colon and a missing pair of angle brackets, both common in the wild.
 */
function parsePath(
  arg: string, keyword: "FROM" | "TO",
): { address: string; params: [string, string | undefined][] } | null {
  const m = new RegExp(`^${keyword}:\\s*(?:<([^<>]*)>|([^\\s<>]+))(.*)$`, "i").exec(arg);
  if (!m) return null;
  let address = (m[1] ?? m[2] ?? "").trim();
  // Drop an RFC 5321 source route (<@a,@b:user@c>); it is obsolete and ignored.
  if (address.startsWith("@") && address.includes(":")) address = address.slice(address.indexOf(":") + 1);
  const rest = (m[3] ?? "").trim();
  if (rest && !/^\s/.test(m[3] ?? "")) return null;
  const params = rest
    ? rest.split(/\s+/).map((p): [string, string | undefined] => {
      const eq = p.indexOf("=");
      return eq < 0 ? [p.toUpperCase(), undefined] : [p.slice(0, eq).toUpperCase(), p.slice(eq + 1).toUpperCase()];
    })
    : [];
  return { address, params };
}
