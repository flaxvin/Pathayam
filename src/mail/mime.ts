/**
 * FWD-2 · A small RFC 5322 / MIME reader for forwarded bank mail.
 *
 * The forwarding address receives raw message bytes: a bank alert or a
 * statement, usually auto-forwarded by Gmail (original headers and body kept,
 * Gmail's own headers on top) or forwarded by hand "as attachment" (the
 * original rides inside a message/rfc822 part). This module turns those bytes
 * into the few things the importer needs: who sent it, the subject, the text,
 * and every named attachment (the caller picks out the PDFs).
 *
 * Bytes are handled as a latin1 string throughout (one char per octet), so
 * 8-bit and binary content survives until a charset or transfer decoding is
 * applied on purpose. Nothing here throws: a malformed message yields whatever
 * could be read.
 */

export interface MailHeader { name: string; value: string }
export interface MailAttachment { filename: string; contentType: string; bytes: Uint8Array }
export interface ParsedMail {
  headers: MailHeader[];
  from: string;
  subject: string;
  date: Date | null;
  messageId: string | null;
  text: string;
  attachments: MailAttachment[];
}

/** Deepest multipart / message/rfc822 nesting followed; deeper parts are ignored. */
const MAX_DEPTH = 24;

export function parseMail(raw: Uint8Array): ParsedMail {
  const out: ParsedMail = {
    headers: [], from: "", subject: "", date: null, messageId: null, text: "", attachments: [],
  };
  try {
    const s = Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength).toString("latin1");
    const top = splitEntity(s);
    out.headers = top.headers.map((h) => ({ name: h.name, value: headerText(h.value) }));
    const from = mailHeader(out, "from");
    out.from = from === null ? "" : addressOf(decodeWords(from));
    out.subject = decodeWords(mailHeader(out, "subject") ?? "");
    out.date = parseDate(mailHeader(out, "date"));
    const mid = mailHeader(out, "message-id");
    out.messageId = mid === null ? null : (mid.trim().replace(/^<|>$/g, "").trim() || null);

    const acc: Collected = { plain: [], html: [], attachments: [] };
    walk(top, acc, 0);
    out.attachments = acc.attachments;
    const text = acc.plain.length > 0 ? acc.plain.join("\n") : acc.html.map(htmlToText).join("\n");
    out.text = text.replace(/\r\n?/g, "\n");
  } catch {
    // Keep whatever was filled in before the failure.
  }
  return out;
}

/** The first header with this name (case-insensitive), or null. */
export function mailHeader(mail: ParsedMail, name: string): string | null {
  const want = name.toLowerCase();
  for (const h of mail.headers) if (h.name.toLowerCase() === want) return h.value;
  return null;
}

/** `"Name" <a@b.c>` → `a@b.c`, lowercased. A bare address passes through. */
export function addressOf(value: string): string {
  const angle = value.match(/<([^<>]*)>/);
  if (angle) return angle[1]!.trim().toLowerCase();
  // No angle brackets: drop comments and take the first thing shaped like an address.
  const bare = value.replace(/\([^()]*\)/g, " ");
  const m = bare.match(/[^\s<>(),;:"]+@[^\s<>(),;:"]+/);
  return (m ? m[0] : bare.trim()).toLowerCase();
}

// ---------------------------------------------------------------------------
// Entities

interface RawHeader { name: string; value: string } // value: unfolded, latin1
interface Entity { headers: RawHeader[]; body: string }
interface Collected { plain: string[]; html: string[]; attachments: MailAttachment[] }

/** Split a header block from its body. Accepts CRLF or bare LF line ends. */
function splitEntity(s: string): Entity {
  const headers: RawHeader[] = [];
  let pos = 0;
  let first = true;
  while (pos < s.length) {
    const nl = s.indexOf("\n", pos);
    const end = nl === -1 ? s.length : nl;
    const line = s.slice(pos, end).replace(/\r$/, "");
    const next = nl === -1 ? s.length : nl + 1;
    if (line === "") return { headers, body: s.slice(next) };
    const last = headers[headers.length - 1];
    if ((line[0] === " " || line[0] === "\t") && last) {
      last.value += line; // unfold: the line break goes, the whitespace stays
    } else {
      const m = line.match(/^([^:\s]+)[ \t]*:(.*)$/);
      if (m) headers.push({ name: m[1]!, value: m[2]! });
      else if (!(first && line.startsWith("From "))) {
        // Not a header and not an mbox "From " line: the header block ended without a blank line.
        return { headers, body: s.slice(pos) };
      }
    }
    first = false;
    pos = next;
  }
  return { headers, body: "" };
}

function rawHeader(e: Entity, name: string): string | null {
  for (const h of e.headers) if (h.name.toLowerCase() === name) return h.value;
  return null;
}

function walk(e: Entity, acc: Collected, depth: number): void {
  if (depth > MAX_DEPTH) return;
  const ct = parseStructured(rawHeader(e, "content-type") ?? "text/plain");
  const type = ct.value.toLowerCase() || "text/plain";
  const disp = parseStructured(rawHeader(e, "content-disposition") ?? "");

  if (type.startsWith("multipart/")) {
    const boundary = ct.params.get("boundary");
    if (!boundary) {
      // A multipart without a boundary cannot be split; read it as text rather than lose it.
      acc.plain.push(e.body);
      return;
    }
    for (const part of splitMultipart(e.body, boundary)) {
      try { walk(splitEntity(part), acc, depth + 1); } catch { /* skip the bad part */ }
    }
    return;
  }

  const bytes = decodeTransfer(e.body, (rawHeader(e, "content-transfer-encoding") ?? "").trim().toLowerCase());
  const filename = disp.params.get("filename") ?? ct.params.get("name") ?? "";

  if (filename) {
    acc.attachments.push({ filename, contentType: type, bytes });
  }
  if (type === "message/rfc822" || type === "message/global") {
    // "Forward as attachment": the bank's original is inside; collect its parts too.
    walk(splitEntity(Buffer.from(bytes).toString("latin1")), acc, depth + 1);
    return;
  }
  if (filename) return;
  if (type === "text/plain") acc.plain.push(decodeCharset(bytes, ct.params.get("charset")));
  else if (type === "text/html") acc.html.push(decodeCharset(bytes, ct.params.get("charset")));
}

/**
 * The parts between `--boundary` delimiter lines. The line break before a
 * delimiter belongs to the delimiter (RFC 2046 §5.1.1). Without a closing
 * delimiter the last part runs to the end, so a truncated message still yields
 * its earlier parts.
 */
function splitMultipart(body: string, boundary: string): string[] {
  const esc = boundary.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`(?:^|\\r?\\n)--${esc}(--)?[ \\t]*(?=\\r?\\n|$)`, "g");
  const parts: string[] = [];
  let start = -1;
  for (let m = re.exec(body); m; m = re.exec(body)) {
    if (start >= 0) parts.push(body.slice(start, m.index));
    if (m[1]) return parts;
    let after = m.index + m[0].length;
    if (body[after] === "\r") after++;
    if (body[after] === "\n") after++;
    start = after;
  }
  if (start >= 0 && start < body.length) parts.push(body.slice(start));
  return parts;
}

// ---------------------------------------------------------------------------
// Decoding

function decodeTransfer(body: string, cte: string): Uint8Array {
  if (cte === "base64") {
    // Buffer's base64 decoder tolerates missing padding; strip everything else it would choke on.
    return Buffer.from(body.replace(/[^A-Za-z0-9+/]/g, ""), "base64");
  }
  if (cte === "quoted-printable") return Buffer.from(decodeQp(body), "latin1");
  return Buffer.from(body, "latin1"); // 7bit, 8bit, binary, or unknown
}

function decodeQp(s: string): string {
  return s
    .replace(/[ \t]+(?=\r?\n)/g, "") // trailing whitespace is transport padding (RFC 2045 §6.7 rule 3)
    .replace(/=\r?\n/g, "") // soft line breaks
    .replace(/=([0-9A-Fa-f]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)));
}

function decodeCharset(bytes: Uint8Array, charset: string | undefined): string {
  const label = (charset ?? "utf-8").trim().toLowerCase() || "utf-8";
  try {
    return new TextDecoder(label).decode(bytes);
  } catch {
    return Buffer.from(bytes).toString("latin1");
  }
}

/** Header bytes as text: UTF-8 when valid (RFC 6532), latin1 otherwise. */
function headerText(latin1: string): string {
  const v = latin1.trim();
  if (!/[\x80-\xff]/.test(v)) return v;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(v, "latin1"));
  } catch {
    return v;
  }
}

/**
 * RFC 2047 encoded words. Whitespace between adjacent encoded words is dropped
 * (§6.2), and adjacent words in one charset are joined as bytes before
 * decoding, since senders split multi-byte characters across words.
 */
function decodeWords(value: string): string {
  const re = /=\?([^?\s]+)\?([BbQq])\?([^?\s]*)\?=/g;
  let out = "";
  let last = 0;
  let pending: { charset: string; bytes: number[] } | null = null;
  const flush = (): void => {
    if (pending) out += decodeCharset(Uint8Array.from(pending.bytes), pending.charset);
    pending = null;
  };
  for (let m = re.exec(value); m; m = re.exec(value)) {
    const between = value.slice(last, m.index);
    if (!(pending && /^[ \t\r\n]*$/.test(between))) {
      flush();
      out += between;
    }
    const charset = m[1]!.split("*")[0]!.toLowerCase(); // RFC 2231 §5 language suffix
    const enc = m[2]!.toUpperCase();
    const text = m[3]!;
    const bytes = enc === "B"
      ? Buffer.from(text.replace(/[^A-Za-z0-9+/]/g, ""), "base64")
      : Buffer.from(decodeQp(text.replace(/_/g, " ")), "latin1");
    if (pending && pending.charset !== charset) flush();
    if (!pending) pending = { charset, bytes: [] };
    for (const b of bytes) pending.bytes.push(b);
    last = m.index + m[0].length;
  }
  flush();
  return out + value.slice(last);
}

/**
 * `value; a=b; c="d"` with RFC 2231 continuations (`name*0=`, `name*1*=`) and
 * charset-tagged values (`name*=utf-8''%E2%82%B9`). Plain values may also hold
 * RFC 2047 encoded words, which many mailers use for filenames regardless.
 */
function parseStructured(header: string): { value: string; params: Map<string, string> } {
  const v = headerText(header);
  const semi = v.indexOf(";");
  const value = (semi === -1 ? v : v.slice(0, semi)).trim();
  const params = new Map<string, string>();
  if (semi === -1) return { value, params };

  type Piece = { index: number; encoded: boolean; text: string };
  const groups = new Map<string, Piece[]>();
  const rest = v.slice(semi + 1);
  let i = 0;
  while (i < rest.length) {
    while (i < rest.length && /[\s;]/.test(rest[i]!)) i++;
    const eq = rest.indexOf("=", i);
    if (eq === -1) break;
    const key = rest.slice(i, eq).trim().toLowerCase();
    i = eq + 1;
    while (i < rest.length && /[ \t]/.test(rest[i]!)) i++;
    let val = "";
    if (rest[i] === '"') {
      i++;
      while (i < rest.length && rest[i] !== '"') {
        if (rest[i] === "\\" && i + 1 < rest.length) i++;
        val += rest[i];
        i++;
      }
      i++;
    } else {
      const end = rest.indexOf(";", i);
      val = (end === -1 ? rest.slice(i) : rest.slice(i, end)).trim();
      i = end === -1 ? rest.length : end;
    }
    const m = key.match(/^([^*]+)(?:\*(\d+))?(\*)?$/);
    if (!m) continue;
    const list = groups.get(m[1]!) ?? [];
    list.push({ index: m[2] === undefined ? 0 : Number(m[2]), encoded: m[3] === "*", text: val });
    groups.set(m[1]!, list);
  }

  for (const [name, pieces] of groups) {
    pieces.sort((a, b) => a.index - b.index);
    if (!pieces.some((p) => p.encoded)) {
      const joined = pieces.map((p) => p.text).join("");
      params.set(name, name === "boundary" ? joined : decodeWords(joined));
      continue;
    }
    let charset = "utf-8";
    const bytes: number[] = [];
    pieces.forEach((p, n) => {
      let text = p.text;
      if (p.encoded && n === 0) {
        const parts = text.split("'");
        if (parts.length >= 3) {
          charset = parts[0] || "utf-8";
          text = parts.slice(2).join("'");
        }
      }
      if (p.encoded) {
        for (let k = 0; k < text.length; k++) {
          const hex = text.slice(k + 1, k + 3);
          if (text[k] === "%" && /^[0-9A-Fa-f]{2}$/.test(hex)) {
            bytes.push(parseInt(hex, 16));
            k += 2;
          } else {
            bytes.push(...Buffer.from(text[k]!, "utf8"));
          }
        }
      } else {
        bytes.push(...Buffer.from(text, "utf8"));
      }
    });
    params.set(name, decodeCharset(Uint8Array.from(bytes), charset));
  }
  return { value, params };
}

function parseDate(v: string | null): Date | null {
  if (!v) return null;
  // Drop RFC 5322 comments such as "(IST)", which Date.parse rejects.
  const d = new Date(v.replace(/\([^()]*\)/g, " ").replace(/\s+/g, " ").trim());
  return Number.isNaN(d.getTime()) ? null : d;
}

const ENTITIES: Record<string, string> = { nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

/**
 * The markup gone, by scanning rather than by pattern: everything from a "<"
 * to its ">" is dropped, comments and script, style and head elements with
 * their contents, and a "<" with no ">" after it ends the text. Regex passes
 * left "<scr<script>ipt>" behind as a tag. Block ends become line breaks.
 */
function stripMarkup(html: string): string {
  let out = "";
  let i = 0;
  const lower = html.toLowerCase();
  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt < 0) { out += html.slice(i); break; }
    out += html.slice(i, lt);
    if (lower.startsWith("<!--", lt)) {
      const end = lower.indexOf("-->", lt + 4);
      if (end < 0) break;
      i = end + 3;
      continue;
    }
    const gt = html.indexOf(">", lt + 1);
    if (gt < 0) break;
    const tag = /^<\s*(\/?)\s*([a-z0-9]+)/.exec(lower.slice(lt, gt + 1));
    const name = tag?.[2] ?? "";
    const closing = tag?.[1] === "/";
    i = gt + 1;
    if (!closing && (name === "script" || name === "style" || name === "head")) {
      // Skip to the matching close tag; with none, the rest is that element's.
      const close = lower.indexOf(`</${name}`, i);
      if (close < 0) break;
      const closeEnd = html.indexOf(">", close);
      if (closeEnd < 0) break;
      i = closeEnd + 1;
      continue;
    }
    if (name === "br" || (closing && /^(p|div|tr|li|h[1-6]|table)$/.test(name))) out += "\n";
    else if (closing && (name === "td" || name === "th")) out += " ";
  }
  return out;
}

/** Enough HTML-to-text for an alert email: block ends become line breaks, tags go, entities decode. */
function htmlToText(html: string): string {
  return stripMarkup(html)
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, e: string) => {
      if (e[0] === "#") {
        const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        try { return String.fromCodePoint(code); } catch { return whole; }
      }
      return ENTITIES[e.toLowerCase()] ?? whole;
    })
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
