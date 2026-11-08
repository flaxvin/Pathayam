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
  raw: Uint8Array;
  mailFrom: string;
  helo: string;
  remoteAddress: string;
};

export type SmtpServerOptions = {
  /** Our name in the banner and the EHLO reply. */
  hostname: string;
  /** The largest message accepted, in bytes as stored (CRLF line endings). */
  maxBytes: number;
  /** PEM certificate and key; STARTTLS is offered only when given. */
  tls?: { cert: string; key: string };
  /** Decides each RCPT TO before any message data is taken. */
  checkRecipient(address: string): "ok" | SmtpReply;
  /** Hands a finished message on; one reply per recipient, in order. */
  deliver(input: DeliverInput): Promise<SmtpReply[]>;
  log?(entry: Record<string, unknown>): void;
  /** Close a connection silent this long with a 421. Default five minutes. */
  idleTimeoutMs?: number;
};

/** RFC 5321 §4.5.3.1.4 says 512 octets; real clients send longer, so allow 4 KiB. */
export const MAX_COMMAND_LINE = 4096;
/** RFC 5321 §4.5.3.1.8 asks for at least 100; forwarding needs one or two. */
export const MAX_RECIPIENTS = 20;
/** Error replies before the connection is dropped: stops address probing. */
export const MAX_BAD_COMMANDS = 10;
export const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60_000;

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

/** Creates the server; the caller listens on it. A bad TLS key pair throws here. */
export function createSmtpServer(opts: SmtpServerOptions): net.Server {
  const secureContext = opts.tls
    ? tls.createSecureContext({ cert: opts.tls.cert, key: opts.tls.key })
    : undefined;
  return net.createServer((socket) => {
    try {
      handleConnection(socket, opts, secureContext);
    } catch (err) {
      safeLog(opts, { level: "error", msg: "smtp session failed", error: String(err) });
      socket.destroy();
    }
  });
}

function safeLog(opts: SmtpServerOptions, entry: Record<string, unknown>): void {
  try {
    opts.log?.(entry);
  } catch {
    // A broken logger must not take a session down with it.
  }
}

type Transaction = { mailFrom: string; recipients: string[] };

function handleConnection(
  raw: net.Socket, opts: SmtpServerOptions, secureContext: tls.SecureContext | undefined,
): void {
  const remoteAddress = raw.remoteAddress ?? "unknown";
  const idleMs = opts.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;

  let sock: net.Socket = raw;
  let secure = false;
  let closed = false;
  /** Set while a message is being handed on; input waits in `buf` until then. */
  let busy = false;
  let mode: "command" | "data" = "command";
  let buf: Buffer = EMPTY;
  /** Skipping the rest of an over-long command line, up to its LF. */
  let discarding = false;
  let bad = 0;
  let helo = "";
  let tx: Transaction | null = null;

  // DATA state: the message so far, its size, and where the current line is.
  let chunks: Buffer[] = [];
  let size = 0;
  let oversize = false;
  let lineStart = true;

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
    setTimeout(() => sock.destroy(), 5_000).unref();
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
    chunks = [];
    size = 0;
    oversize = false;
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

  /** Over the limit we keep reading to the final dot (so the reply lines up) but stop storing. */
  function append(piece: Buffer): void {
    size += piece.length;
    if (oversize) return;
    if (size > opts.maxBytes) {
      oversize = true;
      chunks = [];
      return;
    }
    chunks.push(piece);
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
    const message = new Uint8Array(Buffer.concat(chunks, size));
    chunks = [];
    busy = true;
    sock.pause();
    let results: SmtpReply[] = [];
    opts.deliver({ recipients: [...t.recipients], raw: message, mailFrom: t.mailFrom, helo, remoteAddress })
      .then(
        (r) => { results = r; },
        (err) => {
          safeLog(opts, { level: "error", msg: "delivery failed", remoteAddress, error: String(err) });
          results = t.recipients.map(() => ({ code: 451, message: "4.3.0 Temporary local problem, try again later" }));
        },
      )
      .finally(() => {
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
        mode = "data";
        chunks = [];
        size = 0;
        oversize = false;
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
    for (const [key, value] of parsed.params) {
      if (key === "SIZE") {
        if (!value || !/^\d+$/.test(value)) return fail(501, "5.5.4 Bad SIZE parameter");
        if (Number(value) > opts.maxBytes) {
          return reply(552, `5.3.4 Message size exceeds fixed maximum of ${opts.maxBytes} bytes`);
        }
      } else if (key === "BODY") {
        if (value !== "7BIT" && value !== "8BITMIME") return fail(501, "5.5.4 Bad BODY parameter");
      } else if (key === "SMTPUTF8") {
        if (value !== undefined) return fail(501, "5.5.4 SMTPUTF8 takes no value");
      } else {
        return fail(555, `5.5.4 Unsupported parameter ${key}`);
      }
    }
    tx = { mailFrom: parsed.address, recipients: [] };
    return reply(250, "2.1.0 OK");
  }

  function rcpt(arg: string): void {
    if (!tx) return fail(503, "5.5.1 Need MAIL command");
    const parsed = parsePath(arg, "TO");
    if (!parsed || !parsed.address) return fail(501, "5.5.4 Syntax: RCPT TO:<address>");
    if (parsed.params.length > 0) return fail(555, "5.5.4 Unsupported RCPT parameter");
    if (tx.recipients.length >= MAX_RECIPIENTS) return reply(452, "4.5.3 Too many recipients");
    const verdict = opts.checkRecipient(parsed.address);
    if (verdict === "ok") {
      tx.recipients.push(parsed.address);
      return reply(250, "2.1.5 OK");
    }
    // Refused recipients count as errors, so one connection cannot probe for valid addresses.
    if (verdict.code >= 500) return fail(verdict.code, verdict.message);
    return reply(verdict.code, verdict.message);
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
