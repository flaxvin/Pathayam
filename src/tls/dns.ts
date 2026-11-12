/**
 * TLS-1 · DNS-01: the solver interface any DNS provider implements, and the
 * wait for a TXT record to be visible before Let's Encrypt is asked to look.
 */

import { Resolver } from "node:dns/promises";

/**
 * Publishes and removes one `_acme-challenge` TXT record. `present` returns
 * whatever `cleanup` needs to remove exactly that record (a record id), so two
 * values on the same name — a name and its wildcard — never remove each other.
 */
export interface DnsSolver {
  readonly name: string;
  present(recordName: string, value: string): Promise<unknown>;
  cleanup(handle: unknown): Promise<void>;
}

export type TxtLookup = (server: string, name: string) => Promise<string[]>;

/** Asks one resolver, directly, for a name's TXT values. */
export const lookupTxt: TxtLookup = async (server, name) => {
  const resolver = new Resolver({ timeout: 5_000, tries: 1 });
  resolver.setServers([server]);
  const records = await resolver.resolveTxt(name);
  return records.map((chunks) => chunks.join(""));
};

export const DEFAULT_RESOLVERS = ["1.1.1.1", "8.8.8.8"];

export type PropagationOptions = {
  resolvers?: string[];
  timeoutMs?: number;
  intervalMs?: number;
  lookup?: TxtLookup;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
};

/**
 * Polls each resolver until every one returns `value` at `name`, or the time
 * runs out. Returns whether it was seen everywhere. Not seeing it is not fatal:
 * Let's Encrypt asks the zone's own nameservers, which a public resolver can
 * lag (or cache a miss for), so the caller goes ahead and lets the CA decide.
 */
export async function waitForTxt(name: string, value: string, opts: PropagationOptions = {}): Promise<boolean> {
  const resolvers = opts.resolvers ?? DEFAULT_RESOLVERS;
  const lookup = opts.lookup ?? lookupTxt;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = opts.now ?? Date.now;
  const deadline = now() + (opts.timeoutMs ?? 120_000);
  const pending = new Set(resolvers);
  for (;;) {
    for (const server of [...pending]) {
      try {
        if ((await lookup(server, name)).includes(value)) pending.delete(server);
      } catch {
        // NXDOMAIN or a timeout: not there yet.
      }
    }
    if (pending.size === 0) return true;
    if (now() >= deadline) return false;
    await sleep(opts.intervalMs ?? 5_000);
  }
}
