/**
 * The short-lived state an OAuth round trip leaves behind: the PKCE verifier
 * and where to go afterwards, keyed by the `state` value handed to the
 * provider.
 *
 * docs/security.md promises that state is "single-use, expiring after ten
 * minutes". Single-use was true — the callbacks delete the entry as they read
 * it — but expiry was only ever a side effect of pruning, and only GET
 * /auth/google (and the Gmail link) pruned. With OIDC configured and Google
 * not, a state used an hour after it was issued still completed a sign-in,
 * and every unauthenticated GET /auth/oidc added an entry that nothing ever
 * removed: a scripted client could grow the process until the 512 MB machine
 * was killed (SECURITY-OPS-19).
 *
 * So expiry is checked where the state is *used*, not merely where it is
 * pruned, and every insert prunes and caps the map. The cap is generous —
 * a household signs in a few times a day — and evicts the oldest first, so a
 * flood can at worst make a real person's sign-in link expire early, never
 * exhaust memory.
 */

export const PENDING_TTL_MS = 10 * 60_000;
export const PENDING_CAP = 1_000;

export class PendingStates<T extends { at: number }> {
  private readonly entries = new Map<string, T>();
  private readonly ttlMs: number;
  private readonly cap: number;
  private readonly now: () => number;

  constructor(opts: { ttlMs?: number; cap?: number; now?: () => number } = {}) {
    this.ttlMs = opts.ttlMs ?? PENDING_TTL_MS;
    this.cap = opts.cap ?? PENDING_CAP;
    this.now = opts.now ?? (() => Date.now());
  }

  /** Hold a new state, dropping expired ones and, past the cap, the oldest. */
  set(state: string, value: T): void {
    const now = this.now();
    for (const [key, entry] of this.entries) {
      if (now - entry.at > this.ttlMs) this.entries.delete(key);
    }
    // A Map iterates in insertion order, so the first keys are the oldest.
    while (this.entries.size >= this.cap) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    this.entries.set(state, value);
  }

  /** Read and remove: single-use, and nothing once it has expired. */
  take(state: string): T | undefined {
    const entry = this.entries.get(state);
    this.entries.delete(state);
    if (!entry || this.now() - entry.at > this.ttlMs) return undefined;
    return entry;
  }

  get size(): number {
    return this.entries.size;
  }
}
