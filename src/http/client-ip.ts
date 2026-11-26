const MAPPED_IPV4_PREFIX = '::ffff:';

/**
 * Client address for the login limiter (D34). Behind a proxy the last
 * X-Forwarded-For element is used, because it is the one the trusted proxy
 * appended; earlier elements are client controlled.
 */
export function clientIp(
  forwardedFor: string | undefined,
  remoteAddress: string | undefined,
  behindProxy: boolean,
): string {
  const forwarded = behindProxy ? lastElement(forwardedFor) : undefined;
  const address = forwarded ?? remoteAddress;
  if (address === undefined || address === '') return 'unknown';
  return address.toLowerCase().startsWith(MAPPED_IPV4_PREFIX)
    ? address.slice(MAPPED_IPV4_PREFIX.length)
    : address;
}

function lastElement(header: string | undefined): string | undefined {
  if (header === undefined) return undefined;
  const last = header.split(',').pop()?.trim();
  return last === undefined || last === '' ? undefined : last;
}
