import * as z from 'zod';
import { OUTGOING_ATTACHMENTS_LIMIT_BYTES } from '../mail/compose.js';
import type { Composition, OutgoingAttachment } from '../mail/write-types.js';

// Input fields of the tools that compose mail, worded after Claude's Gmail connector (D13).

export const ATTACHMENT_LIMIT_MB = String(OUTGOING_ATTACHMENTS_LIMIT_BYTES / (1024 * 1024));

export const addressListSchema = z.array(z.email());

export const attachmentSchema = z.object({
  content: z.base64().describe('The base64-encoded content of the file.'),
  filename: z
    .string()
    .optional()
    .describe('File name shown to recipients, e.g. "invoice.pdf", for regular and inline files.'),
  mimeType: z
    .string()
    .optional()
    .describe('IANA media type; defaults to "application/octet-stream".'),
  inline: z
    .boolean()
    .default(false)
    .describe(
      'true: an inline image shown inside htmlBody, not listed as a file. Reference it from htmlBody with <img src="cid:attN">, where N is its zero-based position in attachments, counting all attachments (a PDF followed by an inline PNG: cid:att1). Do not reference it by filename.',
    ),
});

type AttachmentInput = z.infer<typeof attachmentSchema>;

export const attachmentsDescription = `Files to attach. Together at most ${ATTACHMENT_LIMIT_MB} MB decoded.`;

const addresses = (role: string) =>
  addressListSchema.describe(`${role} recipients; each a plain email address (user@example.com).`);

/** The fields of a new message (D13). */
export const compositionFields = {
  to: addresses('Primary').default([]),
  cc: addresses('Carbon copy').default([]),
  bcc: addresses('Blind carbon copy').default([]),
  subject: z.string().default('').describe('Subject line; empty if not given.'),
  body: z
    .string()
    .optional()
    .describe(
      'Plain text body. Do NOT format it with Markdown (no # headers, ** bold, * bullets or | tables); use htmlBody for rich text. With htmlBody it is the plain-text alternative.',
    ),
  htmlBody: z
    .string()
    .optional()
    .describe(
      'HTML body, the rich-text version of the mail. Use valid HTML tags (p, b, ul, li, h1) for formatting.',
    ),
  attachments: z.array(attachmentSchema).default([]).describe(attachmentsDescription),
  includeSignature: z
    .boolean()
    .default(false)
    .describe(
      "Append the signature from the account's configuration (nothing if it has none). Defaults to false.",
    ),
};

export function toOutgoing(attachments: AttachmentInput[]): OutgoingAttachment[] {
  return attachments.map((a) => ({
    content: a.content,
    filename: a.filename,
    mimeType: a.mimeType,
    inline: a.inline,
  }));
}

/** The parsed fields of a new message. */
export type CompositionInput = z.infer<z.ZodObject<typeof compositionFields>>;

export function toComposition(args: CompositionInput): Composition {
  return {
    to: args.to,
    cc: args.cc,
    bcc: args.bcc,
    subject: args.subject,
    body: args.body,
    htmlBody: args.htmlBody,
    attachments: toOutgoing(args.attachments),
    includeSignature: args.includeSignature,
  };
}
