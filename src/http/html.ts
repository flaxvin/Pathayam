/**
 * HTML rendering.
 *
 * A tagged template that escapes interpolated values by default. Every value
 * that reaches a page goes through `escape` unless it is explicitly wrapped in
 * `raw`, which makes an XSS hole something you have to type on purpose.
 *
 * There is no client framework: `08` S3 adopts server-rendered first paint as
 * the default approach, and R39.3 requires the theme in the first response so
 * the wrong one never paints.
 */

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function escape(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value).replace(/[&<>"']/g, (ch) => ESCAPES[ch]!);
}

/** Marks a string as already-safe HTML. */
export class SafeHtml {
  readonly value: string;
  constructor(value: string) {
    this.value = value;
  }
  toString(): string {
    return this.value;
  }
}

export function raw(value: string): SafeHtml {
  return new SafeHtml(value);
}

function render(value: unknown): string {
  if (value === null || value === undefined || value === false) return "";
  if (value instanceof SafeHtml) return value.value;
  if (Array.isArray(value)) return value.map(render).join("");
  return escape(value);
}

export function html(strings: TemplateStringsArray, ...values: unknown[]): SafeHtml {
  let out = strings[0] ?? "";
  for (let i = 0; i < values.length; i++) {
    out += render(values[i]) + (strings[i + 1] ?? "");
  }
  return new SafeHtml(out);
}

/** Conditionally render, without an empty string leaking into the output. */
export function when(condition: unknown, content: () => SafeHtml | string): SafeHtml {
  return condition ? raw(String(content())) : raw("");
}

/** Build a class attribute from conditional parts. */
export function classes(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(" ");
}

/** Serialise a value for a JSON script block, safe against `</script>`. */
export function jsonScript(value: unknown): SafeHtml {
  return raw(JSON.stringify(value).replace(/</g, "\\u003c"));
}
