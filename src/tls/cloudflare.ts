/**
 * TLS-1 · DNS-01 on Cloudflare: creates and deletes the `_acme-challenge` TXT
 * record through the v4 API with a token that may edit DNS in the zone
 * (Zone → DNS → Edit). The zone is CLOUDFLARE_ZONE_ID when given, otherwise
 * found by name, trying the record's parent names from the longest down.
 */

import type { DnsSolver } from "./dns.ts";

export const CLOUDFLARE_API = "https://api.cloudflare.com/client/v4";

export type CloudflareOptions = {
  token: string;
  zoneId?: string | null;
  apiBase?: string;
  fetchImpl?: typeof fetch;
};

type CfResponse<T> = { success: boolean; errors?: { code: number; message: string }[]; result: T };

type Handle = { zoneId: string; recordId: string };

export class CloudflareSolver implements DnsSolver {
  readonly name = "cloudflare";
  readonly #token: string;
  readonly #zoneId: string | null;
  readonly #api: string;
  readonly #fetch: typeof fetch;
  readonly #zones = new Map<string, string>();

  constructor(opts: CloudflareOptions) {
    if (!opts.token) throw new Error("CLOUDFLARE_API_TOKEN is required for the Cloudflare DNS solver");
    this.#token = opts.token;
    this.#zoneId = opts.zoneId || null;
    this.#api = (opts.apiBase ?? CLOUDFLARE_API).replace(/\/$/, "");
    this.#fetch = opts.fetchImpl ?? fetch;
  }

  async #call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.#fetch(`${this.#api}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.#token}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30_000),
    });
    let json: CfResponse<T> | undefined;
    try {
      json = (await res.json()) as CfResponse<T>;
    } catch {
      // fall through to the status check
    }
    if (!res.ok || !json?.success) {
      const why = json?.errors?.map((e) => `${e.code} ${e.message}`).join("; ") || `HTTP ${res.status}`;
      // The token never appears here: only the method, the path and Cloudflare's own words.
      throw new Error(`Cloudflare ${method} ${path.split("?")[0]} failed: ${why}`);
    }
    return json.result;
  }

  /** The zone holding `name`: the configured id, or the longest parent name Cloudflare knows. */
  async zoneFor(name: string): Promise<string> {
    if (this.#zoneId) return this.#zoneId;
    const labels = name.replace(/\.$/, "").split(".");
    for (let i = 0; i < labels.length - 1; i++) {
      const candidate = labels.slice(i).join(".");
      const cached = this.#zones.get(candidate);
      if (cached) return cached;
      const zones = await this.#call<{ id: string; name: string }[]>(
        "GET", `/zones?name=${encodeURIComponent(candidate)}&status=active`,
      );
      const zone = zones.find((z) => z.name === candidate);
      if (zone) {
        this.#zones.set(candidate, zone.id);
        return zone.id;
      }
    }
    throw new Error(
      `no Cloudflare zone found for ${name}: check that the token can read the zone, or set CLOUDFLARE_ZONE_ID`,
    );
  }

  async present(recordName: string, value: string): Promise<Handle> {
    const zoneId = await this.zoneFor(recordName);
    const record = await this.#call<{ id: string }>("POST", `/zones/${zoneId}/dns_records`, {
      type: "TXT",
      name: recordName,
      content: `"${value}"`,
      ttl: 60,
      comment: "ACME DNS-01 challenge, removed once checked",
    });
    return { zoneId, recordId: record.id };
  }

  async cleanup(handle: unknown): Promise<void> {
    const { zoneId, recordId } = handle as Handle;
    await this.#call("DELETE", `/zones/${zoneId}/dns_records/${recordId}`);
  }
}
