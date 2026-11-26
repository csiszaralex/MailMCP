import * as z from 'zod';

/** Account ids appear in URLs (/mcp/<id>) and env var names, so keep them simple. */
export const ACCOUNT_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;

const endpointSchema = z.strictObject({
  host: z.string().min(1),
  port: z.int().min(1).max(65535),
});

const mailboxOverridesSchema = z
  .strictObject({
    drafts: z.string().min(1),
    sent: z.string().min(1),
    trash: z.string().min(1),
    junk: z.string().min(1),
    all: z.string().min(1),
    archive: z.string().min(1),
  })
  .partial();

const commonFields = {
  id: z
    .string()
    .regex(ACCOUNT_ID_PATTERN, 'id must be 1-32 lowercase letters, digits or inner dashes'),
  address: z.email(),
  username: z.string().min(1).optional(),
  level: z.enum(['read', 'draft', 'send']),
  signature: z.string().optional(),
  mailboxes: mailboxOverridesSchema.optional(),
};

const gmailAccountSchema = z.strictObject({ ...commonFields, provider: z.literal('gmail') });

const imapAccountSchema = z.strictObject({
  ...commonFields,
  provider: z.literal('imap'),
  imap: endpointSchema,
  smtp: endpointSchema,
});

export const configFileSchema = z.strictObject({
  owner: z.string().min(1),
  accounts: z
    .array(z.discriminatedUnion('provider', [gmailAccountSchema, imapAccountSchema]))
    .min(1),
});

export type ConfigFile = z.infer<typeof configFileSchema>;
type AccountEntry = ConfigFile['accounts'][number];
export type AccessLevel = AccountEntry['level'];
export type MailboxOverrides = NonNullable<AccountEntry['mailboxes']>;
