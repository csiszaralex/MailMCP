import * as z from 'zod';
import { parseJsonText } from './boundary.js';
import { MailError } from './errors.js';

// Ids are opaque to clients: base64url(JSON) with short keys and a version tag.

export interface MessageRef {
  account: string;
  mailbox: string;
  /** IMAP UIDVALIDITY as a decimal string (it is a bigint in imapflow). */
  uidValidity: string;
  uid: number;
}

export type ThreadRef =
  | { kind: 'gmail'; account: string; gmailThreadId: string }
  | { kind: 'references'; account: string; mailbox: string; rootMessageId: string };

const messageWire = z.strictObject({
  v: z.literal(1),
  a: z.string().min(1),
  m: z.string().min(1),
  uv: z.string().regex(/^\d+$/),
  u: z.int().positive(),
});

const threadWire = z.discriminatedUnion('k', [
  z.strictObject({
    v: z.literal(1),
    k: z.literal('gm'),
    a: z.string().min(1),
    t: z.string().min(1),
  }),
  z.strictObject({
    v: z.literal(1),
    k: z.literal('ref'),
    a: z.string().min(1),
    m: z.string().min(1),
    r: z.string(),
  }),
]);

const cursorWire = z.strictObject({
  v: z.literal(1),
  o: z.record(z.string(), z.int().nonnegative()),
});

function encode(value: object): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function decode<T>(token: string, schema: z.ZodType<T>, what: string): T {
  const invalid = new MailError('invalid_id', `"${token}" is not a valid ${what}.`);
  if (!/^[A-Za-z0-9_-]+$/.test(token)) throw invalid;
  let raw;
  try {
    raw = parseJsonText(Buffer.from(token, 'base64url').toString('utf8'));
  } catch {
    throw invalid;
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw invalid;
  return parsed.data;
}

export function encodeMessageId(ref: MessageRef): string {
  return encode({ v: 1, a: ref.account, m: ref.mailbox, uv: ref.uidValidity, u: ref.uid });
}

export function decodeMessageId(id: string): MessageRef {
  const wire = decode(id, messageWire, 'message id');
  return { account: wire.a, mailbox: wire.m, uidValidity: wire.uv, uid: wire.u };
}

export function encodeThreadId(ref: ThreadRef): string {
  return ref.kind === 'gmail'
    ? encode({ v: 1, k: 'gm', a: ref.account, t: ref.gmailThreadId })
    : encode({ v: 1, k: 'ref', a: ref.account, m: ref.mailbox, r: ref.rootMessageId });
}

export function decodeThreadId(id: string): ThreadRef {
  const wire = decode(id, threadWire, 'thread id');
  return wire.k === 'gm'
    ? { kind: 'gmail', account: wire.a, gmailThreadId: wire.t }
    : { kind: 'references', account: wire.a, mailbox: wire.m, rootMessageId: wire.r };
}

export function encodeCursor(offsets: Record<string, number>): string {
  return encode({ v: 1, o: offsets });
}

export function decodeCursor(token: string): Record<string, number> {
  return decode(token, cursorWire, 'page token').o;
}
