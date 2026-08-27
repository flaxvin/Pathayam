/**
 * Text extraction.
 *
 * A CAS is a table, and a table only survives extraction if the *layout*
 * survives it. Concatenating every string in reading order gives
 * "HDFC Liquid Fund936.043 82.5077254.55" — unparseable. So text is collected
 * with its position from the text matrix, grouped into lines by Y, ordered by
 * X, and separated by a gap wide enough to be a column boundary.
 *
 * Only what a registrar's generator actually emits is handled: simple fonts
 * with a /Differences encoding or a standard one, and Identity-H CID fonts
 * with a /ToUnicode map, which is what produces the ₹ sign.
 */

import {
  Lexer, latin1, decodeStream, dictGet, resolve,
  isDict, isName, isStream, isBytes,
  type PdfDocument, type PdfDict, type PdfValue,
} from "./objects.ts";

interface Piece {
  x: number;
  y: number;
  text: string;
  /** Width in text space, so a column gap can be told from a kerning gap. */
  width: number;
}

type Encoding = {
  /** Byte or CID → string. Absent entries fall back to Latin-1. */
  map: Map<number, string>;
  twoByte: boolean;
};

/** Every page's text, in document order, one entry per page. */
export function extractPages(doc: PdfDocument): string[] {
  const pages: string[] = [];
  for (const page of findPages(doc)) {
    const resources = dictGet(doc, page, "Resources");
    const fonts = isDict(resources) ? dictGet(doc, resources, "Font") : null;
    const content = contentBytes(doc, page);
    if (content.length === 0) continue;
    pages.push(layout(extractPieces(doc, content, isDict(fonts) ? fonts : new Map())));
  }
  return pages;
}

export function extractText(doc: PdfDocument): string {
  return extractPages(doc).join("\n\n");
}

function findPages(doc: PdfDocument): PdfDict[] {
  const out: PdfDict[] = [];

  const root = dictGet(doc, doc.trailer, "Root");
  const pagesNode = isDict(root) ? dictGet(doc, root, "Pages") : null;

  const walk = (node: PdfValue, depth: number, inherited: PdfDict): void => {
    if (depth > 64 || !isDict(node)) return;

    // /Resources and /MediaBox are inheritable; carry them down.
    const carried: PdfDict = new Map(inherited);
    for (const key of ["Resources", "MediaBox", "CropBox"]) {
      const v = node.get(key);
      if (v !== undefined) carried.set(key, v);
    }

    const type = dictGet(doc, node, "Type");
    if (isName(type) && type.name === "Page") {
      const merged: PdfDict = new Map(carried);
      for (const [k, v] of node) merged.set(k, v);
      out.push(merged);
      return;
    }

    const kids = dictGet(doc, node, "Kids");
    if (Array.isArray(kids)) {
      for (const kid of kids) walk(resolve(doc, kid), depth + 1, carried);
    }
  };

  walk(pagesNode, 0, new Map());

  // A file whose page tree is unreachable — a broken /Root, most often — still
  // has its pages in the object map. Better a readable statement than a
  // correct refusal.
  if (out.length === 0) {
    for (const value of doc.objects.values()) {
      if (!isDict(value)) continue;
      const type = value.get("Type");
      if (isName(type) && type.name === "Page") out.push(value);
    }
  }
  return out;
}

function contentBytes(doc: PdfDocument, page: PdfDict): Uint8Array {
  const contents = dictGet(doc, page, "Contents");
  const streams = Array.isArray(contents) ? contents.map((c) => resolve(doc, c)) : [contents];

  const parts: Uint8Array[] = [];
  for (const s of streams) {
    if (isStream(s)) parts.push(decodeStream(doc, s), new Uint8Array([0x0a]));
  }

  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

// ---------------------------------------------------------------------------
// Fonts
// ---------------------------------------------------------------------------

function encodingFor(doc: PdfDocument, font: PdfValue): Encoding {
  const map = new Map<number, string>();
  if (!isDict(font)) return { map, twoByte: false };

  const subtype = dictGet(doc, font, "Subtype");
  const composite = isName(subtype) && subtype.name === "Type0";

  const toUnicode = dictGet(doc, font, "ToUnicode");
  if (isStream(toUnicode)) {
    parseCMap(latin1(decodeStream(doc, toUnicode)), map);
  }

  // A simple font's /Differences array names glyphs; the useful ones are the
  // /uniXXXX and /gNN forms plus the standard Latin names.
  const encoding = dictGet(doc, font, "Encoding");
  if (isDict(encoding)) {
    const differences = dictGet(doc, encoding, "Differences");
    if (Array.isArray(differences)) {
      let code = 0;
      for (const entry of differences) {
        const value = resolve(doc, entry);
        if (typeof value === "number") { code = value; continue; }
        if (isName(value)) {
          const glyph = glyphToChar(value.name);
          if (glyph && !map.has(code)) map.set(code, glyph);
          code++;
        }
      }
    }
  }

  return { map, twoByte: composite };
}

function glyphToChar(name: string): string | null {
  const uni = /^uni([0-9A-Fa-f]{4})$/.exec(name);
  if (uni) return String.fromCharCode(parseInt(uni[1]!, 16));
  const named: Record<string, string> = {
    space: " ", period: ".", comma: ",", hyphen: "-", slash: "/",
    parenleft: "(", parenright: ")", colon: ":", percent: "%", asterisk: "*",
    rupee: "₹", bullet: "·", endash: "–", emdash: "—",
  };
  return named[name] ?? null;
}

/** The `beginbfchar` / `beginbfrange` sections of a /ToUnicode CMap. */
function parseCMap(text: string, into: Map<number, string>): void {
  const hexToString = (hex: string): string => {
    let out = "";
    for (let i = 0; i + 3 < hex.length + 1; i += 4) {
      const code = parseInt(hex.slice(i, i + 4), 16);
      if (!Number.isNaN(code)) out += String.fromCharCode(code);
    }
    return out;
  };

  for (const block of text.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const pair of block[1]!.matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
      into.set(parseInt(pair[1]!, 16), hexToString(pair[2]!));
    }
  }

  for (const block of text.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    const body = block[1]!;
    for (const r of body.matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
      const from = parseInt(r[1]!, 16);
      const to = parseInt(r[2]!, 16);
      const start = parseInt(r[3]!, 16);
      for (let c = from; c <= to && c - from < 65536; c++) {
        into.set(c, String.fromCharCode(start + (c - from)));
      }
    }
    for (const r of body.matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*\[([\s\S]*?)\]/g)) {
      const from = parseInt(r[1]!, 16);
      let i = 0;
      for (const item of r[3]!.matchAll(/<([0-9A-Fa-f]+)>/g)) {
        into.set(from + i++, hexToString(item[1]!));
      }
    }
  }
}

function decode(raw: Uint8Array, encoding: Encoding): string {
  let out = "";
  if (encoding.twoByte) {
    for (let i = 0; i + 1 < raw.length; i += 2) {
      const code = (raw[i]! << 8) | raw[i + 1]!;
      out += encoding.map.get(code) ?? "";
    }
    return out;
  }
  for (const b of raw) {
    out += encoding.map.get(b) ?? String.fromCharCode(b);
  }
  return out;
}

// ---------------------------------------------------------------------------
// The content stream
// ---------------------------------------------------------------------------

function extractPieces(doc: PdfDocument, content: Uint8Array, fonts: PdfDict): Piece[] {
  const pieces: Piece[] = [];
  const lexer = new Lexer(content);
  const stack: PdfValue[] = [];

  // Text state. Only what affects position is tracked.
  let tm = [1, 0, 0, 1, 0, 0];
  let tlm = [1, 0, 0, 1, 0, 0];
  let leading = 0;
  let fontSize = 1;
  let charSpacing = 0;
  let wordSpacing = 0;
  let horizontalScale = 1;
  let encoding: Encoding = { map: new Map(), twoByte: false };

  const multiply = (a: number[], b: number[]): number[] => [
    a[0]! * b[0]! + a[1]! * b[2]!,
    a[0]! * b[1]! + a[1]! * b[3]!,
    a[2]! * b[0]! + a[3]! * b[2]!,
    a[2]! * b[1]! + a[3]! * b[3]!,
    a[4]! * b[0]! + a[5]! * b[2]! + b[4]!,
    a[4]! * b[1]! + a[5]! * b[3]! + b[5]!,
  ];

  const show = (raw: Uint8Array): void => {
    const text = decode(raw, encoding);
    if (text === "") return;

    // No font metrics are read, so glyph advance is approximated. It only has
    // to be good enough to tell a column gap from a letter gap.
    const advance =
      (text.length * fontSize * 0.5 + text.length * charSpacing +
        (text.split(" ").length - 1) * wordSpacing) * horizontalScale;

    pieces.push({ x: tm[4]!, y: tm[5]!, text, width: advance });
    tm = multiply([1, 0, 0, 1, advance, 0], tm);
  };

  const num = (v: PdfValue | undefined): number => (typeof v === "number" ? v : 0);

  for (;;) {
    lexer.skipSpace();
    if (lexer.pos >= content.length) break;

    const b = content[lexer.pos]!;
    const isOperand = b === 0x2f || b === 0x28 || b === 0x5b || b === 0x3c ||
      (b >= 0x30 && b <= 0x39) || b === 0x2b || b === 0x2d || b === 0x2e;

    if (isOperand) {
      const before = lexer.pos;
      stack.push(lexer.parseValue());
      if (lexer.pos === before) lexer.pos++;
      continue;
    }

    const op = lexer.takeKeyword();
    if (op === "") { lexer.pos++; continue; }

    switch (op) {
      case "BT":
        tm = [1, 0, 0, 1, 0, 0];
        tlm = tm;
        break;
      case "Tf": {
        fontSize = num(stack[stack.length - 1]);
        const name = stack[stack.length - 2];
        if (isName(name)) encoding = encodingFor(doc, dictGet(doc, fonts, name.name));
        break;
      }
      case "Td": {
        tlm = multiply([1, 0, 0, 1, num(stack[stack.length - 2]), num(stack[stack.length - 1])], tlm);
        tm = tlm;
        break;
      }
      case "TD": {
        leading = -num(stack[stack.length - 1]);
        tlm = multiply([1, 0, 0, 1, num(stack[stack.length - 2]), num(stack[stack.length - 1])], tlm);
        tm = tlm;
        break;
      }
      case "Tm": {
        tlm = [
          num(stack[stack.length - 6]), num(stack[stack.length - 5]),
          num(stack[stack.length - 4]), num(stack[stack.length - 3]),
          num(stack[stack.length - 2]), num(stack[stack.length - 1]),
        ];
        tm = tlm;
        break;
      }
      case "T*":
        tlm = multiply([1, 0, 0, 1, 0, -leading], tlm);
        tm = tlm;
        break;
      case "TL": leading = num(stack[stack.length - 1]); break;
      case "Tc": charSpacing = num(stack[stack.length - 1]); break;
      case "Tw": wordSpacing = num(stack[stack.length - 1]); break;
      case "Tz": horizontalScale = num(stack[stack.length - 1]) / 100; break;
      case "Tj":
      case "'":
      case '"': {
        if (op !== "Tj") {
          tlm = multiply([1, 0, 0, 1, 0, -leading], tlm);
          tm = tlm;
        }
        const s = stack[stack.length - 1];
        if (isBytes(s)) show(s);
        break;
      }
      case "TJ": {
        const array = stack[stack.length - 1];
        if (Array.isArray(array)) {
          for (const item of array) {
            if (isBytes(item)) show(item);
            else if (typeof item === "number") {
              // A large negative adjustment is how generators draw a space.
              const shift = (-item / 1000) * fontSize * horizontalScale;
              tm = multiply([1, 0, 0, 1, shift, 0], tm);
            }
          }
        }
        break;
      }
      default:
        break;
    }
    stack.length = 0;
  }

  return pieces;
}

/**
 * Rebuild lines from positioned pieces.
 *
 * Pieces within 2 units vertically are the same line — generators nudge
 * baselines by fractions of a point constantly.
 *
 * Horizontally, each piece is placed at the **column its x-position implies**,
 * padded with spaces, rather than separated by a fixed gap. That costs a little
 * arithmetic and buys the one thing a fixed separator cannot: a table whose
 * columns still line up vertically. A statement row where the deposit column
 * is empty is indistinguishable from one where the withdrawal column is empty
 * unless the surviving figure is still sitting under its own heading — see
 * `readHeader` in `import/pdf-statements.ts`, which is what reads them.
 */
function layout(pieces: Piece[]): string {
  if (pieces.length === 0) return "";

  // How wide one character is, in text-space units. Taken from the pieces
  // themselves rather than assumed, because font size varies down the page and
  // a fixed guess would drift columns apart by the bottom of a statement.
  const widths = pieces
    .filter((p) => p.text.length > 0 && p.width > 0)
    .map((p) => p.width / p.text.length)
    .sort((a, b) => a - b);
  const charWidth = widths.length > 0 ? widths[Math.floor(widths.length / 2)]! : 5;

  const left = Math.min(...pieces.map((p) => p.x));

  const lines: Piece[][] = [];
  for (const piece of [...pieces].sort((a, b) => b.y - a.y || a.x - b.x)) {
    const line = lines[lines.length - 1];
    if (line && Math.abs(line[0]!.y - piece.y) <= 2) line.push(piece);
    else lines.push([piece]);
  }

  return lines
    .map((line) => {
      line.sort((a, b) => a.x - b.x);
      let out = "";
      for (const piece of line) {
        const column = Math.max(0, Math.round((piece.x - left) / charWidth));
        // Never let padding swallow a piece: two adjacent words keep one space
        // between them even if their computed columns collide.
        if (column > out.length) out += " ".repeat(column - out.length);
        else if (out.length > 0 && !out.endsWith(" ")) out += " ";
        out += piece.text;
      }
      return out.replace(/[ \t]+$/, "");
    })
    .filter((l) => l.trim() !== "")
    .join("\n");
}
