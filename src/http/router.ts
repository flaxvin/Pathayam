/**
 * A small router over `node:http`.
 *
 * Patterns use `:name` segments; a match populates `ctx.params`. Deliberately
 * tiny — the app has a few dozen routes and no need for a framework, and
 * R35.4's CSP is easier to keep honest when nothing is pulled in.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { SafeHtml } from "./html.ts";

export interface RequestContext {
  req: IncomingMessage;
  res: ServerResponse;
  method: string;
  url: URL;
  params: Record<string, string>;
  query: URLSearchParams;
  /** Parsed form or JSON body, for mutating requests. */
  body: Record<string, string | string[]>;
  /** Populated by the auth middleware. */
  session?: unknown;
  locals: Record<string, unknown>;
}

export type Handler = (ctx: RequestContext) => Promise<Response | void> | Response | void;

export interface Response {
  status?: number;
  headers?: Record<string, string>;
  body?: string | SafeHtml | Buffer;
  redirect?: string;
  json?: unknown;
}

interface Route {
  method: string;
  segments: string[];
  handler: Handler;
}

export class Router {
  private routes: Route[] = [];

  get(pattern: string, handler: Handler): this {
    return this.add("GET", pattern, handler);
  }
  post(pattern: string, handler: Handler): this {
    return this.add("POST", pattern, handler);
  }

  add(method: string, pattern: string, handler: Handler): this {
    this.routes.push({ method, segments: split(pattern), handler });
    return this;
  }

  match(method: string, pathname: string): { handler: Handler; params: Record<string, string> } | null {
    const parts = split(pathname);
    for (const route of this.routes) {
      if (route.method !== method) continue;
      const params = matchSegments(route.segments, parts);
      if (params) return { handler: route.handler, params };
    }
    return null;
  }

  /** Whether any route exists at this path, to tell 404 from 405. */
  hasPath(pathname: string): boolean {
    const parts = split(pathname);
    return this.routes.some((r) => matchSegments(r.segments, parts) !== null);
  }
}

function split(pattern: string): string[] {
  return pattern.split("/").filter((s) => s.length > 0);
}

function matchSegments(pattern: string[], actual: string[]): Record<string, string> | null {
  if (pattern.length !== actual.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < pattern.length; i++) {
    const p = pattern[i]!;
    if (p.startsWith(":")) {
      params[p.slice(1)] = decodeURIComponent(actual[i]!);
    } else if (p !== actual[i]) {
      return null;
    }
  }
  return params;
}

/** Cap on a request body. Nothing this app accepts is legitimately larger. */
const MAX_BODY_BYTES = 5 * 1024 * 1024;

export async function readBody(req: IncomingMessage): Promise<Record<string, string | string[]>> {
  const contentType = req.headers["content-type"] ?? "";
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new PayloadTooLarge();
    chunks.push(chunk as Buffer);
  }

  const text = Buffer.concat(chunks).toString("utf8");
  if (text === "") return {};

  if (contentType.includes("application/json")) {
    try {
      const parsed = JSON.parse(text) as unknown;
      return typeof parsed === "object" && parsed !== null
        ? (parsed as Record<string, string | string[]>)
        : {};
    } catch {
      throw new BadRequest("That request body was not valid JSON.");
    }
  }

  const params = new URLSearchParams(text);
  const out: Record<string, string | string[]> = {};
  for (const key of new Set(params.keys())) {
    const values = params.getAll(key);
    out[key] = values.length > 1 ? values : values[0]!;
  }
  return out;
}

export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = "HttpError";
  }
}

export class BadRequest extends HttpError {
  constructor(message = "That request could not be understood.") {
    super(400, message);
  }
}

export class PayloadTooLarge extends HttpError {
  constructor() {
    super(413, "That upload is too large.");
  }
}

export class NotFound extends HttpError {
  constructor(message = "That page does not exist.") {
    super(404, message);
  }
}

export class Forbidden extends HttpError {
  constructor(message = "You do not have access to this.") {
    super(403, message);
  }
}

/** Read a single string field from a parsed body. */
export function field(body: Record<string, string | string[]>, name: string): string | undefined {
  const value = body[name];
  if (Array.isArray(value)) return value[0];
  return value;
}

export function requiredField(body: Record<string, string | string[]>, name: string): string {
  const value = field(body, name);
  if (value === undefined || value === "") {
    throw new BadRequest(`"${name}" is required.`);
  }
  return value;
}

export function fieldList(body: Record<string, string | string[]>, name: string): string[] {
  const value = body[name];
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}
