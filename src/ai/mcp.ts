/**
 * AI-1 · A Model Context Protocol server, by hand.
 *
 * The household asked for Claude, ChatGPT and the rest to be able to read the
 * budget and answer questions about it. MCP is the one interface they all
 * speak, so the app answers it at `POST /mcp` — the same process, the same
 * database, the same privacy rules as every page, because each tool calls the
 * same read-only queries a page does (see analysis.ts).
 *
 * Written by hand rather than with the SDK because the app has no runtime
 * dependencies (README) and this is only JSON-RPC over one POST route.
 *
 * Two eras of the protocol are served on the one endpoint, because the
 * clients in the household's hands are not all on the same revision:
 *
 *   · **Modern** (2026-07-28): no handshake. Every request carries its
 *     protocol version in `params._meta`, mirrored into `MCP-Protocol-Version`,
 *     `Mcp-Method` and `Mcp-Name` headers that must agree with the body.
 *     `server/discover` says what the server is.
 *   · **Legacy** (2024-11-05 to 2025-11-25): an `initialize` handshake picks
 *     the version. This server keeps no session for it — the spec lets a
 *     server not issue `Mcp-Session-Id` — so every request stands alone, as
 *     it does in the modern era. Nothing about a conversation is remembered
 *     between POSTs, which is the right default for somebody's finances.
 *
 * The read tools receive the database and a viewer, and call queries. AIW
 * added tools that change things (src/ai/writes.ts); they are listed only for
 * a connection allowed to make changes on a deployment that allows them, and
 * their annotations say they are not read-only. This file treats both alike.
 *
 * Spec read 07-11-2026: modelcontextprotocol.io/specification/2026-07-28
 * (basic/transports/streamable-http, basic/versioning, server/discover,
 * server/tools).
 */

import { Refusal } from "../core/refusal.ts";

export const MODERN_VERSIONS = ["2026-07-28"] as const;
export const LEGACY_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"] as const;
const SUPPORTED_VERSIONS: readonly string[] = [...MODERN_VERSIONS, ...LEGACY_VERSIONS];
/**
 * A legacy client older than 2025-06-18 sends no version header; the spec lets
 * the server take that as 2025-03-26 (streamable-http, Protocol Version Header).
 */
const HEADERLESS_LEGACY_VERSION = "2025-03-26";

const META_VERSION = "io.modelcontextprotocol/protocolVersion";
const META_SERVER_INFO = "io.modelcontextprotocol/serverInfo";

/** JSON-RPC and MCP error codes this server answers with. */
export const ErrorCode = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
  HeaderMismatch: -32020,
  UnsupportedProtocolVersion: -32022,
} as const;

/** A JSON Schema subset: what the tools' arguments actually need. */
export interface JsonSchema {
  type?: "object" | "string" | "integer" | "number" | "boolean" | "array";
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean;
  enum?: readonly (string | number)[];
  minimum?: number;
  maximum?: number;
  pattern?: string;
  items?: JsonSchema;
  maxLength?: number;
}

export interface McpTool {
  name: string;
  title: string;
  /** Written for the model: what the tool answers, in what units, and its limits. */
  description: string;
  inputSchema: JsonSchema & { type: "object" };
  /**
   * AIW · Omitted for a read: read-only, idempotent, closed-world. A write
   * tool says it is not read-only (and never destructive: nothing deletes).
   */
  annotations?: { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean };
  /** Returns JSON-serialisable data. Throw a Refusal for an answer the model should read. */
  run(args: Record<string, unknown>): unknown;
}

export interface McpServerInfo {
  name: string;
  version: string;
  title?: string;
  instructions: string;
}

export interface McpRequest {
  /** Header names lower-cased, as node:http gives them. */
  headers: Record<string, string | string[] | undefined>;
  /** The raw body text; parsed here so a parse error is a JSON-RPC answer. */
  rawBody: string;
}

export interface McpReply {
  status: number;
  /** Absent for 202 and 405. */
  json?: unknown;
  headers?: Record<string, string>;
}

export interface McpOptions {
  server: McpServerInfo;
  tools: readonly McpTool[];
  /**
   * Applied to every tool's result before it leaves — the redaction a
   * connection asked for (redact.ts). Identity when not given.
   */
  transformResult?: (value: unknown) => unknown;
  /** Called once per tool call, for the access log. Never given the result. */
  onToolCall?: (call: { tool: string; args: Record<string, unknown>; ok: boolean; bytes: number; ms: number }) => void;
}

/**
 * A tool's answer is cut at this size, with a note saying so. An AI client
 * puts the whole thing in the model's context; a transaction list that is
 * the size of a novel is no use to anyone, and every tool that can return
 * many rows pages instead.
 */
export const MAX_RESULT_BYTES = 256 * 1024;

type Id = string | number | null;

interface RpcMessage {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

function rpcError(id: Id, code: number, message: string, data?: unknown): Record<string, unknown> {
  const error: Record<string, unknown> = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: "2.0", id, error };
}

function rpcResult(id: Id, result: unknown): Record<string, unknown> {
  return { jsonrpc: "2.0", id, result };
}

function header(req: McpRequest, name: string): string | undefined {
  const v = req.headers[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
}

/**
 * `Mcp-Name` may arrive as `=?base64?…?=` when the value is not plain ASCII.
 * Decoded before comparing with the body, as the spec requires.
 */
export function decodeHeaderValue(value: string): string {
  const m = /^=\?base64\?([A-Za-z0-9+/=]*)\?=$/.exec(value);
  return m ? Buffer.from(m[1]!, "base64").toString("utf8") : value;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * The one entry point. Pure apart from the tools it runs: no I/O, so the
 * route in app.ts is a few lines and every protocol rule is testable here.
 */
export function handleMcp(req: McpRequest, opts: McpOptions): McpReply {
  let msg: unknown;
  try {
    msg = JSON.parse(req.rawBody);
  } catch {
    return { status: 400, json: rpcError(null, ErrorCode.ParseError, "The body is not JSON.") };
  }
  // Batches existed only in 2025-03-26 and were removed after it; no client
  // in use sends them, and refusing keeps every POST one message.
  if (!isObject(msg)) {
    return { status: 400, json: rpcError(null, ErrorCode.InvalidRequest, "Send one JSON-RPC message per request; batches are not supported.") };
  }
  const m = msg as RpcMessage;
  const isNotification = !("id" in m);
  const id: Id = typeof m.id === "string" || typeof m.id === "number" ? m.id : null;

  if (m.jsonrpc !== "2.0" || typeof m.method !== "string") {
    // A JSON-RPC *response* posted by a client has no method. Neither era
    // lets the client send one, and this server never asks for one.
    return { status: 400, json: rpcError(id, ErrorCode.InvalidRequest, "Not a JSON-RPC 2.0 request.") };
  }
  if (!isNotification && id === null) {
    return { status: 400, json: rpcError(null, ErrorCode.InvalidRequest, "A request id must be a string or a number.") };
  }
  const method = m.method;
  const params = isObject(m.params) ? m.params : {};
  const meta = isObject(params._meta) ? params._meta : {};
  const bodyVersion = typeof meta[META_VERSION] === "string" ? (meta[META_VERSION] as string) : undefined;
  const headerVersion = header(req, "mcp-protocol-version");

  if (isNotification) {
    // notifications/initialized and notifications/cancelled are all a client
    // sends; neither needs anything from a server with no sessions.
    return { status: 202 };
  }

  // ---- Modern era: the body carries the version -------------------------
  if (bodyVersion !== undefined || (headerVersion !== undefined && (MODERN_VERSIONS as readonly string[]).includes(headerVersion))) {
    const mismatch = checkModernHeaders(req, method, params, bodyVersion, headerVersion);
    if (mismatch) return { status: 400, json: rpcError(id, ErrorCode.HeaderMismatch, mismatch) };
    if (!(MODERN_VERSIONS as readonly string[]).includes(bodyVersion!)) {
      // A legacy version named in modern-style _meta is not a thing either
      // era defines; say what is supported so the client can pick.
      return {
        status: 400,
        json: rpcError(id, ErrorCode.UnsupportedProtocolVersion, "Unsupported protocol version", {
          supported: SUPPORTED_VERSIONS, requested: bodyVersion,
        }),
      };
    }
    return dispatch(id, method, params, "modern", opts);
  }

  // ---- Legacy era ---------------------------------------------------------
  if (method === "initialize") {
    const requested = typeof params.protocolVersion === "string" ? params.protocolVersion : undefined;
    // Version negotiation, legacy style: the client's if we have it, else our
    // newest legacy one and the client decides whether it can live with it.
    const chosen = requested && (LEGACY_VERSIONS as readonly string[]).includes(requested)
      ? requested : LEGACY_VERSIONS[0];
    return {
      status: 200,
      json: rpcResult(id, {
        protocolVersion: chosen,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: opts.server.name, version: opts.server.version, title: opts.server.title },
        instructions: opts.server.instructions,
      }),
    };
  }
  const legacyVersion = headerVersion ?? HEADERLESS_LEGACY_VERSION;
  if (!(LEGACY_VERSIONS as readonly string[]).includes(legacyVersion)) {
    return {
      status: 400,
      json: rpcError(id, ErrorCode.UnsupportedProtocolVersion, "Unsupported protocol version", {
        supported: SUPPORTED_VERSIONS, requested: legacyVersion,
      }),
    };
  }
  return dispatch(id, method, params, "legacy", opts);
}

/** Header–body agreement, modern era (streamable-http, Server Validation). */
function checkModernHeaders(
  req: McpRequest, method: string, params: Record<string, unknown>,
  bodyVersion: string | undefined, headerVersion: string | undefined,
): string | null {
  if (headerVersion === undefined) return "Header mismatch: MCP-Protocol-Version header is missing.";
  if (bodyVersion === undefined) return "Header mismatch: the body's _meta does not name a protocol version.";
  if (headerVersion !== bodyVersion) {
    return `Header mismatch: MCP-Protocol-Version header value '${headerVersion}' does not match body value '${bodyVersion}'`;
  }
  const mcpMethod = header(req, "mcp-method");
  if (mcpMethod === undefined) return "Header mismatch: Mcp-Method header is missing.";
  if (mcpMethod !== method) return `Header mismatch: Mcp-Method header value '${mcpMethod}' does not match body value '${method}'`;
  if (method === "tools/call" || method === "resources/read" || method === "prompts/get") {
    const nameInBody = typeof params.name === "string" ? params.name : typeof params.uri === "string" ? params.uri : undefined;
    const raw = header(req, "mcp-name");
    if (raw === undefined) return "Header mismatch: Mcp-Name header is missing.";
    if (decodeHeaderValue(raw) !== nameInBody) {
      return `Header mismatch: Mcp-Name header value '${raw}' does not match body value '${nameInBody ?? ""}'`;
    }
  }
  return null;
}

type Era = "modern" | "legacy";

function complete(era: Era, result: Record<string, unknown>): Record<string, unknown> {
  // Modern results say they are complete (as opposed to input_required);
  // legacy clients were never told about the field, so it is left off.
  return era === "modern" ? { resultType: "complete", ...result } : result;
}

function dispatch(id: Id, method: string, params: Record<string, unknown>, era: Era, opts: McpOptions): McpReply {
  switch (method) {
    case "server/discover":
      if (era !== "modern") break;
      return {
        status: 200,
        json: rpcResult(id, complete(era, {
          supportedVersions: SUPPORTED_VERSIONS,
          capabilities: { tools: { listChanged: false } },
          _meta: { [META_SERVER_INFO]: { name: opts.server.name, version: opts.server.version } },
          instructions: opts.server.instructions,
        })),
      };
    case "ping":
      return { status: 200, json: rpcResult(id, complete(era, {})) };
    case "tools/list":
      // One page: the list is short, fixed, and in a deterministic order so a
      // client's prompt cache keeps hitting.
      return {
        status: 200,
        json: rpcResult(id, complete(era, {
          tools: opts.tools.map((t) => ({
            name: t.name,
            title: t.title,
            description: t.description,
            inputSchema: t.inputSchema,
            annotations: {
              title: t.title, readOnlyHint: true, destructiveHint: false, idempotentHint: true,
              ...t.annotations, openWorldHint: false,
            },
          })),
        })),
      };
    case "tools/call":
      return callTool(id, params, era, opts);
    // A server with no resources or prompts answers their lists empty rather
    // than "method not found": several clients call all three on connect and
    // treat an error as the server being broken.
    case "resources/list":
      return { status: 200, json: rpcResult(id, complete(era, { resources: [] })) };
    case "resources/templates/list":
      return { status: 200, json: rpcResult(id, complete(era, { resourceTemplates: [] })) };
    case "prompts/list":
      return { status: 200, json: rpcResult(id, complete(era, { prompts: [] })) };
  }
  // Modern: 404 with a JSON-RPC body, which tells a client probing for the
  // era that this *is* a modern server. Legacy clients expect a 200 carrying
  // the error.
  return {
    status: era === "modern" ? 404 : 200,
    json: rpcError(id, ErrorCode.MethodNotFound, `Method not found: ${method}`),
  };
}

function callTool(id: Id, params: Record<string, unknown>, era: Era, opts: McpOptions): McpReply {
  const name = params.name;
  const tool = typeof name === "string" ? opts.tools.find((t) => t.name === name) : undefined;
  if (!tool) {
    return { status: 200, json: rpcError(id, ErrorCode.InvalidParams, `Unknown tool: ${String(name)}`) };
  }
  const args = params.arguments === undefined ? {} : params.arguments;
  if (!isObject(args)) {
    return { status: 200, json: rpcError(id, ErrorCode.InvalidParams, "Tool arguments must be an object.") };
  }

  const started = Date.now();
  // Input errors and the domain's refusals are *tool* errors, not protocol
  // errors: the model reads them and can correct the date or the id.
  const problem = validateArgs(tool.inputSchema, args);
  if (problem) {
    opts.onToolCall?.({ tool: tool.name, args, ok: false, bytes: 0, ms: 0 });
    return { status: 200, json: rpcResult(id, complete(era, toolError(problem))) };
  }
  let value: unknown;
  try {
    value = tool.run(args);
  } catch (err) {
    if (err instanceof Refusal) {
      opts.onToolCall?.({ tool: tool.name, args, ok: false, bytes: 0, ms: Date.now() - started });
      return { status: 200, json: rpcResult(id, complete(era, toolError(err.message))) };
    }
    throw err; // A real fault: the route's error handling records it.
  }
  if (opts.transformResult) value = opts.transformResult(value);

  let text = JSON.stringify(value);
  let truncated = false;
  if (Buffer.byteLength(text) > MAX_RESULT_BYTES) {
    truncated = true;
    text = text.slice(0, MAX_RESULT_BYTES) +
      `\n…[truncated at ${MAX_RESULT_BYTES / 1024} KB — narrow the date range or use the tool's limit and cursor]`;
  }
  opts.onToolCall?.({ tool: tool.name, args, ok: true, bytes: Buffer.byteLength(text), ms: Date.now() - started });

  const result: Record<string, unknown> = { content: [{ type: "text", text }], isError: false };
  // structuredContent arrived in 2025-06-18; older clients ignore a field
  // they do not know. Truncated text is not valid JSON any more, so the
  // structured copy is offered only whole.
  if (!truncated && isObject(value)) {
    result.structuredContent = value;
  }
  return { status: 200, json: rpcResult(id, complete(era, result)) };
}

function toolError(message: string): Record<string, unknown> {
  return { content: [{ type: "text", text: message }], isError: true };
}

/**
 * Checks arguments against the subset of JSON Schema the tools use. Returns a
 * sentence the model can act on, or null. Unknown keys are refused when the
 * schema says `additionalProperties: false`, which every tool's does — a
 * misspelt filter silently ignored would answer a different question.
 */
export function validateArgs(schema: JsonSchema, args: Record<string, unknown>): string | null {
  for (const key of schema.required ?? []) {
    if (args[key] === undefined || args[key] === null) return `Missing required argument "${key}".`;
  }
  const props = schema.properties ?? {};
  for (const [key, value] of Object.entries(args)) {
    if (value === undefined || value === null) continue;
    const prop = props[key];
    if (!prop) {
      if (schema.additionalProperties === false) {
        const known = Object.keys(props);
        return `Unknown argument "${key}".` + (known.length ? ` Accepted: ${known.join(", ")}.` : " This tool takes none.");
      }
      continue;
    }
    const problem = checkValue(key, prop, value);
    if (problem) return problem;
  }
  return null;
}

function checkValue(key: string, prop: JsonSchema, value: unknown): string | null {
  switch (prop.type) {
    case "string":
      if (typeof value !== "string") return `"${key}" must be a string.`;
      if (prop.maxLength !== undefined && value.length > prop.maxLength) return `"${key}" is longer than ${prop.maxLength} characters.`;
      if (prop.pattern && !new RegExp(prop.pattern).test(value)) {
        return `"${key}" is not in the expected form${prop.description ? ` (${prop.description})` : ""}.`;
      }
      break;
    case "integer":
      if (typeof value !== "number" || !Number.isInteger(value)) return `"${key}" must be a whole number.`;
      break;
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value)) return `"${key}" must be a number.`;
      break;
    case "boolean":
      if (typeof value !== "boolean") return `"${key}" must be true or false.`;
      break;
    case "array":
      if (!Array.isArray(value)) return `"${key}" must be a list.`;
      if (prop.items) {
        for (const item of value) {
          const p = checkValue(key, prop.items, item);
          if (p) return p;
        }
      }
      break;
  }
  if (typeof value === "number") {
    if (prop.minimum !== undefined && value < prop.minimum) return `"${key}" must be at least ${prop.minimum}.`;
    if (prop.maximum !== undefined && value > prop.maximum) return `"${key}" must be at most ${prop.maximum}.`;
  }
  if (prop.enum && !prop.enum.includes(value as string | number)) {
    return `"${key}" must be one of: ${prop.enum.join(", ")}.`;
  }
  return null;
}
