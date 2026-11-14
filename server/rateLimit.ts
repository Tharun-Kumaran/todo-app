/**
 * Small in-process sliding-window rate limiter. It is intentionally
 * dependency-free and good enough for a single Node process; the Postgres
 * migration will move counters into `rate_limit_events` for multi-instance
 * deployments.
 */
export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterMs: number;
}

export class RateLimiter {
  private readonly buckets = new Map<string, number[]>();

  consume(
    key: string,
    limit: number,
    windowMs: number,
    now = Date.now(),
  ): RateLimitResult {
    const cutoff = now - windowMs;
    const hits = (this.buckets.get(key) ?? []).filter((time) => time > cutoff);

    if (hits.length >= limit) {
      const oldest = hits[0] ?? now;
      this.buckets.set(key, hits);
      return {
        allowed: false,
        remaining: 0,
        retryAfterMs: Math.max(0, oldest + windowMs - now),
      };
    }

    hits.push(now);
    this.buckets.set(key, hits);
    if (this.buckets.size > 20_000) this.prune(now);
    return {
      allowed: true,
      remaining: Math.max(0, limit - hits.length),
      retryAfterMs: 0,
    };
  }

  reset(key?: string): void {
    if (key === undefined) this.buckets.clear();
    else this.buckets.delete(key);
  }

  private prune(now: number): void {
    const cutoff = now - 86_400_000;
    for (const [key, hits] of this.buckets) {
      const latest = hits[hits.length - 1];
      if (latest === undefined || latest < cutoff) this.buckets.delete(key);
    }
  }
}
