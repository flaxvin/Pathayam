/**
 * `04` §3.4 · A thin Gmail API client — only the three calls ingestion needs.
 *
 * `fetch` is injected everywhere, so the whole path is testable against
 * recorded API shapes without a live Google connection, the same way the price
 * providers are.
 */

const API = "https://gmail.googleapis.com/gmail/v1/users/me";

export class GmailApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "GmailApiError";
    this.status = status;
  }
}

export interface GmailHeader { name: string; value: string }

export interface GmailPart {
  mimeType?: string;
  filename?: string;
  headers?: GmailHeader[];
  body?: { data?: string; attachmentId?: string; size?: number };
  parts?: GmailPart[];
}

export interface GmailMessage {
  id: string;
  threadId?: string;
  internalDate?: string;
  payload?: GmailPart;
}

export interface GmailClientOptions {
  accessToken: string;
  fetchImpl?: typeof fetch;
}

async function get(path: string, opts: GmailClientOptions): Promise<unknown> {
  const doFetch = opts.fetchImpl ?? fetch;
  const response = await doFetch(`${API}${path}`, {
    headers: { Authorization: `Bearer ${opts.accessToken}` },
  });
  if (!response.ok) {
    throw new GmailApiError(`Gmail API returned ${response.status}.`, response.status);
  }
  return response.json();
}

/**
 * List message ids matching a Gmail search query.
 *
 * The query is where `04` §3.4's "only messages matching configured bank
 * senders are ever read" is enforced — the caller passes a `from:(…)` filter,
 * and nothing outside it is ever requested.
 */
export async function listMessageIds(
  query: string, opts: GmailClientOptions, maxResults = 100,
): Promise<string[]> {
  const ids: string[] = [];
  let pageToken: string | undefined;

  do {
    const params = new URLSearchParams({ q: query, maxResults: String(Math.min(maxResults, 500)) });
    if (pageToken) params.set("pageToken", pageToken);

    const body = (await get(`/messages?${params}`, opts)) as {
      messages?: { id: string }[]; nextPageToken?: string;
    };
    for (const m of body.messages ?? []) ids.push(m.id);
    pageToken = body.nextPageToken;
  } while (pageToken && ids.length < maxResults);

  return ids.slice(0, maxResults);
}

export async function getMessage(id: string, opts: GmailClientOptions): Promise<GmailMessage> {
  return (await get(`/messages/${id}?format=full`, opts)) as GmailMessage;
}

export async function getAttachment(
  messageId: string, attachmentId: string, opts: GmailClientOptions,
): Promise<Uint8Array> {
  const body = (await get(
    `/messages/${messageId}/attachments/${attachmentId}`, opts,
  )) as { data?: string };
  return body.data ? new Uint8Array(Buffer.from(body.data, "base64url")) : new Uint8Array(0);
}

// ---------------------------------------------------------------------------
// Reading a message
// ---------------------------------------------------------------------------

export function header(message: GmailMessage, name: string): string | null {
  const headers = message.payload?.headers ?? [];
  const found = headers.find((h) => h.name.toLowerCase() === name.toLowerCase());
  return found?.value ?? null;
}

/** The plain-text body, gathered from whichever MIME part carries it. */
export function plainTextBody(message: GmailMessage): string {
  const chunks: string[] = [];

  const walk = (part: GmailPart | undefined): void => {
    if (!part) return;
    if (part.mimeType === "text/plain" && part.body?.data) {
      chunks.push(Buffer.from(part.body.data, "base64url").toString("utf8"));
    } else if (part.mimeType === "text/html" && part.body?.data && chunks.length === 0) {
      // Fallback: strip tags from HTML when there is no plain part.
      const html = Buffer.from(part.body.data, "base64url").toString("utf8");
      chunks.push(html.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " "));
    }
    for (const child of part.parts ?? []) walk(child);
  };

  walk(message.payload);
  return chunks.join("\n").replace(/\r\n/g, "\n");
}

export interface PdfAttachment { filename: string; attachmentId: string }

/** Every PDF attachment on a message, for statement fetching. */
export function pdfAttachments(message: GmailMessage): PdfAttachment[] {
  const out: PdfAttachment[] = [];
  const walk = (part: GmailPart | undefined): void => {
    if (!part) return;
    const isPdf =
      part.mimeType === "application/pdf" ||
      (part.filename ?? "").toLowerCase().endsWith(".pdf");
    if (isPdf && part.body?.attachmentId && part.filename) {
      out.push({ filename: part.filename, attachmentId: part.body.attachmentId });
    }
    for (const child of part.parts ?? []) walk(child);
  };
  walk(message.payload);
  return out;
}
