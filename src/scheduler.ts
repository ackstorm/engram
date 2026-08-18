// ============================================================
// Dream scheduler — periodic consolidation with a meta-table lease
// ============================================================
//
// Owned by whichever process owns the DB: `engram mcp` (embedded) and
// `engram serve`. Never runs in `engram client` (no DB there).
//
// The lease lives in engram_meta of the *global* vault, which is a file
// shared by every process pointed at the same vault — that is what makes
// it a cross-process lock. ponytail: read-then-write lease check is not
// atomic; the worst case is a rare double consolidation, which is safe.
// Upgrade path: single conditional UPDATE if it ever matters.

const LAST_DREAM_KEY = 'last_dream_at';
const LEASE_KEY = 'dream_lease';
const LEASE_TTL_MS = 30 * 60 * 1000;

export interface DreamDeps {
  consolidate: () => Promise<unknown>;
  getMeta: (key: string) => string | null;
  setMeta: (key: string, value: string) => void;
}

export interface DreamOpts {
  /** Time between dreams. Default 24h, or ENGRAM_DREAM_INTERVAL_HOURS. */
  intervalMs?: number;
  /** Time between wake-up checks. Default 15 min. */
  checkMs?: number;
}

export function startDreamScheduler(deps: DreamDeps, opts: DreamOpts = {}): { stop(): void } {
  const envHours = Number(process.env.ENGRAM_DREAM_INTERVAL_HOURS);
  const intervalMs = opts.intervalMs
    ?? (Number.isFinite(envHours) && envHours > 0 ? envHours * 3_600_000 : 24 * 3_600_000);
  const checkMs = opts.checkMs ?? 15 * 60_000;

  async function tick(): Promise<void> {
    try {
      const last = deps.getMeta(LAST_DREAM_KEY);
      if (last && Date.now() - new Date(last).getTime() < intervalMs) return;

      const rawLease = deps.getMeta(LEASE_KEY);
      if (rawLease) {
        try {
          const lease = JSON.parse(rawLease) as { expiresAt: string };
          if (new Date(lease.expiresAt).getTime() > Date.now()) return; // someone else is dreaming
        } catch { /* malformed lease: treat as expired */ }
      }
      deps.setMeta(LEASE_KEY, JSON.stringify({
        pid: process.pid,
        expiresAt: new Date(Date.now() + LEASE_TTL_MS).toISOString(),
      }));

      try {
        await deps.consolidate();
        deps.setMeta(LAST_DREAM_KEY, new Date().toISOString());
      } finally {
        deps.setMeta(LEASE_KEY, JSON.stringify({ pid: process.pid, expiresAt: new Date(0).toISOString() }));
      }
    } catch (err) {
      // The dream must never kill the host process.
      console.error('[engram] dream failed:', err instanceof Error ? err.message : err);
    }
  }

  const timer = setInterval(tick, checkMs);
  timer.unref?.(); // never keep the process alive just to dream
  return { stop: () => clearInterval(timer) };
}
