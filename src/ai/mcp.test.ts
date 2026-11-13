import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { handleMcp, validateArgs, decodeHeaderValue, ErrorCode, MAX_RESULT_BYTES, type McpTool, type McpOptions } from "./mcp.ts";
import { Missing } from "../core/refusal.ts";

const echo: McpTool = {
  name: "echo",
  title: "Echo",
  description: "Returns its arguments.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      month: { type: "string", pattern: "^\\d{4}-\\d{2}$", description: "YYYY-MM" },
      limit: { type: "integer", minimum: 1, maximum: 500 },
      group_by: { type: "string", enum: ["category", "payee"] },
    },
  },
  run: (args) => ({ echoed: args }),
};
const missing: McpTool = {
  name: "missing", title: "Missing", description: "Always not found.",
  inputSchema: { type: "object", additionalProperties: false, properties: {} },
  run: () => { throw new Missing("That account does not exist."); },
};
const huge: McpTool = {
  name: "huge", title: "Huge", description: "Too big.",
  inputSchema: { type: "object", additionalProperties: false, properties: {} },
  run: () => ({ blob: "x".repeat(MAX_RESULT_BYTES + 10) }),
};

function opts(extra: Partial<McpOptions> = {}): McpOptions {
  return {
    server: { name: "pathayam", version: "1.0.0", instructions: "Read-only household budget." },
    tools: [echo, missing, huge],
    ...extra,
  };
}

const MODERN = "2026-07-28";
function modern(method: string, params: Record<string, unknown> = {}, headers: Record<string, string> = {}) {
  const body = {
    jsonrpc: "2.0", id: 1, method,
    params: { ...params, _meta: { "io.modelcontextprotocol/protocolVersion": MODERN } },
  };
  const h: Record<string, string> = { "mcp-protocol-version": MODERN, "mcp-method": method };
  if (typeof params.name === "string") h["mcp-name"] = params.name;
  return { headers: { ...h, ...headers }, rawBody: JSON.stringify(body) };
}
function legacy(method: string, params: Record<string, unknown> = {}, version: string | null = "2025-06-18") {
  return {
    headers: version ? { "mcp-protocol-version": version } : {},
    rawBody: JSON.stringify({ jsonrpc: "2.0", id: "a", method, params }),
  };
}
const res = (r: { json?: unknown }) => r.json as { result?: any; error?: any };

describe("AI-1 · MCP protocol, legacy era", () => {
  test("initialize echoes a supported version and names the server", () => {
    const r = handleMcp(legacy("initialize", { protocolVersion: "2025-06-18", capabilities: {} }, null), opts());
    assert.equal(r.status, 200);
    assert.equal(res(r).result.protocolVersion, "2025-06-18");
    assert.deepEqual(res(r).result.capabilities, { tools: { listChanged: false } });
    assert.equal(res(r).result.serverInfo.name, "pathayam");
    assert.equal(r.headers?.["Mcp-Session-Id"], undefined, "no sessions are issued");
  });

  test("an unknown requested version is answered with our newest legacy one", () => {
    const r = handleMcp(legacy("initialize", { protocolVersion: "2099-01-01" }, null), opts());
    assert.equal(res(r).result.protocolVersion, "2025-11-25");
  });

  test("notifications are accepted with 202 and no body", () => {
    const r = handleMcp({ headers: {}, rawBody: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) }, opts());
    assert.equal(r.status, 202);
    assert.equal(r.json, undefined);
  });

  test("tools/list marks every tool read-only and has no resultType", () => {
    const r = handleMcp(legacy("tools/list"), opts());
    const tools = res(r).result.tools;
    assert.deepEqual(tools.map((t: any) => t.name), ["echo", "missing", "huge"]);
    assert.ok(tools.every((t: any) => t.annotations.readOnlyHint === true && t.annotations.destructiveHint === false));
    assert.equal(res(r).result.resultType, undefined);
  });

  test("a request without the version header is taken as 2025-03-26", () => {
    const r = handleMcp(legacy("ping", {}, null), opts());
    assert.equal(r.status, 200);
    assert.deepEqual(res(r).result, {});
  });

  test("an unsupported version header is refused with the supported list", () => {
    const r = handleMcp(legacy("ping", {}, "2023-01-01"), opts());
    assert.equal(r.status, 400);
    assert.equal(res(r).error.code, ErrorCode.UnsupportedProtocolVersion);
    assert.ok(res(r).error.data.supported.includes("2026-07-28"));
  });

  test("unknown methods are a 200 carrying -32601", () => {
    const r = handleMcp(legacy("sampling/createMessage"), opts());
    assert.equal(r.status, 200);
    assert.equal(res(r).error.code, ErrorCode.MethodNotFound);
  });

  test("server/discover is a modern method only", () => {
    const r = handleMcp(legacy("server/discover"), opts());
    assert.equal(res(r).error.code, ErrorCode.MethodNotFound);
  });

  test("tools/call returns text and structured content", () => {
    const r = handleMcp(legacy("tools/call", { name: "echo", arguments: { month: "2026-11" } }), opts());
    const result = res(r).result;
    assert.equal(result.isError, false);
    assert.deepEqual(JSON.parse(result.content[0].text), { echoed: { month: "2026-11" } });
    assert.deepEqual(result.structuredContent, { echoed: { month: "2026-11" } });
  });
});

describe("AI-1 · MCP protocol, modern era", () => {
  test("server/discover lists versions, capabilities and server info", () => {
    const r = handleMcp(modern("server/discover"), opts());
    assert.equal(r.status, 200);
    const result = res(r).result;
    assert.equal(result.resultType, "complete");
    assert.ok(result.supportedVersions.includes("2026-07-28"));
    assert.ok(result.supportedVersions.includes("2025-06-18"));
    assert.equal(result._meta["io.modelcontextprotocol/serverInfo"].name, "pathayam");
  });

  test("tools/call needs Mcp-Name to match the body", () => {
    const ok = handleMcp(modern("tools/call", { name: "echo", arguments: {} }), opts());
    assert.equal(res(ok).result.resultType, "complete");

    const wrong = handleMcp(modern("tools/call", { name: "echo", arguments: {} }, { "mcp-name": "huge" }), opts());
    assert.equal(wrong.status, 400);
    assert.equal(res(wrong).error.code, ErrorCode.HeaderMismatch);
  });

  test("a base64-encoded Mcp-Name is decoded before comparing", () => {
    const encoded = `=?base64?${Buffer.from("echo").toString("base64")}?=`;
    assert.equal(decodeHeaderValue(encoded), "echo");
    const r = handleMcp(modern("tools/call", { name: "echo" }, { "mcp-name": encoded }), opts());
    assert.equal(r.status, 200);
  });

  test("a missing or mismatched header is a 400 HeaderMismatch", () => {
    const noMethod = modern("tools/list");
    delete (noMethod.headers as Record<string, string>)["mcp-method"];
    assert.equal(handleMcp(noMethod, opts()).status, 400);

    const otherMethod = modern("tools/list", {}, { "mcp-method": "tools/call" });
    assert.equal(res(handleMcp(otherMethod, opts())).error.code, ErrorCode.HeaderMismatch);

    const otherVersion = modern("tools/list", {}, { "mcp-protocol-version": "2025-06-18" });
    assert.equal(res(handleMcp(otherVersion, opts())).error.code, ErrorCode.HeaderMismatch);
  });

  test("a modern header with no _meta in the body is a mismatch, not a legacy request", () => {
    const r = handleMcp({
      headers: { "mcp-protocol-version": MODERN, "mcp-method": "tools/list" },
      rawBody: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    }, opts());
    assert.equal(r.status, 400);
    assert.equal(res(r).error.code, ErrorCode.HeaderMismatch);
  });

  test("an unknown modern version is UnsupportedProtocolVersion with the list", () => {
    const req = modern("tools/list");
    const body = JSON.parse(req.rawBody);
    body.params._meta["io.modelcontextprotocol/protocolVersion"] = "2030-01-01";
    const r = handleMcp({ headers: { ...req.headers, "mcp-protocol-version": "2030-01-01" }, rawBody: JSON.stringify(body) }, opts());
    assert.equal(r.status, 400);
    assert.equal(res(r).error.code, ErrorCode.UnsupportedProtocolVersion);
    assert.equal(res(r).error.data.requested, "2030-01-01");
  });

  test("an unknown method is a 404 with a JSON-RPC body", () => {
    const r = handleMcp(modern("subscriptions/listen"), opts());
    assert.equal(r.status, 404);
    assert.equal(res(r).error.code, ErrorCode.MethodNotFound);
  });
});

describe("AI-1 · tool calls", () => {
  test("bad arguments are a tool error the model can read", () => {
    for (const [args, expect] of [
      [{ month: "November" }, /month.*expected form.*YYYY-MM/],
      [{ limit: 0 }, /at least 1/],
      [{ limit: 2.5 }, /whole number/],
      [{ group_by: "colour" }, /one of: category, payee/],
      [{ monht: "2026-11" }, /Unknown argument "monht".*Accepted: month, limit, group_by/],
    ] as const) {
      const r = handleMcp(legacy("tools/call", { name: "echo", arguments: args }), opts());
      assert.equal(res(r).result.isError, true, JSON.stringify(args));
      assert.match(res(r).result.content[0].text, expect);
    }
  });

  test("a Refusal from the domain is a tool error, not a fault", () => {
    const calls: unknown[] = [];
    const r = handleMcp(legacy("tools/call", { name: "missing" }), opts({ onToolCall: (c) => calls.push(c) }));
    assert.equal(res(r).result.isError, true);
    assert.equal(res(r).result.content[0].text, "That account does not exist.");
    assert.equal((calls[0] as { ok: boolean }).ok, false);
  });

  test("an unknown tool is a protocol error", () => {
    const r = handleMcp(legacy("tools/call", { name: "write_budget" }), opts());
    assert.equal(res(r).error.code, ErrorCode.InvalidParams);
  });

  test("an oversized answer is cut, says so, and drops structured content", () => {
    const r = handleMcp(legacy("tools/call", { name: "huge" }), opts());
    const result = res(r).result;
    assert.match(result.content[0].text, /truncated at 256 KB/);
    assert.equal(result.structuredContent, undefined);
  });

  test("the result transform is applied before anything leaves", () => {
    const r = handleMcp(legacy("tools/call", { name: "echo", arguments: { month: "2026-11" } }),
      opts({ transformResult: () => ({ replaced: true }) }));
    assert.deepEqual(res(r).result.structuredContent, { replaced: true });
  });

  test("an unexpected error is rethrown for the route to record", () => {
    const broken: McpTool = { ...echo, name: "broken", run: () => { throw new TypeError("bug"); } };
    assert.throws(() => handleMcp(legacy("tools/call", { name: "broken" }), opts({ tools: [broken] })), TypeError);
  });
});

describe("AI-1 · malformed requests", () => {
  test("not JSON, a batch, a response, and a null id are all refused", () => {
    assert.equal(res(handleMcp({ headers: {}, rawBody: "{" }, opts())).error.code, ErrorCode.ParseError);
    assert.equal(res(handleMcp({ headers: {}, rawBody: "[]" }, opts())).error.code, ErrorCode.InvalidRequest);
    assert.equal(res(handleMcp({ headers: {}, rawBody: JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }) }, opts())).error.code, ErrorCode.InvalidRequest);
    assert.equal(handleMcp({ headers: {}, rawBody: JSON.stringify({ jsonrpc: "2.0", id: null, method: "ping" }) }, opts()).status, 400);
  });

  test("validateArgs honours required", () => {
    assert.match(validateArgs({ type: "object", required: ["fy"], properties: { fy: { type: "integer" } } }, {})!, /Missing required argument "fy"/);
  });
});

describe("WEB-6 · a refusal is masked like a result", () => {
  test("the connection's transform applies to a tool's refusal text", async () => {
    const { redactValue } = await import("./redact.ts");
    const refuses: McpTool = {
      name: "refuses", title: "Refuses", description: "Always refuses.",
      inputSchema: { type: "object", additionalProperties: false, properties: {} },
      run: () => { throw new Missing("HDFC 50100123456789 (ravi@okhdfc) is valued on its own screen."); },
    };
    const r = handleMcp(legacy("tools/call", { name: "refuses", arguments: {} }),
      opts({ tools: [refuses], transformResult: redactValue }));
    const text = res(r).result.content[0].text as string;
    assert.equal(res(r).result.isError, true);
    assert.doesNotMatch(text, /50100123456789|ravi@/);
    assert.match(text, /••••6789/);
  });
});
