import { afterEach, describe, expect, it } from 'vitest';
import { LoginLimiter } from '../../src/auth/limiter.js';
import { Store } from '../../src/store/store.js';

const START = 1_800_000_000_000;
const MINUTE = 60_000;

const open: Store[] = [];

afterEach(() => {
  for (const store of open.splice(0)) store.close();
});

function setup(): { limiter: LoginLimiter; setNow: (at: number) => void } {
  const store = Store.open(':memory:');
  open.push(store);
  let now = START;
  return {
    limiter: new LoginLimiter(store, () => now),
    setNow: (at) => {
      now = at;
    },
  };
}

describe('LoginLimiter per ip', () => {
  it('allows after 4 failures and denies after the 5th for about 900 seconds', () => {
    const { limiter } = setup();
    for (let i = 0; i < 4; i += 1) limiter.recordFailure('1.1.1.1');
    expect(limiter.check('1.1.1.1')).toEqual({ allowed: true });
    limiter.recordFailure('1.1.1.1');
    expect(limiter.check('1.1.1.1')).toEqual({ allowed: false, retryAfterSeconds: 900 });
  });

  it('counts the retry time from the oldest failure in the window', () => {
    const { limiter, setNow } = setup();
    for (let i = 0; i < 5; i += 1) {
      setNow(START + i * MINUTE);
      limiter.recordFailure('1.1.1.1');
    }
    setNow(START + 5 * MINUTE);
    expect(limiter.check('1.1.1.1')).toEqual({ allowed: false, retryAfterSeconds: 600 });
  });

  it('allows again after 15 minutes', () => {
    const { limiter, setNow } = setup();
    for (let i = 0; i < 5; i += 1) limiter.recordFailure('1.1.1.1');
    setNow(START + 15 * MINUTE - 1);
    expect(limiter.check('1.1.1.1').allowed).toBe(false);
    setNow(START + 15 * MINUTE + 1);
    expect(limiter.check('1.1.1.1')).toEqual({ allowed: true });
  });

  it('clears the counter of an ip on success', () => {
    const { limiter } = setup();
    for (let i = 0; i < 4; i += 1) limiter.recordFailure('1.1.1.1');
    limiter.recordSuccess('1.1.1.1');
    limiter.recordFailure('1.1.1.1');
    expect(limiter.check('1.1.1.1')).toEqual({ allowed: true });
  });

  it('does not affect another ip below the global threshold', () => {
    const { limiter } = setup();
    for (let i = 0; i < 5; i += 1) limiter.recordFailure('1.1.1.1');
    expect(limiter.check('1.1.1.1').allowed).toBe(false);
    expect(limiter.check('2.2.2.2')).toEqual({ allowed: true });
  });
});

describe('LoginLimiter global', () => {
  it('spaces checks 3 seconds apart after 20 failures from different ips', () => {
    const { limiter, setNow } = setup();
    for (let i = 0; i < 20; i += 1) limiter.recordFailure(`10.0.0.${String(i)}`);
    expect(limiter.check('9.9.9.9')).toEqual({ allowed: true });
    setNow(START + 1000);
    expect(limiter.check('9.9.9.9')).toEqual({ allowed: false, retryAfterSeconds: 3 });
    setNow(START + 3000);
    expect(limiter.check('9.9.9.9')).toEqual({ allowed: true });
  });

  it('does not space checks below 20 failures', () => {
    const { limiter } = setup();
    for (let i = 0; i < 19; i += 1) limiter.recordFailure(`10.0.0.${String(i)}`);
    expect(limiter.check('9.9.9.9')).toEqual({ allowed: true });
    expect(limiter.check('9.9.9.9')).toEqual({ allowed: true });
  });

  it('checks the per-ip ban before the global spacing', () => {
    const { limiter } = setup();
    for (let i = 0; i < 20; i += 1) limiter.recordFailure('1.1.1.1');
    expect(limiter.check('1.1.1.1')).toEqual({ allowed: false, retryAfterSeconds: 900 });
  });
});
