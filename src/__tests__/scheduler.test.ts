import { describe, it, expect, vi, afterEach } from 'vitest';
import { startDreamScheduler } from '../scheduler.js';

function fakeMeta() {
  const m = new Map<string, string>();
  return {
    getMeta: (k: string) => m.get(k) ?? null,
    setMeta: (k: string, v: string) => { m.set(k, v); },
  };
}

afterEach(() => vi.useRealTimers());

describe('startDreamScheduler', () => {
  it('dreams once per interval, not per tick', async () => {
    vi.useFakeTimers();
    const consolidate = vi.fn().mockResolvedValue({});
    const meta = fakeMeta();
    const handle = startDreamScheduler(
      { consolidate, ...meta },
      { intervalMs: 60_000, checkMs: 10_000 },
    );

    await vi.advanceTimersByTimeAsync(10_000);   // first tick: no last_dream_at → dream
    expect(consolidate).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(30_000);   // three more ticks inside the interval
    expect(consolidate).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(60_000);   // past the interval → dream again
    expect(consolidate).toHaveBeenCalledTimes(2);
    handle.stop();
  });

  it('two schedulers on one meta store produce one dream (lease)', async () => {
    vi.useFakeTimers();
    const meta = fakeMeta();
    const slow = vi.fn(() => new Promise(r => setTimeout(r, 50_000)));
    const a = startDreamScheduler({ consolidate: slow, ...meta }, { intervalMs: 60_000, checkMs: 10_000 });
    const b = startDreamScheduler({ consolidate: slow, ...meta }, { intervalMs: 60_000, checkMs: 10_000 });

    await vi.advanceTimersByTimeAsync(20_000);
    expect(slow).toHaveBeenCalledTimes(1);       // second scheduler saw the lease and skipped
    a.stop(); b.stop();
  });

  it("a crashed holder's expired lease is taken over", async () => {
    vi.useFakeTimers();
    const meta = fakeMeta();
    meta.setMeta('dream_lease', JSON.stringify({ pid: 99999, expiresAt: new Date(Date.now() - 1000).toISOString() }));
    const consolidate = vi.fn().mockResolvedValue({});
    const h = startDreamScheduler({ consolidate, ...meta }, { intervalMs: 60_000, checkMs: 10_000 });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(consolidate).toHaveBeenCalledTimes(1);
    h.stop();
  });
});
