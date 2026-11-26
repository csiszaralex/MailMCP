import { isIPv4, isIPv6 } from 'node:net';

const MAPPED_IPV4_PREFIX = '::ffff:';
const IPV6_GROUPS = 8;
/** The groups of a /64 prefix: one end site usually gets a whole /64 (D34). */
const PREFIX_GROUPS = 4;

/**
 * Client address for the login limiter and the auth log (D34). Behind a proxy the last
 * X-Forwarded-For element is used, because it is the one the trusted proxy appended; earlier
 * elements are client controlled. An IPv4-mapped address becomes plain IPv4, and any other IPv6
 * address becomes its /64 prefix, because one host can pick any address of its /64.
 */
export function clientIp(
  forwardedFor: string | undefined,
  remoteAddress: string | undefined,
  behindProxy: boolean,
): string {
  const forwarded = behindProxy ? lastElement(forwardedFor) : undefined;
  const address = forwarded ?? remoteAddress;
  if (address === undefined || address === '') return 'unknown';
  if (address.toLowerCase().startsWith(MAPPED_IPV4_PREFIX)) {
    const mapped = address.slice(MAPPED_IPV4_PREFIX.length);
    if (isIPv4(mapped)) return mapped;
  }
  return isIPv6(address) ? ipv6Prefix64(address) : address;
}

/** The /64 of a valid IPv6 address with the groups in lowercase hex without leading zeros. */
function ipv6Prefix64(address: string): string {
  const [withoutZone = ''] = address.split('%');
  const [head = '', tail] = withoutZone.split('::');
  const groups = (part: string): string[] =>
    part === ''
      ? []
      : part
          .split(':')
          // A dotted IPv4 tail fills the last two groups, which never reach the prefix.
          .flatMap((group) => (group.includes('.') ? ['0', '0'] : [group]));
  const first = groups(head);
  const last = tail === undefined ? [] : groups(tail);
  const zeros = new Array<string>(IPV6_GROUPS - first.length - last.length).fill('0');
  const all = [...first, ...zeros, ...last];
  const prefix = all.slice(0, PREFIX_GROUPS).map((group) => parseInt(group, 16).toString(16));
  return `${prefix.join(':')}::/64`;
}

function lastElement(header: string | undefined): string | undefined {
  if (header === undefined) return undefined;
  const last = header.split(',').pop()?.trim();
  return last === undefined || last === '' ? undefined : last;
}
