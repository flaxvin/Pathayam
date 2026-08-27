/**
 * A PDF object reader, sized for one job: opening a CDSL CAS.
 *
 * This is not a general PDF library and does not try to be. It reads the
 * subset of PDF 1.7 that registrar-generated statements actually use —
 * dictionaries, arrays, names, strings, numbers, references, and Flate
 * streams — and gives up loudly on anything else rather than guessing.
 *
 * Two deliberate simplifications:
 *
 *   · The cross-reference table is not followed. Instead every `N G obj` in
 *     the file is scanned for directly. Statement PDFs are small, and a
 *     linear scan is immune to the broken xref offsets that generators
 *     regularly emit — which is the single most common reason a real file
 *     fails to open.
 *   · Object streams (`/Type /ObjStm`) are expanded after the first pass,
 *     because compressed-object files put the page tree inside them.
 */

import { inflateSync } from "node:zlib";

export type PdfName = { name: string };
export type PdfRef = { num: number; gen: number };
export type PdfDict = Map<string, PdfValue>;
export type PdfStream = { dict: PdfDict; raw: Uint8Array };
export type PdfValue =
  | null
  | boolean
  | number
  | Uint8Array // strings, kept as bytes: they may be encrypted
  | PdfName
  | PdfRef
  | PdfValue[]
  | PdfDict
  | PdfStream;

export function isName(v: PdfValue | undefined): v is PdfName {
  return typeof v === "object" && v !== null && "name" in v;
}
export function isRef(v: PdfValue | undefined): v is PdfRef {
  return typeof v === "object" && v !== null && "num" in v && "gen" in v;
}
export function isDict(v: PdfValue | undefined): v is PdfDict {
  return v instanceof Map;
}
export function isStream(v: PdfValue | undefined): v is PdfStream {
  return typeof v === "object" && v !== null && "raw" in v && "dict" in v;
}
export function isBytes(v: PdfValue | undefined): v is Uint8Array {
  return v instanceof Uint8Array;
}

const SPACE = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]);
const DELIM = new Set([0x28, 0x29, 0x3c, 0x3e, 0x5b, 0x5d, 0x7b, 0x7d, 0x2f, 0x25]);

function isRegular(b: number): boolean {
  return !SPACE.has(b) && !DELIM.has(b);
}

/** A cursor over the file's bytes. One instance per parse; not reentrant. */
export class Lexer {
  readonly bytes: Uint8Array;
  pos = 0;

  constructor(bytes: Uint8Array, pos = 0) {
    this.bytes = bytes;
    this.pos = pos;
  }

  private at(offset = 0): number {
    return this.bytes[this.pos + offset] ?? -1;
  }

  skipSpace(): void {
    for (;;) {
      while (SPACE.has(this.at())) this.pos++;
      // Comments run to end of line and are whitespace for our purposes.
      if (this.at() === 0x25) {
        while (this.pos < this.bytes.length && this.at() !== 0x0a && this.at() !== 0x0d) {
          this.pos++;
        }
        continue;
      }
      return;
    }
  }

  /** The next regular-character run, without consuming delimiters. */
  peekKeyword(): string {
    const save = this.pos;
    this.skipSpace();
    let end = this.pos;
    while (end < this.bytes.length && isRegular(this.bytes[end]!)) end++;
    const word = latin1(this.bytes.subarray(this.pos, end));
    this.pos = save;
    return word;
  }

  takeKeyword(): string {
    this.skipSpace();
    const start = this.pos;
    while (this.pos < this.bytes.length && isRegular(this.bytes[this.pos]!)) this.pos++;
    return latin1(this.bytes.subarray(start, this.pos));
  }

  parseValue(): PdfValue {
    this.skipSpace();
    const b = this.at();

    if (b === 0x2f) return this.parseName();
    if (b === 0x28) return this.parseLiteralString();
    if (b === 0x5b) return this.parseArray();
    if (b === 0x3c) {
      return this.at(1) === 0x3c ? this.parseDictOrStream() : this.parseHexString();
    }
    if (b === 0x5d || b === 0x3e) {
      // A stray closer: let the caller's loop see it.
      return null;
    }

    const word = this.peekKeyword();
    if (word === "true") { this.pos += 4; return true; }
    if (word === "false") { this.pos += 5; return false; }
    if (word === "null") { this.pos += 4; return null; }
    if (word === "") { this.pos++; return null; }

    return this.parseNumberOrRef();
  }

  private parseName(): PdfName {
    this.pos++; // '/'
    let out = "";
    while (this.pos < this.bytes.length && isRegular(this.bytes[this.pos]!)) {
      let c = this.bytes[this.pos]!;
      if (c === 0x23 && this.pos + 2 < this.bytes.length) {
        const h = parseInt(latin1(this.bytes.subarray(this.pos + 1, this.pos + 3)), 16);
        if (!Number.isNaN(h)) {
          c = h;
          this.pos += 2;
        }
      }
      out += String.fromCharCode(c);
      this.pos++;
    }
    return { name: out };
  }

  private parseNumberOrRef(): PdfValue {
    const first = this.takeKeyword();
    const value = Number(first);
    if (Number.isNaN(value)) return null;

    // `12 0 R` is a reference; `12 0` followed by anything else is two numbers,
    // and the second one belongs to whoever asked next.
    if (Number.isInteger(value) && value >= 0) {
      const save = this.pos;
      this.skipSpace();
      const genStart = this.pos;
      const gen = this.takeKeyword();
      if (/^\d+$/.test(gen)) {
        this.skipSpace();
        if (this.peekKeyword() === "R") {
          this.takeKeyword();
          return { num: value, gen: Number(gen) };
        }
      }
      this.pos = genStart === this.pos ? save : save;
    }
    return value;
  }

  private parseArray(): PdfValue[] {
    this.pos++; // '['
    const out: PdfValue[] = [];
    for (;;) {
      this.skipSpace();
      if (this.pos >= this.bytes.length) break;
      if (this.at() === 0x5d) { this.pos++; break; }
      const before = this.pos;
      out.push(this.parseValue());
      if (this.pos === before) { this.pos++; } // never spin
    }
    return out;
  }

  private parseDictOrStream(): PdfDict | PdfStream {
    this.pos += 2; // '<<'
    const dict: PdfDict = new Map();
    for (;;) {
      this.skipSpace();
      if (this.pos >= this.bytes.length) break;
      if (this.at() === 0x3e && this.at(1) === 0x3e) { this.pos += 2; break; }
      if (this.at() !== 0x2f) {
        // Junk where a key should be. Step over it rather than aborting the
        // whole document for one malformed entry.
        this.pos++;
        continue;
      }
      const key = this.parseName().name;
      dict.set(key, this.parseValue());
    }

    this.skipSpace();
    if (this.peekKeyword() === "stream") {
      this.takeKeyword();
      // The spec requires CRLF or LF after the keyword, never CR alone.
      if (this.at() === 0x0d) this.pos++;
      if (this.at() === 0x0a) this.pos++;

      const start = this.pos;
      const declared = dict.get("Length");
      let end = typeof declared === "number" ? start + declared : -1;

      // A wrong /Length is common enough that it must not be fatal: fall back
      // to searching for the terminator.
      if (end < start || end > this.bytes.length || !endsStreamAt(this.bytes, end)) {
        end = findEndstream(this.bytes, start);
      }

      this.pos = end;
      this.skipSpace();
      if (this.peekKeyword() === "endstream") this.takeKeyword();
      return { dict, raw: this.bytes.subarray(start, end) };
    }

    return dict;
  }

  private parseLiteralString(): Uint8Array {
    this.pos++; // '('
    const out: number[] = [];
    let depth = 1;
    while (this.pos < this.bytes.length) {
      const c = this.bytes[this.pos++]!;
      if (c === 0x5c) {
        const e = this.bytes[this.pos++]!;
        switch (e) {
          case 0x6e: out.push(0x0a); break;
          case 0x72: out.push(0x0d); break;
          case 0x74: out.push(0x09); break;
          case 0x62: out.push(0x08); break;
          case 0x66: out.push(0x0c); break;
          case 0x0a: break;
          case 0x0d: if (this.bytes[this.pos] === 0x0a) this.pos++; break;
          default:
            if (e >= 0x30 && e <= 0x37) {
              let oct = e - 0x30;
              for (let i = 0; i < 2; i++) {
                const n = this.bytes[this.pos];
                if (n === undefined || n < 0x30 || n > 0x37) break;
                oct = oct * 8 + (n - 0x30);
                this.pos++;
              }
              out.push(oct & 0xff);
            } else {
              out.push(e);
            }
        }
        continue;
      }
      if (c === 0x28) depth++;
      if (c === 0x29) { depth--; if (depth === 0) break; }
      out.push(c);
    }
    return new Uint8Array(out);
  }

  private parseHexString(): Uint8Array {
    this.pos++; // '<'
    let digits = "";
    while (this.pos < this.bytes.length && this.bytes[this.pos] !== 0x3e) {
      const c = String.fromCharCode(this.bytes[this.pos]!);
      if (/[0-9a-fA-F]/.test(c)) digits += c;
      this.pos++;
    }
    this.pos++; // '>'
    if (digits.length % 2 === 1) digits += "0";
    const out = new Uint8Array(digits.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(digits.slice(i * 2, i * 2 + 2), 16);
    return out;
  }
}

function endsStreamAt(bytes: Uint8Array, end: number): boolean {
  const window = latin1(bytes.subarray(end, end + 20));
  return /^\s*endstream/.test(window);
}

function findEndstream(bytes: Uint8Array, start: number): number {
  const needle = "endstream";
  for (let i = start; i < bytes.length - needle.length; i++) {
    if (bytes[i] !== 0x65) continue;
    if (latin1(bytes.subarray(i, i + needle.length)) !== needle) continue;
    // Trim the EOL that precedes the keyword; it is not stream data.
    let end = i;
    if (bytes[end - 1] === 0x0a) end--;
    if (bytes[end - 1] === 0x0d) end--;
    return end;
  }
  return bytes.length;
}

export function latin1(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += String.fromCharCode(b);
  return out;
}

// ---------------------------------------------------------------------------
// The document
// ---------------------------------------------------------------------------

export interface PdfDocument {
  objects: Map<number, PdfValue>;
  trailer: PdfDict;
  /** The raw bytes, kept because decryption needs the file's /ID. */
  bytes: Uint8Array;
}

/**
 * Read every `N G obj` in the file directly, ignoring the cross-reference
 * table. See the note at the top: broken xref offsets are the usual reason a
 * real statement will not open, and there is nothing here worth the risk.
 */
export function readDocument(bytes: Uint8Array): PdfDocument {
  const objects = new Map<number, PdfValue>();
  const text = latin1(bytes);

  const objRe = /(\d+)\s+(\d+)\s+obj\b/g;
  let m: RegExpExecArray | null;
  while ((m = objRe.exec(text)) !== null) {
    const num = Number(m[1]);
    const lexer = new Lexer(bytes, m.index + m[0].length);
    try {
      objects.set(num, lexer.parseValue());
    } catch {
      // One unreadable object must not cost the whole document.
    }
  }

  // Trailers accumulate: an incrementally updated file has several, and later
  // ones win. /Encrypt and /Root can live in either.
  const trailer: PdfDict = new Map();
  const trailerRe = /trailer\b/g;
  while ((m = trailerRe.exec(text)) !== null) {
    const parsed = new Lexer(bytes, m.index + m[0].length).parseValue();
    if (isDict(parsed)) for (const [k, v] of parsed) trailer.set(k, v);
  }

  // A cross-reference *stream* carries the same keys in its dictionary.
  for (const value of objects.values()) {
    if (!isStream(value)) continue;
    const type = value.dict.get("Type");
    if (isName(type) && type.name === "XRef") {
      for (const [k, v] of value.dict) if (!trailer.has(k)) trailer.set(k, v);
    }
  }

  return { objects, trailer, bytes };
}

/** Follow a reference, as many times as it takes. */
export function resolve(doc: PdfDocument, value: PdfValue): PdfValue {
  let seen = 0;
  while (isRef(value) && seen++ < 32) {
    value = doc.objects.get(value.num) ?? null;
  }
  return value;
}

export function dictGet(doc: PdfDocument, dict: PdfDict, key: string): PdfValue {
  return resolve(doc, dict.get(key) ?? null);
}

/**
 * Decode a stream's bytes. Only the filters a statement uses are supported;
 * anything else returns the raw bytes, which the text extractor will simply
 * find nothing in — better than throwing on a font file nobody asked for.
 */
export function decodeStream(doc: PdfDocument, stream: PdfStream, data?: Uint8Array): Uint8Array {
  let bytes = data ?? stream.raw;
  const filter = dictGet(doc, stream.dict, "Filter");
  const filters = Array.isArray(filter) ? filter : filter === null ? [] : [filter];

  for (const f of filters) {
    if (!isName(f)) continue;
    if (f.name === "FlateDecode" || f.name === "Fl") {
      try {
        bytes = new Uint8Array(inflateSync(Buffer.from(bytes)));
      } catch {
        return new Uint8Array(0);
      }
    } else if (f.name === "ASCIIHexDecode" || f.name === "AHx") {
      bytes = asciiHexDecode(bytes);
    } else if (f.name === "ASCII85Decode" || f.name === "A85") {
      bytes = ascii85Decode(bytes);
    } else {
      return bytes;
    }
  }

  const parms = dictGet(doc, stream.dict, "DecodeParms");
  const parmDict = isDict(parms) ? parms : Array.isArray(parms) ? parms.map((p) => resolve(doc, p)).find(isDict) : null;
  if (parmDict) {
    const predictor = dictGet(doc, parmDict, "Predictor");
    if (typeof predictor === "number" && predictor >= 10) {
      const columns = dictGet(doc, parmDict, "Columns");
      const colors = dictGet(doc, parmDict, "Colors");
      bytes = undoPngPredictor(
        bytes,
        typeof columns === "number" ? columns : 1,
        typeof colors === "number" ? colors : 1,
      );
    }
  }

  return bytes;
}

function asciiHexDecode(bytes: Uint8Array): Uint8Array {
  let digits = "";
  for (const b of bytes) {
    const c = String.fromCharCode(b);
    if (c === ">") break;
    if (/[0-9a-fA-F]/.test(c)) digits += c;
  }
  if (digits.length % 2 === 1) digits += "0";
  const out = new Uint8Array(digits.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(digits.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function ascii85Decode(bytes: Uint8Array): Uint8Array {
  const out: number[] = [];
  let group: number[] = [];

  for (let i = 0; i < bytes.length; i++) {
    const c = bytes[i]!;
    if (c === 0x7e) break; // '~' begins the EOD marker
    if (SPACE.has(c)) continue;

    // 'z' is shorthand for four zero bytes, valid only between groups.
    if (c === 0x7a && group.length === 0) {
      out.push(0, 0, 0, 0);
      continue;
    }
    if (c < 0x21 || c > 0x75) continue;

    group.push(c - 0x21);
    if (group.length === 5) {
      let value = 0;
      for (const d of group) value = value * 85 + d;
      out.push((value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff);
      group = [];
    }
  }

  // A short final group is padded with 'u', and yields one byte fewer than
  // its length.
  if (group.length > 1) {
    const n = group.length;
    while (group.length < 5) group.push(84);
    let value = 0;
    for (const d of group) value = value * 85 + d;
    const full = [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
    out.push(...full.slice(0, n - 1));
  }

  return new Uint8Array(out);
}

/** PNG predictors, needed for cross-reference streams. */
function undoPngPredictor(bytes: Uint8Array, columns: number, colors: number): Uint8Array {
  const bpp = Math.max(1, colors);
  const rowLength = columns * bpp;
  const rows = Math.floor(bytes.length / (rowLength + 1));
  const out = new Uint8Array(rows * rowLength);
  let prev = new Uint8Array(rowLength);

  for (let r = 0; r < rows; r++) {
    const tag = bytes[r * (rowLength + 1)]!;
    const row = bytes.subarray(r * (rowLength + 1) + 1, (r + 1) * (rowLength + 1));
    const cur = new Uint8Array(rowLength);

    for (let i = 0; i < rowLength; i++) {
      const raw = row[i] ?? 0;
      const left = i >= bpp ? cur[i - bpp]! : 0;
      const up = prev[i]!;
      const upLeft = i >= bpp ? prev[i - bpp]! : 0;
      switch (tag) {
        case 0: cur[i] = raw; break;
        case 1: cur[i] = (raw + left) & 0xff; break;
        case 2: cur[i] = (raw + up) & 0xff; break;
        case 3: cur[i] = (raw + ((left + up) >> 1)) & 0xff; break;
        case 4: {
          const p = left + up - upLeft;
          const pa = Math.abs(p - left), pb = Math.abs(p - up), pc = Math.abs(p - upLeft);
          cur[i] = (raw + (pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft)) & 0xff;
          break;
        }
        default: cur[i] = raw;
      }
    }
    out.set(cur, r * rowLength);
    prev = cur;
  }
  return out;
}

/**
 * Expand `/Type /ObjStm` containers into the object map.
 *
 * Called after decryption, because in an encrypted document the container's
 * bytes are encrypted but the objects inside it are not — they inherit the
 * container's protection and must not be decrypted a second time.
 */
export function expandObjectStreams(doc: PdfDocument): void {
  for (const [, value] of [...doc.objects]) {
    if (!isStream(value)) continue;
    const type = value.dict.get("Type");
    if (!isName(type) || type.name !== "ObjStm") continue;

    const data = decodeStream(doc, value);
    const n = dictGet(doc, value.dict, "N");
    const first = dictGet(doc, value.dict, "First");
    if (typeof n !== "number" || typeof first !== "number") continue;

    const header = latin1(data.subarray(0, first)).trim().split(/\s+/).map(Number);
    for (let i = 0; i < n; i++) {
      const num = header[i * 2];
      const offset = header[i * 2 + 1];
      if (num === undefined || offset === undefined) break;
      // A directly stored object wins: it is the newer revision.
      if (doc.objects.has(num)) continue;
      try {
        doc.objects.set(num, new Lexer(data, first + offset).parseValue());
      } catch {
        /* skip */
      }
    }
  }
}
