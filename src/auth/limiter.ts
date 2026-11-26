import { FAILURE_WINDOW_MS, type Store } from '../store/store.js';
import type { Clock } from './tokens.js';

/** Failures of one ip within the window that ban it until the oldest one expires (D34). */
const MAX_IP_FAILURES = 5;
/** Failures of all ips within the window that start spacing out every check (D34). */
const GLOBAL_FAILURE_THRESHOLD = 20;
/** Minimum time between two allowed checks while the global threshold is reached (D34). */
const GLOBAL_MIN_INTERVAL_MS = 3000;

export type LimitDecision = { allowed: true } | { allowed: false; retryAfterSeconds: number };

export class LoginLimiter {
  private readonly store: Store;
  private readonly clock: Clock;
  private lastAllowedAt: number | undefined;

  constructor(store: Store, clock: Clock) {
    this.store = store;
    this.clock = clock;
  }

  /** Call before verifying credentials. */
  check(ip: string): LimitDecision {
    const now = this.clock();
    const since = now - FAILURE_WINDOW_MS;

    if (this.store.countLoginFailures(since, ip) >= MAX_IP_FAILURES) {
      const oldest = this.store.oldestLoginFailure(since, ip) ?? now;
      const retryAfterMs = oldest + FAILURE_WINDOW_MS - now;
      return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1000)) };
    }

    if (this.store.countLoginFailures(since) >= GLOBAL_FAILURE_THRESHOLD) {
      if (this.lastAllowedAt !== undefined && now - this.lastAllowedAt < GLOBAL_MIN_INTERVAL_MS) {
        return { allowed: false, retryAfterSeconds: GLOBAL_MIN_INTERVAL_MS / 1000 };
      }
      this.lastAllowedAt = now;
    }
    return { allowed: true };
  }

  recordFailure(ip: string): void {
    this.store.recordLoginFailure(ip, this.clock());
  }

  recordSuccess(ip: string): void {
    this.store.clearLoginFailures(ip);
  }
}
