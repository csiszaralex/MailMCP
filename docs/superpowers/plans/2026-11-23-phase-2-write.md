# MailMCP: 2. fázis (írás, rendszerezés, küldés) implementációs terv

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A lokális szerver megkapja a spec 12 író eszközét (piszkozatok, címkék, mappák, kuka, spam, küldés, válasz, továbbítás), a fiókonkénti `read`/`draft`/`send` szinttel szűrve. Hitelesítés továbbra sincs, a szerver csak `127.0.0.1`-en figyel.

**Architecture:** Az olvasó `ImapMailProvider` mellé egy `ImapMailWriter` kerül, amely ugyanazt az `ImapPool`-t használja. A közös mappazárolás és szálkeresés külön modulba költözik. A levelet a `src/mail/compose.ts` állítja össze a nodemailer `MailComposer`-ével, a küldést egy injektált `SmtpSend` függvény végzi (élesben TLS, tesztben a GreenMail plaintext portja). A tool réteg a fiókok szintje alapján regisztrálja az író eszközöket, és id alapú hívásnál az id fiókjának szintjét is ellenőrzi.

**Tech Stack:** az 1. fázisé, plusz `nodemailer` 10.6.1 (saját típusokkal, `@types/nodemailer` nem kell).

**Spec:** [`docs/superpowers/specs/2026-11-22-mailmcp-design.md`](../specs/2026-11-22-mailmcp-design.md), különösen az „Írás, rendszerezés és küldés” fejezet (D12-D25).

---

## Global Constraints

Az 1. fázis tervének Global Constraints része változatlanul érvényes (commit kapu, nincs AI attribution, függőség csak csomagkezelővel, TypeScript 6.0.3, `any` tilos, `unknown` csak a `src/boundary.ts`-ben, ESM `.js` importok, log csak stderr-re, TLS kötelező, nyelvi szabályok). Ezen felül:

- **Írás csak írható zárral:** `getMailboxLock(path)` `readOnly` nélkül, kizárólag az író kódban. Az olvasó kód `readOnly: true` zárja nem változik.
- **EXPUNGE csak UIDPLUS-szal, áthelyezés csak MOVE-val** (D17). A képességet a művelet **előtt** kell ellenőrizni, hogy hiányzó képességnél semmi ne változzon a postafiókban.
- **Nincs végleges törlés** a piszkozat régi verzióján és az elküldött piszkozaton kívül (D16, D17, D18).
- **A nodemailer soha nem olvas fájlt és nem hív URL-t:** minden `MailComposer` és transport `disableFileAccess: true`, `disableUrlAccess: true` opcióval készül, a mellékletek csak `content: Buffer` alakban mennek be (D12).
- **Bcc soha nem kerül a kiküldött levélbe.** A Sent másolatba és a piszkozatba igen (`keepBcc: true`), a SMTP-n küldött nyers levélbe nem.
- **Naplóba címzett, tárgy, törzs és melléklet nem kerül.** Az író eszközök ugyanazt a `LogRecord`-ot írják, mint az olvasók: eszköz, fiók, id, eredmény, kód, időtartam.
- **Tesztlevél** valódi címre csak a kézi próbán megy, és csak Alex saját `+mailmcp-<bármi>` címére. A címet a repó nem tartalmazza. Az automatikus tesztek csak a GreenMail `example.com` felhasználóinak küldenek.
- **Ellenőrzés:** minden factual állítást, amit kommentbe vagy dokumentumba írsz, vess össze a kóddal, a tervben szereplő állításokat is.

## Könyvtár tények (mérve 2026-11-23)

- **nodemailer 10.6.1** (ESM, `dist/esm/*.d.ts`): `import MailComposer from 'nodemailer/lib/mail-composer'`, `new MailComposer(options).compile()` egy `MimeNode`-ot ad; `node.keepBcc = true` után a `build(): Promise<Buffer>` a Bcc fejlécet is kiírja. Opciók: `from`, `to`, `cc`, `bcc`, `subject`, `text`, `html`, `attachments: [{ content, filename, contentType, cid }]`, `inReplyTo`, `references`, `messageId`, `date`, `disableFileAccess`, `disableUrlAccess`. `cid`-del a melléklet a HTML melletti `multipart/related` részbe kerül. SMTP: `createTransport({ host, port, secure, requireTLS, auth, tls, connectionTimeout, greetingTimeout, socketTimeout, logger, debug })`, `transport.sendMail({ envelope: { from, to }, raw })`, `transport.close()`. A `logger` típusa `ExternalLogger | boolean` (`any` paraméterekkel).
- **imapflow 2.12.2** író API: `append(path, content, flags?, idate?) → AppendResponseObject | false` (`uid`, `uidValidity` UIDPLUS-szal); `messageMove(range, dest, { uid: true }) → CopyResponseObject | false` (`uidMap: Map<number, number>`, `uidValidity`); `messageFlagsAdd/Remove(range, flags, { uid: true, useLabels? }) → boolean`; `messageDelete(range, { uid: true }) → boolean`; `mailboxCreate(path)`, `mailboxRename(path, newPath)`, `mailboxDelete(path)`; `status(path, { messages: true }) → StatusObject`; `capabilities: Map<string, boolean | number>`. A `Logger` interfész `debug/info/warn/error(obj: any)`.
- **imapflow veszély:** a `messageDelete` UIDPLUS nélkül sima `EXPUNGE`-t küld, a `messageMove` MOVE nélkül COPY, `\Deleted` és ugyanilyen EXPUNGE (lásd spec „Mért tények”).
- **GreenMail 2.1.15:** `UIDPLUS`, `MOVE` van, SPECIAL-USE nincs, alapból csak INBOX. SMTP plaintext port: 3025. Több felhasználó: `-Dgreenmail.users=alice:secret@example.com,bob:secret@example.com`.
- **MCP SDK 2.4.0:** `createMcpHandler(factory, { maxRequestBodySize })`, alapérték 4 MiB, a túl nagy kérésre `413`.

## Review Focus

A spec által sejtetett, de egy task teszt nélkül könnyen elcsúszó esetek. Mindegyikhez a gazda task teszte tartozik.

1. **Bcc szivárgás:** a To és Cc címzett által kapott levélben nincs Bcc fejléc, a Sent másolatban van. Teszt: Task 3 (`buildMime` keepBcc nélkül és vele), Task 8 (GreenMail: bob INBOX-ában nincs Bcc, alice Sent-jében van).
2. **Saját cím a válaszban:** `replyAll` a fiók `+címkés` alakját és a kis-nagybetűs változatát sem teszi a címzettek közé; saját küldött levélre adott válasz az eredeti címzetteknek megy. Teszt: Task 2, Task 8.
3. **Hiányzó UIDPLUS vagy MOVE:** `unsupported_server`, és a postafiók nem változik (nincs APPEND, nincs STORE). Teszt: Task 4 (`requireCapability`), Task 6 és 7 (hamis kliens, amely a hívásokat rögzíti).
4. **Félig sikerült írás:** az új piszkozat feltöltődött, de a régi eltávolítása nem sikerült; vagy a levél elment, de a Sent másolat nem. A válasz sikeres, `warnings` mezővel, és nem hiba, mert egy duplikátum jobb, mint egy elveszett vagy kétszer elküldött levél. Teszt: Task 6, Task 8.
5. **Szint megkerülése:** a `/mcp` végponton egy `read` szintű fiók id-jével hívott író eszköz `not_permitted` hibát ad, és a provider meg sem hívódik. Teszt: Task 9.

Ékezetes tárgy és fájlnév (`Számla ő ű.pdf`) helyes kódolása: Task 3.

---

## Fájlszerkezet (2. fázis)

| Fájl | Felelősség |
|---|---|
| `src/config/levels.ts` (új) | Szintek sorrendje, `levelAllows`, `assertLevel` |
| `src/mail/addresses.ts` (új) | Saját cím felismerése (D20), válaszcímzettek (D19) |
| `src/mail/write-types.ts` (új) | `MailWriter` interfész és bemeneti/kimeneti típusai |
| `src/mail/compose.ts` (új) | Mellékletek dekódolása és korlátja (D14), aláírás, idézés, továbbítási blokk, `buildMime` |
| `src/mail/stored.ts` (új) | Tárolt levél (piszkozat, továbbítandó eredeti) beolvasása `MimeSpec`-hez |
| `src/imap/client.ts` | `ImapClient` bővül az író metódusokkal és a `capabilities`-szel |
| `src/imap/mailbox-lock.ts` (új) | `withMailbox` (az `ImapMailProvider`-ből kiemelve, írható zárral is), `requireCapability` |
| `src/mail/thread-locate.ts` (új) | Egy szál mappája és keresési feltétele (a `getThread`-ből kiemelve) |
| `src/smtp/sender.ts` (új) | `SmtpSend` típus, TLS beállítások, éles küldő |
| `src/mail/imap-writer.ts` (új) | `ImapMailWriter`: piszkozat, címke, mappa, kuka, spam, küldés |
| `src/tools/scope.ts` (új) | A `read-tools.ts`-ből kiemelt hatókör segédek, szintszűrés |
| `src/tools/compose-schema.ts` (új) | A levélösszeállítás zod sémái (D13) |
| `src/tools/write-tools.ts` (új) | `draft` szintű eszközök |
| `src/tools/send-tools.ts` (új) | `send` szintű eszközök |
| `src/server.ts`, `src/http/app.ts`, `src/main.ts` | Regisztráció, kérésméret, bekötés, hibakereső kapcsoló |
| `src/boundary.ts` | Protokoll hibakereső napló (az `any` paraméterű könyvtári loggerekhez) |

---

### Task 1: Hibakódok, Archive mappa, szintek

**Files:**
- Modify: `src/errors.ts`, `src/config/schema.ts`, `src/search/query.ts` (`SpecialUse`), `src/imap/mailboxes.ts` (`OVERRIDE_KEY`), `src/config/load.ts`
- Create: `src/config/levels.ts`
- Test: `tests/unit/config.test.ts`, `tests/unit/levels.test.ts` (új), `tests/unit/mailboxes.test.ts`

**Interfaces:**
- Produces:
  - `MailErrorCode` új értékei: `'not_permitted' | 'unsupported_server' | 'send_failed'`, mindegyik egysoros kommenttel a spec szerint.
  - `SpecialUse` bővül: `'\\Archive'`; `MailboxOverrides` bővül: `archive?: string`.
  - `src/config/levels.ts`: `export function levelAllows(have: AccessLevel, need: AccessLevel): boolean` (sorrend `read < draft < send`), `export function assertLevel(account: Account, need: AccessLevel): void` (`not_permitted`, üzenet: ``Account "${id}" has level ${have}; this tool needs ${need}.``).
  - `src/config/load.ts`: `export function parseDebug(value: string | undefined): boolean`: `undefined` és `'0'` hamis, `'1'` igaz, minden más `config_invalid` (``MAILMCP_DEBUG must be 0 or 1, got "${value}".``).

- [ ] **Step 1: Írd meg a bukó teszteket**

```ts
// tests/unit/levels.test.ts
it('orders read < draft < send', () => {
  expect(levelAllows('send', 'draft')).toBe(true);
  expect(levelAllows('draft', 'draft')).toBe(true);
  expect(levelAllows('draft', 'send')).toBe(false);
  expect(levelAllows('read', 'draft')).toBe(false);
});
it('rejects a too low level with not_permitted', () => {
  expect(() => assertLevel({ ...account, level: 'read' }, 'draft')).toThrow(
    expect.objectContaining({ code: 'not_permitted' }),
  );
});
```

`tests/unit/config.test.ts`: egy `mailboxes: { archive: Archive }` fiók betöltődik, `accounts[0].mailboxes.archive === 'Archive'`. `parseDebug(undefined) === false`, `parseDebug('1') === true`, `parseDebug('yes')` `config_invalid`.

`tests/unit/mailboxes.test.ts`: `resolveMailbox(client, { kind: 'special', use: '\\Archive' }, { archive: 'Old' })` → `'Old'`; override nélkül és `\Archive` listaelem nélkül `mailbox_not_found`, az üzenetben `mailboxes.archive`.

- [ ] **Step 2: Futtasd, bukjon:** `pnpm exec vitest run tests/unit/levels.test.ts tests/unit/config.test.ts tests/unit/mailboxes.test.ts`, várt: FAIL (hiányzó modul és mezők).
- [ ] **Step 3: Implementáld** a fenti aláírásokat. A `SpecialUse` bővítése után a `query.ts` `IN_ALIASES` táblája nem kap új `in:` aliast (a spec nem sorolja fel).
- [ ] **Step 4: Futtasd:** `pnpm test:unit && pnpm typecheck && pnpm lint`, várt: PASS.
- [ ] **Step 5: Stage, állj meg**

```bash
git add src/errors.ts src/config/schema.ts src/config/load.ts src/config/levels.ts src/search/query.ts src/imap/mailboxes.ts tests/unit/levels.test.ts tests/unit/config.test.ts tests/unit/mailboxes.test.ts
```

Javasolt üzenet: `feat(config): add access level checks, archive mailbox and debug switch`.

---

### Task 2: Saját cím és válaszcímzettek

**Files:**
- Create: `src/mail/addresses.ts`
- Test: `tests/unit/addresses.test.ts`

**Interfaces:**
- Consumes: `Account`, `Address` (`src/mail/types.ts`).
- Produces:
  - `export function addressKey(address: string, provider: Account['provider']): string`: kisbetű, a helyi rész `+` utáni része elhagyva; `provider === 'gmail'` és `gmail.com`/`googlemail.com` domain esetén a helyi rész pontjai is elhagyva, és a domain `gmail.com`.
  - `export function isOwnAddress(account: Account, address: string): boolean`: `addressKey(address) === addressKey(account.address)`.
  - `export interface ReplySource { from: Address[]; to: Address[]; cc: Address[]; replyTo: Address[] }`
  - `export function replyRecipients(source: ReplySource, account: Account, replyAll: boolean): { to: Address[]; cc: Address[] }`

Szabályok (D19): ha a `from` saját cím, a `to` az eredeti `to`, a `cc` replyAll esetén az eredeti `cc`. Különben a `to` a `replyTo`, ha nem üres, egyébként a `from`; replyAll esetén a `cc` az eredeti `to` és `cc`. Mindkét listából kiesnek a saját címek, és `addressKey` szerint az ismétlődések (az első előfordulás marad, a `cc`-ből az is, ami a `to`-ban már szerepel).

- [ ] **Step 1: Bukó tesztek** (fiók: `asd@example.org`, `provider: 'imap'`; Gmail fiók: `first.last@gmail.com`)

```ts
it('treats plus tags and case as the same mailbox', () => {
  expect(isOwnAddress(imapAccount, 'ASD+news@Example.org')).toBe(true);
  expect(isOwnAddress(imapAccount, 'asd.x@example.org')).toBe(false);
});
it('ignores dots and googlemail.com only for Gmail addresses', () => {
  expect(isOwnAddress(gmailAccount, 'firstlast+x@googlemail.com')).toBe(true);
  expect(addressKey('first.last@example.org', 'gmail')).toBe('first.last@example.org');
});
it('replies to Reply-To before From', () => { /* to == replyTo */ });
it('reply all adds to and cc without own addresses or duplicates', () => {
  const r = replyRecipients(
    { from: [bob], replyTo: [], to: [{ name: '', address: 'asd+tag@example.org' }, carol], cc: [bob, dave] },
    imapAccount, true,
  );
  expect(r.to.map((a) => a.address)).toEqual(['bob@example.org']);
  expect(r.cc.map((a) => a.address)).toEqual(['carol@example.org', 'dave@example.org']);
});
it('a reply to our own message goes to its recipients', () => { /* from == own → to == original to */ });
```

- [ ] **Step 2: Futtasd, bukjon:** `pnpm exec vitest run tests/unit/addresses.test.ts`.
- [ ] **Step 3: Implementáld.**
- [ ] **Step 4: Futtasd:** `pnpm test:unit && pnpm typecheck && pnpm lint`.
- [ ] **Step 5: Stage, állj meg:** `git add src/mail/addresses.ts tests/unit/addresses.test.ts`. Javasolt üzenet: `feat(mail): recognise own addresses when choosing reply recipients`.

---

### Task 3: Levél összeállítása

**Files:**
- Create: `src/mail/write-types.ts`, `src/mail/compose.ts`
- Modify: `package.json`, `pnpm-lock.yaml` (`pnpm add nodemailer@10.6.1`)
- Test: `tests/unit/compose.test.ts`

**Interfaces:**
- Produces (`src/mail/write-types.ts`), a többi task ezeket használja:

```ts
export interface OutgoingAttachment {
  /** base64 */
  content: string;
  filename: string | undefined;
  mimeType: string | undefined;
  inline: boolean;
}
export interface Composition {
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  body: string | undefined;
  htmlBody: string | undefined;
  attachments: OutgoingAttachment[];
  includeSignature: boolean;
}
/** update_draft: omitted fields keep the draft's value; attachments are replaced, never merged (D16). */
export interface DraftPatch {
  to?: string[]; cc?: string[]; bcc?: string[]; subject?: string;
  body?: string; htmlBody?: string;
  attachments: OutgoingAttachment[];
}
export interface ReplyInput {
  body: string | undefined; htmlBody: string | undefined;
  attachments: OutgoingAttachment[]; includeSignature: boolean;
  replyAll: boolean;
  /** Override the computed recipients when given. */
  to: string[] | undefined; cc: string[] | undefined;
  bcc: string[];
}
export interface ForwardInput {
  to: string[]; cc: string[]; bcc: string[];
  forwardText: string | undefined; htmlBody: string | undefined;
  attachments: OutgoingAttachment[]; includeSignature: boolean;
}
export type WriteTarget = { kind: 'message'; ref: MessageRef } | { kind: 'thread'; ref: ThreadRef };
export interface LabelChange { add: string[]; remove: string[] }
export type LabelAction =
  | { action: 'create'; name: string }
  | { action: 'rename'; name: string; newName: string }
  | { action: 'delete'; name: string };
export interface DraftOutcome { draftId: string; threadId: string; warnings: string[] }
export interface MoveOutcome { messageIds: string[]; warnings: string[] }
export interface SendOutcome { messageIdHeader: string; sentCopyId: string | null; warnings: string[] }
export interface MailWriter {
  readonly account: Account;
  createDraft(c: Composition, replyTo: MessageRef | undefined): Promise<DraftOutcome>;
  updateDraft(ref: MessageRef, patch: DraftPatch): Promise<DraftOutcome>;
  deleteDraft(ref: MessageRef): Promise<MoveOutcome>;
  updateLabels(target: WriteTarget, change: LabelChange): Promise<MoveOutcome>;
  manageLabel(action: LabelAction): Promise<void>;
  trash(target: WriteTarget): Promise<MoveOutcome>;
  untrash(target: WriteTarget): Promise<MoveOutcome>;
  markSpam(target: WriteTarget): Promise<MoveOutcome>;
  unmarkSpam(target: WriteTarget): Promise<MoveOutcome>;
  send(c: Composition): Promise<SendOutcome>;
  sendDraft(ref: MessageRef): Promise<SendOutcome>;
  reply(ref: MessageRef, input: ReplyInput): Promise<SendOutcome>;
  forward(ref: MessageRef, input: ForwardInput): Promise<SendOutcome>;
}
```

- Produces (`src/mail/compose.ts`):
  - `export const OUTGOING_ATTACHMENTS_LIMIT_BYTES = 10 * 1024 * 1024;` (D14, egyetlen helyen)
  - `export interface MimeAttachment { content: Buffer; filename: string | undefined; contentType: string; cid: string | undefined }`
  - `export function decodeAttachments(list: OutgoingAttachment[]): MimeAttachment[]`: base64 dekódolás; `contentType` alapból `application/octet-stream`; `inline: true` esetén `cid: \`att${index}\`` (az index a teljes listában számolva, D13); összméret ellenőrzés nincs itt.
  - `export function assertAttachmentBudget(attachments: readonly MimeAttachment[]): void`: a dekódolt méretek összege `> OUTGOING_ATTACHMENTS_LIMIT_BYTES` → `too_large` (``Attachments total ${n} bytes; the limit is ${limit} bytes.``).
  - `export interface MimeSpec { from: string; to: Address[]; cc: Address[]; bcc: Address[]; subject: string; text: string | undefined; html: string | undefined; attachments: MimeAttachment[]; inReplyTo: string | undefined; references: string[]; messageId: string; date: Date }`
  - `export function buildMime(spec: MimeSpec, options: { keepBcc: boolean }): Promise<Buffer>`: `MailComposer` `disableFileAccess: true`, `disableUrlAccess: true`; a `buildMime` maga is meghívja az `assertAttachmentBudget`-et. Ha `text` és `html` is `undefined`, a `text` üres szöveg.
  - `export function newMessageId(account: Account): string`: `` `<${randomUUID()}@${domain}>` ``, a domain a fiók címéből.
  - `export function withSignature(text: string | undefined, html: string | undefined, signature: string | undefined): { text: string | undefined; html: string | undefined }`: `text` végére `\n\n-- \n<signature>`; `html` végére `<br><br>-- <br>` és a HTML-escape-elt aláírás, sortörései `<br>`-re cserélve. `signature === undefined` esetén változatlan.
  - `export interface QuotedOriginal { from: Address[]; date: string | null; subject: string; to: Address[]; text: string; html: string | undefined }`
  - `export function quoteReply(original: QuotedOriginal, text: string | undefined, html: string | undefined): { text: string | undefined; html: string | undefined }` (D19): a saját szöveg után `\n\nOn <date>, <from> wrote:\n` és az eredeti sorai `> ` előtaggal; HTML-nél `<blockquote>` (az eredeti HTML-je, ha van, különben az escape-elt szöveg `<br>`-ekkel). A `from` formája `Name <address>`.
  - `export function forwardBody(original: QuotedOriginal, text: string | undefined, html: string | undefined): { text: string; html: string | undefined }` (D21): `---------- Forwarded message ---------` blokk `From:`, `Date:`, `Subject:`, `To:` sorokkal, utána az eredeti szöveg.
  - `export function prefixSubject(prefix: 'Re:' | 'Fwd:', subject: string): string`: nem duplázza, ha a tárgy kis-nagybetűtől függetlenül már így kezdődik.

- [ ] **Step 1: `pnpm add nodemailer@10.6.1`**, majd `pnpm exec tsc --noEmit`, várt: PASS (a típusok a csomagban vannak).
- [ ] **Step 2: Bukó tesztek** (`simpleParser`-rel olvasd vissza a `buildMime` kimenetét)

```ts
it('leaves Bcc out unless keepBcc', async () => {
  const sent = await simpleParser(await buildMime(spec({ bcc: [eve] }), { keepBcc: false }));
  expect(sent.bcc).toBeUndefined();
  const copy = await simpleParser(await buildMime(spec({ bcc: [eve] }), { keepBcc: true }));
  expect(textOf(copy.bcc)).toContain('eve@example.org');
});
it('encodes accented subjects and file names', async () => {
  const parsed = await simpleParser(await buildMime(spec({
    subject: 'Számla ő ű',
    attachments: decodeAttachments([{ content: b64('pdf'), filename: 'Számla ő ű.pdf', mimeType: 'application/pdf', inline: false }]),
  }), { keepBcc: false }));
  expect(parsed.subject).toBe('Számla ő ű');
  expect(parsed.attachments[0]?.filename).toBe('Számla ő ű.pdf');
});
it('numbers inline attachments as attN over the whole list', () => {
  const [pdf, png] = decodeAttachments([pdfAttachment, { ...pngAttachment, inline: true }]);
  expect(pdf?.cid).toBeUndefined();
  expect(png?.cid).toBe('att1');
});
it('refuses attachments over the limit', async () => {
  const big = { content: Buffer.alloc(OUTGOING_ATTACHMENTS_LIMIT_BYTES + 1), filename: 'big.bin', contentType: 'application/octet-stream', cid: undefined };
  await expect(buildMime(spec({ attachments: [big] }), { keepBcc: false })).rejects.toMatchObject({ code: 'too_large' });
});
it('sets reply headers', async () => { /* inReplyTo, references round-trip */ });
it('quotes the original below the reply', () => {
  expect(quoteReply(original, 'Thanks', undefined).text).toBe(
    'Thanks\n\nOn 2026-11-10T08:00:00.000Z, Bob <bob@example.org> wrote:\n> line one\n> line two',
  );
});
it('escapes the signature in html', () => {
  expect(withSignature(undefined, '<p>Hi</p>', 'A & B\nAlex').html).toBe('<p>Hi</p><br><br>-- <br>A &amp; B<br>Alex');
});
it('does not stack Re: prefixes', () => { expect(prefixSubject('Re:', 'RE: x')).toBe('RE: x'); });
it('forwards with a header block', () => { /* text contains '---------- Forwarded message ---------' and 'Subject: Inner' */ });
```

- [ ] **Step 3: Futtasd, bukjon:** `pnpm exec vitest run tests/unit/compose.test.ts`.
- [ ] **Step 4: Implementáld.** A `MailComposer` import típusa a csomag `dist/esm/mail-composer/index.d.ts`-éből jön; ha a fordító default importot nem fogad el, a csomag `exports` szerinti útvonalat (`nodemailer/lib/mail-composer`) tartsd, és `as` cast helyett a típusdefiníció szerinti importformát keresd meg.
- [ ] **Step 5: Futtasd:** `pnpm test:unit && pnpm typecheck && pnpm lint && pnpm build`.
- [ ] **Step 6: Stage, állj meg:** `git add package.json pnpm-lock.yaml src/mail/write-types.ts src/mail/compose.ts tests/unit/compose.test.ts`. Javasolt üzenet: `feat(mail): compose outgoing MIME messages`.

---

### Task 4: Az IMAP író felület és a közös zárolás

Refaktor és bővítés, viselkedésváltozás nélkül az olvasó oldalon.

**Files:**
- Modify: `src/imap/client.ts`, `src/mail/imap-provider.ts`
- Create: `src/imap/mailbox-lock.ts`, `src/mail/thread-locate.ts`
- Test: `tests/unit/mailbox-lock.test.ts` (új), a meglévő hamis kliensek (`tests/unit/imap-provider.test.ts`, `tests/unit/gmail-provider.test.ts`, `tests/unit/pool.test.ts`) kiegészítése

**Interfaces:**
- Produces:
  - `ImapClient` új tagjai (az imapflow aláírásai szerint, a fenti „Könyvtár tények” alapján): `readonly capabilities: Map<string, boolean | number>`, `append`, `messageMove`, `messageFlagsAdd`, `messageFlagsRemove`, `messageDelete`, `mailboxCreate`, `mailboxRename`, `mailboxDelete`, `status`. Az `ImapFlow` példánynak továbbra is strukturálisan meg kell felelnie (a `tlsConnector` cast nélkül adja vissza).
  - `src/imap/mailbox-lock.ts`:
    - `export type LockAccess = 'read' | 'write';`
    - `export async function withMailbox<T>(client: ImapClient, path: string, opts: { access: LockAccess; from: 'query' | 'id' }, fn: (uidValidity: string) => Promise<T>): Promise<T>`: a mostani `ImapMailProvider#withMailbox` törzse; `access: 'read'` → `{ readOnly: true }`, `'write'` → opció nélkül.
    - `export function requireCapability(client: ImapClient, capability: 'UIDPLUS' | 'MOVE', action: string): void`: hiányzó képességnél `unsupported_server`, üzenet: ``The mail server does not support ${capability}, which ${action} needs.``
  - `src/mail/thread-locate.ts`: `export async function threadLocation(client: ImapClient, account: Account, ref: ThreadRef, mailbox?: string): Promise<{ path: string; criteria: SearchObject }>`: a mostani `getThread` mappa- és feltételválasztása (Gmail: `\All` és `{ threadId }`; más: `ref.mailbox` és a Message-ID/References `or`; üres gyökérnél a mostani `not_found`). A `mailbox` paraméter felülírja a mappát (a kukából vagy spamből visszaállításhoz, Task 7).
  - `ImapMailProvider` ezeket használja; a saját `#withMailbox` törlődik.

- [ ] **Step 1: Bukó tesztek** (`tests/unit/mailbox-lock.test.ts`)

```ts
it('locks read-only for reads and read-write for writes', async () => {
  await withMailbox(fake, 'INBOX', { access: 'read', from: 'query' }, () => Promise.resolve());
  await withMailbox(fake, 'INBOX', { access: 'write', from: 'id' }, () => Promise.resolve());
  expect(fake.locks).toEqual([{ path: 'INBOX', options: { readOnly: true } }, { path: 'INBOX', options: undefined }]);
});
it('refuses a missing capability with unsupported_server', () => {
  expect(() => requireCapability(fakeWith(['MOVE']), 'UIDPLUS', 'update_draft')).toThrow(
    expect.objectContaining({ code: 'unsupported_server' }),
  );
});
```

- [ ] **Step 2: Futtasd, bukjon.**
- [ ] **Step 3: Implementáld**, és a meglévő hamis klienseket egészítsd ki az új tagokkal (nem használt metódus: `() => Promise.reject(new Error('not used in this test'))`, `capabilities: new Map()`). Ha három tesztfájl ugyanazt a kiegészítést kapja, emeld ki egy `tests/unit/fake-imap.ts` segédbe.
- [ ] **Step 4: Futtasd:** `pnpm test && pnpm typecheck && pnpm lint` (a GreenMail tesztek is, hogy az olvasás nem változott).
- [ ] **Step 5: Stage, állj meg:** a módosított és új fájlok explicit útvonallal. Javasolt üzenet: `refactor(imap): share mailbox locking and thread lookup with the writer`.

---

### Task 5: SMTP küldő

**Files:**
- Create: `src/smtp/sender.ts`
- Modify: `tests/integration/greenmail.ts` (SMTP port, második felhasználó, plaintext küldő)
- Test: `tests/unit/smtp-sender.test.ts`

**Interfaces:**
- Produces:
  - `export interface Envelope { from: string; to: string[] }`
  - `export type SmtpSend = (account: Account, raw: Buffer, envelope: Envelope) => Promise<void>;`
  - `export const SMTP_CONNECTION_TIMEOUT_MS = 15_000; export const SMTP_SOCKET_TIMEOUT_MS = 60_000;`
  - `export function smtpTransportOptions(account: Account, password: string, debug: boolean): SMTPTransport.Options`: 465 → `secure: true`; minden más port → `secure: false, requireTLS: true`; `tls: { rejectUnauthorized: true, minVersion: 'TLSv1.2' }`; `auth: { user: account.username, pass }`; `connectionTimeout` és `greetingTimeout`: `SMTP_CONNECTION_TIMEOUT_MS`; `socketTimeout`: `SMTP_SOCKET_TIMEOUT_MS`; `disableFileAccess: true`, `disableUrlAccess: true`; `debug` esetén `logger: protocolDebugLogger('smtp', account.id)` és `debug: true`, különben `logger: false`.
  - `export function tlsSmtpSender(passwordFor: PasswordLookup, debug: boolean): SmtpSend`: hívásonként új transport, `sendMail({ envelope, raw })`, `finally` ágban `close()`. Hibánál `MailError('send_failed', …)`, az üzenetben csak a host, a fiók és a nodemailer `code`/`responseCode` értéke, a szerver válaszszövege nem (címet tartalmazhat), `cause`-ként az eredeti hiba.
  - `src/boundary.ts`: `export function protocolDebugLogger(protocol: 'imap' | 'smtp', accountId: string)`: objektum `trace/debug/info/warn/error/fatal` metódusokkal, mindegyik egy JSON sort ír a stderr-re (`{ time, debug: protocol, account, entry }`). Itt `unknown[]` paraméterrel, mert a két könyvtár `any`-t ad át (Global Constraints: `unknown` csak itt).
  - `tests/integration/greenmail.ts`: `GreenMail` kiegészül: `smtpPort: number`, `bob: Account` (második fiók `bob@example.com`), `send: SmtpSend` (nodemailer `secure: false, ignoreTLS: true`, a fiók jelszavával; csak teszt), és a felhasználók listája `alice` és `bob`.

- [ ] **Step 1: Bukó tesztek**

```ts
it('uses implicit TLS on 465', () => {
  expect(smtpTransportOptions(acc(465), 'pw', false)).toMatchObject({ secure: true, tls: { rejectUnauthorized: true } });
});
it('requires STARTTLS on any other port', () => {
  expect(smtpTransportOptions(acc(587), 'pw', false)).toMatchObject({ secure: false, requireTLS: true });
});
it('never reads files or URLs and logs nothing unless debugging', () => {
  expect(smtpTransportOptions(acc(465), 'pw', false)).toMatchObject({ disableFileAccess: true, disableUrlAccess: true, logger: false });
});
```

- [ ] **Step 2: Futtasd, bukjon.**
- [ ] **Step 3: Implementáld.**
- [ ] **Step 4: Futtasd:** `pnpm test && pnpm typecheck && pnpm lint` (a GreenMail helper változása miatt a teljes csomag).
- [ ] **Step 5: Stage, állj meg.** Javasolt üzenet: `feat(smtp): send raw messages over TLS-only SMTP`.

---

### Task 6: Piszkozatok

**Files:**
- Create: `src/mail/imap-writer.ts`, `src/mail/stored.ts`
- Test: `tests/integration/imap-writer.int.test.ts` (új), `tests/unit/imap-writer.test.ts` (új)

**Interfaces:**
- Consumes: Task 1-5 mindene; `ImapPool.use`, `resolveMailbox`, `MailProvider.getMessage`.
- Produces:
  - `export class ImapMailWriter implements MailWriter { constructor(readonly account: Account, private readonly pool: ImapPool, private readonly reader: MailProvider, private readonly smtp: SmtpSend) }`. Ebben a taskban csak a `createDraft`, `updateDraft` és `deleteDraft` készül el, ezért az osztály `implements Pick<MailWriter, 'account' | 'createDraft' | 'updateDraft' | 'deleteDraft'>`; Task 7 bővíti a listát, Task 8 végén lesz `implements MailWriter`. Félkész, hibát dobó metódus nem kerül be.
  - `src/mail/stored.ts`:
    - `export const STORED_MESSAGE_LIMIT_BYTES = Math.ceil((OUTGOING_ATTACHMENTS_LIMIT_BYTES * 4) / 3) + 1024 * 1024;` (base64 többlet és a törzs)
    - `export interface StoredMessage { to: Address[]; cc: Address[]; bcc: Address[]; subject: string; text: string | undefined; html: string | undefined; attachments: MimeAttachment[]; inReplyTo: string | undefined; references: string[] }`
    - `export async function readStored(client: ImapClient, ref: MessageRef): Promise<StoredMessage>`: a hívó zárja a mappát; `size` alapján `STORED_MESSAGE_LIMIT_BYTES` fölött `too_large` letöltés előtt; `source` letöltés, `simpleParser`, a mellékletek `MimeAttachment`-té (a `cid` megmarad, a `contentId` szögletes zárójelek nélkül).
  - Viselkedés (D16, D17):
    - `createDraft(c, replyTo)`: `replyTo` esetén a `reader.getMessage(replyTo, 'plain')` (és `htmlBody` esetén `'html'`) adja az idézendő eredetit, a fejléceket (`messageIdHeader`, `References`) a writer olvassa ki egy `fetchOne(..., { headers: ['references'] })`-szal; tárgy `prefixSubject('Re:', eredeti)`, ha a `c.subject` üres. Aláírás `includeSignature` esetén. `buildMime(..., { keepBcc: true })`, APPEND a `\Drafts` mappába `['\\Draft', '\\Seen']` jelzőkkel. Az új id az APPEND `uid`/`uidValidity` értékéből; ha hiányzik (UIDPLUS nélkül), `requireCapability` már előtte megállította: a `createDraft` is UIDPLUS-t kér, mert id nélkül a piszkozat nem érhető el.
    - `updateDraft(ref, patch)`: előbb `requireCapability(client, 'UIDPLUS', 'update_draft')`, aztán `readStored`, összefésülés (`undefined` mező: a régi marad; `body` megadva `htmlBody` nélkül: a HTML törlődik, és fordítva, a connector szerint), új APPEND, végül a régi UID `messageDelete(String(uid), { uid: true })`-vel írható zárban. Ha az eltávolítás `false` vagy dob: a válasz sikeres, `warnings: ['The previous version of the draft could not be removed; delete it with delete_draft.']`.
    - `deleteDraft(ref)`: `requireCapability(client, 'MOVE', 'delete_draft')`, áthelyezés a `\Trash` mappába, az új id a `uidMap`-ből. Közös privát segéd: `#move(client, path, uids, destination): Promise<MoveOutcome>` (Task 7 is ezt használja); ha a `uidMap` egy UID-t nem tartalmaz, az kimarad és egy figyelmeztetés jelzi.
    - Minden id alapú metódus az 1. fázis mintájára `#assertOwn` és `assertCurrent` (UIDVALIDITY) ellenőrzéssel indul.

- [ ] **Step 1: Bukó integrációs tesztek** (GreenMail, `mailboxes: { drafts: 'Drafts', sent: 'Sent', trash: 'Trash', junk: 'Junk', archive: 'Archive' }`, a `seed` létrehozza a mappákat)

```ts
it('creates a draft that list_drafts and get_draft see', async () => {
  const out = await writer.createDraft(composition({ to: ['bob@example.com'], subject: 'Plan', body: 'Draft body' }), undefined);
  const draft = await reader.getMessage(decodeMessageId(out.draftId), 'plain');
  expect(draft.subject).toBe('Plan');
  expect(draft.flags).toEqual(expect.arrayContaining(['\\Draft', '\\Seen']));
});
it('keeps Bcc in the stored draft', async () => { /* raw format contains 'Bcc: eve@example.com' */ });
it('creates a reply draft with quoting and threading headers', async () => { /* replyTo = m1: subject 'Re: Invoice 2026-11', In-Reply-To <m1@example.com>, body contains '> Please find the invoice attached.' */ });
it('updates only the given fields and returns a new id', async () => {
  const first = await writer.createDraft(composition({ to: ['bob@example.com'], subject: 'Old', body: 'Old body' }), undefined);
  const second = await writer.updateDraft(decodeMessageId(first.draftId), { subject: 'New', attachments: [] });
  expect(second.draftId).not.toBe(first.draftId);
  const draft = await reader.getMessage(decodeMessageId(second.draftId), 'plain');
  expect([draft.subject, draft.body?.trim(), draft.to[0]?.address]).toEqual(['New', 'Old body', 'bob@example.com']);
  await expect(reader.getMessage(decodeMessageId(first.draftId), 'plain')).rejects.toMatchObject({ code: 'not_found' });
});
it('moves a deleted draft to the trash', async () => { /* in:trash search finds it, Drafts no longer */ });
```

Unit (`tests/unit/imap-writer.test.ts`, hamis kliens, amely minden hívást rögzít):

```ts
it('changes nothing when UIDPLUS is missing', async () => {
  await expect(writer(fakeWith(['MOVE'])).updateDraft(ref, { subject: 'x', attachments: [] })).rejects.toMatchObject({ code: 'unsupported_server' });
  expect(fake.calls.filter((c) => ['append', 'messageDelete', 'messageMove'].includes(c))).toEqual([]);
});
it('reports a failed removal of the old version as a warning', async () => {
  // messageDelete resolves false
  expect((await w.updateDraft(ref, patch)).warnings).toHaveLength(1);
});
```

- [ ] **Step 2: Futtasd, bukjon:** `pnpm exec vitest run tests/integration/imap-writer.int.test.ts tests/unit/imap-writer.test.ts`.
- [ ] **Step 3: Implementáld.** Ha a GreenMail valamiben eltér a várttól, előbb mérd meg (egy rövid próba a tesztben), és a tesztet csak a mért szerverviselkedéshez igazítsd, a `src`-t ne.
- [ ] **Step 4: Futtasd:** `pnpm test && pnpm typecheck && pnpm lint`.
- [ ] **Step 5: Stage, állj meg.** Javasolt üzenet: `feat(mail): create, update and delete drafts over IMAP`.

---

### Task 7: Címkék, mappák, kuka, spam

**Files:**
- Modify: `src/mail/imap-writer.ts`
- Test: `tests/integration/imap-writer.int.test.ts`, `tests/unit/gmail-writer.test.ts` (új)

**Interfaces:**
- Produces: `updateLabels`, `manageLabel`, `trash`, `untrash`, `markSpam`, `unmarkSpam` (aláírás: `MailWriter`).
- Közös: `#targetUids(client, target, mailbox?)`: üzenetnél `[ref.uid]` a `ref.mailbox`-ban (UIDVALIDITY ellenőrzéssel); szálnál `threadLocation` + `search`. Üres találat: `not_found`.
- Viselkedés:
  - **Gmail `updateLabels`** (D22): `UNREAD` hozzáadása `\Seen` levétele és fordítva; `STARRED` ↔ `\Flagged` jelző; `INBOX` → `\Inbox`, `IMPORTANT` → `\Important` címke; minden más név változatlanul címke. A címkék `messageFlagsAdd/Remove(uids, labels, { uid: true, useLabels: true })`, a jelzők `useLabels` nélkül, írható zárral a `\All` mappában. `TRASH` vagy `SPAM` név: `MailError('unsupported_query', 'Use trash or mark_spam to move messages to the trash or spam.')`. A válasz `messageIds` az érintett (változatlan) id-k.
  - **Nem Gmail `updateLabels`:** `UNREAD`, `STARRED` jelzőre fordul. Az `add`-ban legfeljebb egy mappa (minden más nem `UNREAD`/`STARRED` név mappa), ez áthelyezés oda (`MOVE` kell). A `remove`-ban az `INBOX` (és csak akkor, ha a levél az INBOX-ban van) áthelyezés a `\Archive` mappába. Bármi más (két mappa, az aktuálistól eltérő mappa levétele, mappa hozzáadása és INBOX levétele együtt): `MailError('unsupported_query', …)` a szabály megnevezésével. Jelző és áthelyezés együtt: előbb a jelző, aztán az áthelyezés. A válasz az új id-k.
  - **`manageLabel`** (D23): a `list()` alapján az INBOX és minden `specialUse`-zal rendelkező mappa átnevezése és törlése `MailError('not_permitted', 'System mailboxes cannot be renamed or deleted.')`. Nem Gmail fióknál törlés előtt `status(path, { messages: true })`; ha `messages > 0`: `MailError('not_permitted', 'The folder still holds N messages; move them out first.')`. Létrehozás: `mailboxCreate`; ha `created: false`, nem hiba.
  - **`trash`/`markSpam`:** MOVE a `\Trash`/`\Junk` mappába. **`untrash`/`unmarkSpam`:** a cél Gmailnél `\All`, máshol `INBOX` (D24). Üzenet id-nél a forrás az id mappája (ami ilyenkor a kuka vagy a spam); szál id-nél a `threadLocation(..., mailbox)` a kuka vagy a spam mappájában keres.

- [ ] **Step 1: Bukó tesztek**

Integráció (nem Gmail, GreenMail):

```ts
it('marks read and starred with flags', async () => { /* add STARRED, remove UNREAD on m3 → flags contain \\Seen, \\Flagged */ });
it('moves to a folder by adding it as a label and returns the new id', async () => {
  const out = await writer.updateLabels(message(m3), { add: ['Newsletters'], remove: [] });
  expect(decodeMessageId(out.messageIds[0]!).mailbox).toBe('Newsletters');
});
it('archives by removing INBOX', async () => { /* lands in Archive */ });
it('refuses two folders at once', async () => { /* unsupported_query */ });
it('trashes and restores a message to INBOX', async () => { /* trash → in:trash finds it; untrash(new id) → INBOX */ });
it('trashes a whole thread', async () => { /* m1 + m2 thread → both in Trash */ });
it('deletes only empty folders and never system ones', async () => {
  await writer.manageLabel({ action: 'create', name: 'Empty' });
  await writer.manageLabel({ action: 'delete', name: 'Empty' });
  await expect(writer.manageLabel({ action: 'delete', name: 'Newsletters' })).rejects.toMatchObject({ code: 'not_permitted' });
  await expect(writer.manageLabel({ action: 'rename', name: 'Trash', newName: 'Bin' })).rejects.toMatchObject({ code: 'not_permitted' });
});
```

Unit, Gmail (`tests/unit/gmail-writer.test.ts`, hamis kliens a `gmail-provider.test.ts` mintájára):

```ts
it('stores Gmail labels with useLabels and flags without', async () => {
  await w.updateLabels(message(ref), { add: ['Work', 'STARRED'], remove: ['INBOX', 'UNREAD'] });
  expect(fake.stores).toEqual([
    { op: 'add', flags: ['Work'], useLabels: true },
    { op: 'remove', flags: ['\\Inbox'], useLabels: true },
    { op: 'add', flags: ['\\Flagged', '\\Seen'], useLabels: false },
  ]);
});
it('restores Gmail mail from the trash to All Mail', async () => { /* messageMove destination == ALL_MAIL */ });
it('changes nothing without MOVE', async () => { /* trash → unsupported_server, no messageMove call */ });
```

(A `stores` pontos sorrendjét az implementáció rögzítse; a teszt a választott sorrendet ellenőrizze, de a három csoport mind legyen benne.)

- [ ] **Step 2: Futtasd, bukjon.**
- [ ] **Step 3: Implementáld.**
- [ ] **Step 4: Futtasd:** `pnpm test && pnpm typecheck && pnpm lint`.
- [ ] **Step 5: Stage, állj meg.** Javasolt üzenet: `feat(mail): organise mail with labels, folders, trash and spam`.

---

### Task 8: Küldés, válasz, továbbítás

**Files:**
- Modify: `src/mail/imap-writer.ts` (most már `implements MailWriter`)
- Test: `tests/integration/imap-writer.int.test.ts`, `tests/unit/imap-writer.test.ts`, `tests/unit/gmail-writer.test.ts`

**Interfaces:**
- Produces: `send`, `sendDraft`, `reply`, `forward` (aláírás: `MailWriter`).
- Viselkedés (D18, D19, D21):
  - Közös `#deliver(spec: MimeSpec, removeDraft?: MessageRef): Promise<SendOutcome>`: `envelope = { from: account.address, to: to+cc+bcc címek }`; legalább egy címzett kell, különben `MailError('send_failed', 'The message has no recipients.')`. `smtp(account, await buildMime(spec, { keepBcc: false }), envelope)`. Ezután nem Gmail fióknál APPEND a `\Sent` mappába (`buildMime(spec, { keepBcc: true })`, `['\\Seen']`); hiba esetén figyelmeztetés, `sentCopyId: null`. `removeDraft` esetén a piszkozat `messageDelete`-tel eltávolítva; hiba esetén figyelmeztetés.
  - Az SMTP hiba (`send_failed`) után semmi nem íródik.
  - `send(c)`: `from` a fiók címe, aláírás `includeSignature` esetén, új Message-ID, `date: new Date()`.
  - `sendDraft(ref)`: **előbb** `requireCapability(client, 'UIDPLUS', 'send with draftId')`, csak utána `readStored` és küldés (a piszkozat Bcc-je az envelope-ba kerül, a kiküldött levélbe nem, mert a `MimeSpec`-ből újraépül).
  - `reply(ref, input)`: a címzettek `input.to`/`input.cc`, ha megadták, különben `replyRecipients` (Task 2) az eredeti `from/to/cc/replyTo` alapján (a `replyTo` az envelope-ból jön); `In-Reply-To` az eredeti Message-ID, `References` az eredeti References + az eredeti Message-ID; tárgy `prefixSubject('Re:', …)`; idézés `quoteReply`. Ugyanaz a válaszkontextus-építő, mint a `createDraft` `replyTo` ága (egy privát metódus, nem másolat).
  - `forward(ref, input)`: `readStored` az eredetire (méretkorláttal), `forwardBody`, az eredeti mellékletei és az újak együtt `assertAttachmentBudget` alatt; tárgy `prefixSubject('Fwd:', …)`; nincs `In-Reply-To`.

- [ ] **Step 1: Bukó tesztek**

Integráció (GreenMail SMTP, alice küld, bob INBOX-át egy külön `ImapMailProvider` olvassa `gm.bob`-bal):

```ts
it('delivers without Bcc and keeps Bcc in the sent copy', async () => {
  const out = await writer.send(composition({ to: ['bob@example.com'], bcc: ['alice@example.com'], subject: 'Hello Bob', body: 'Hi' }));
  const received = await bobReader.search('subject:"Hello Bob"', 0, 5);
  const raw = await bobReader.getMessage(decodeMessageId(received.messages[0]!.id), 'raw');
  expect(raw.body).not.toMatch(/^Bcc:/im);
  const copy = await reader.getMessage(decodeMessageId(out.sentCopyId!), 'raw');
  expect(copy.body).toMatch(/^Bcc: alice@example\.com/im);
});
it('sends a draft and removes it', async () => { /* createDraft → sendDraft → bob got it, Drafts no longer has it */ });
it('replies in the thread with quoting', async () => { /* reply to m1 → bob gets 'Re: Invoice 2026-11', In-Reply-To <m1@example.com> */ });
it('reply all skips our own plus address', async () => { /* original To: alice+x@example.com, carol → reply all goes to bob + carol only (envelope via a fake SmtpSend wrapper that records envelopes) */ });
it('forwards with the original attachment', async () => { /* forward m1 to bob → bob's message has invoice.pdf and 'Fwd: Invoice 2026-11' */ });
```

Unit:

```ts
it('writes nothing when SMTP fails', async () => { /* smtp rejects → send_failed, no append */ });
it('reports a failed sent copy as a warning', async () => { /* append resolves false → sentCopyId null, 1 warning */ });
it('sends a draft only with UIDPLUS', async () => { /* no UIDPLUS → unsupported_server, smtp not called */ });
// gmail-writer.test.ts
it('keeps no sent copy for Gmail', async () => { /* send → no append call, sentCopyId null, no warning */ });
```

- [ ] **Step 2: Futtasd, bukjon.**
- [ ] **Step 3: Implementáld.**
- [ ] **Step 4: Futtasd:** `pnpm test && pnpm typecheck && pnpm lint`.
- [ ] **Step 5: Stage, állj meg.** Javasolt üzenet: `feat(mail): send, reply and forward over SMTP`.

---

### Task 9: Hatókör, szintek és a `draft` szintű eszközök

**Files:**
- Create: `src/tools/scope.ts`, `src/tools/compose-schema.ts`, `src/tools/write-tools.ts`
- Modify: `src/tools/read-tools.ts` (a segédek a `scope.ts`-ből), `src/server.ts`
- Test: `tests/unit/write-tools.test.ts` (új), `tests/unit/tools.test.ts` (változatlanul zöld)

**Interfaces:**
- Produces:
  - `src/tools/scope.ts`: a `read-tools.ts`-ből kiemelt `ToolScope`, `accountIdSchema`, `inScope`, `requestedAccount`, `onlyAccount`, `messageTarget`, `threadTarget`, `NO_TARGET`, egy `ScopeHelpers` objektumot adó `scopeHelpers(scope)` függvénnyel; plusz `accountsAllowing(scope, need: AccessLevel): Account[]`.
  - `ToolDeps` bővül: `writerFor(accountId: string): MailWriter`.
  - `src/tools/compose-schema.ts`: `addressListSchema` (`z.array(z.email())`), `attachmentSchema` (`content: z.base64()`, `filename`, `mimeType` opcionális, `inline` alapból `false`), `compositionFields` (D13 mezői, a leírásokban a connector szövegének lényege: a `body` ne legyen Markdown; inline kép `cid:attN`), és a leírásban a korlát az `OUTGOING_ATTACHMENTS_LIMIT_BYTES`-ből számolva (nem beírt szám).
  - `src/tools/write-tools.ts`: `export function registerWriteTools(server: McpServer, scope: ToolScope, deps: ToolDeps): void` regisztrálja: `create_draft`, `update_draft`, `delete_draft`, `update_labels`, `manage_label`, `trash`, `untrash`, `mark_spam`, `unmark_spam`.
  - Szabályok (D15):
    - Ha `accountsAllowing(scope, 'draft')` üres, egyik eszköz sem regisztrálódik.
    - Az `account` paraméteres eszközök (`create_draft`, `manage_label`) `account` enumja csak az engedett fiókokat tartalmazza; `/mcp/<id>` végponton az `account` paraméter nincs.
    - Az id alapú eszközök a dekódolt id fiókjára `assertLevel(account, 'draft')`-ot hívnak a provider előtt.
    - A `trash`, `untrash`, `mark_spam`, `unmark_spam`, `update_labels` `messageId` vagy `threadId` paramétert kap, pontosan egyet (különben `invalid_id`, üzenet: `Give exactly one of messageId or threadId.`).
    - Annotációk: `readOnlyHint: false`, `openWorldHint: true`, `destructiveHint: false`, kivéve `manage_label` (`destructiveHint: true`, mert törölhet címkét).
    - Minden leírás végén `UNTRUSTED_NOTE`. A `delete_draft` leírása kimondja, hogy a piszkozat a kukába kerül; az `update_draft` leírása, hogy az id megváltozik és a mellékleteket újra meg kell adni.
    - Napló: `runTool` a meglévő `LogTarget`-tel (fiók, id); a `manage_label` neve nem kerül a naplóba.
  - `src/server.ts`: `buildMcpServer` a `registerReadTools` után `registerWriteTools`-t hív.

- [ ] **Step 1: Bukó tesztek** (`InMemoryTransport` kliens, hamis provider és writer, a `tools.test.ts` mintájára)

```ts
it('offers no write tools when every account is read-only', async () => {
  expect(await toolNames(scopeOf([acc('a', 'read')]))).not.toContain('create_draft');
});
it('offers draft tools and lists only accounts that allow them', async () => {
  const tools = await listTools(scopeOf([acc('a', 'read'), acc('b', 'draft')]));
  expect(enumOf(tools, 'create_draft', 'account')).toEqual(['b']);
});
it('refuses an id of a read-only account with not_permitted', async () => {
  const res = await call('trash', { messageId: idOf('a') });
  expect(res.isError).toBe(true);
  expect(textOf(res)).toContain('not_permitted');
  expect(writerCalls).toEqual([]);
});
it('needs exactly one of messageId and threadId', async () => { /* both or neither → invalid_id */ });
it('drops the account parameter on a per-account endpoint', async () => { /* /mcp/b: create_draft has no account */ });
it('logs account and id but no recipient or subject', async () => {
  await call('create_draft', { account: 'b', to: ['bob@example.org'], subject: 'Secret plan' });
  expect(JSON.stringify(logs)).not.toMatch(/bob@example\.org|Secret plan/);
});
it('adds the untrusted note to every write tool', async () => { /* every tool description ends with UNTRUSTED_NOTE */ });
```

- [ ] **Step 2: Futtasd, bukjon.**
- [ ] **Step 3: Implementáld.** A `read-tools.ts` kiemelése után a `tests/unit/tools.test.ts` változtatás nélkül zöld (csak az importált nevek forrása változhat).
- [ ] **Step 4: Futtasd:** `pnpm test:unit && pnpm typecheck && pnpm lint`.
- [ ] **Step 5: Stage, állj meg.** Két commit, mert a kiemelés önálló refaktor:
  1. `refactor(tools): move scope helpers into their own module` (`src/tools/scope.ts`, `src/tools/read-tools.ts`)
  2. `feat(tools): add draft-level tools with per-account levels` (a többi fájl)

  Mindkét commit állapota külön zöld legyen (a koordinátor `git apply --index`-szel lépésenként ellenőrzi).

---

### Task 10: `send` szintű eszközök és kérésméret

**Files:**
- Create: `src/tools/send-tools.ts`
- Modify: `src/server.ts`, `src/http/app.ts`
- Test: `tests/unit/send-tools.test.ts` (új), `tests/unit/http.test.ts`

**Interfaces:**
- Produces:
  - `export function registerSendTools(server: McpServer, scope: ToolScope, deps: ToolDeps): void`: `send`, `reply`, `forward`, a Task 9 szabályaival `'send'` szintre. `send`: vagy `draftId`, vagy legalább egy címzett (`to`, `cc` vagy `bcc`); `draftId` mellett más tartalommező nem adható (különben `invalid_id`, üzenet: `With draftId the draft is sent as it is; leave the other fields out.`). Annotáció: `destructiveHint: true`, `readOnlyHint: false`, `openWorldHint: true`.
  - A válasz JSON: `SendOutcome` (`messageIdHeader`, `sentCopyId`, `warnings`).
  - `src/http/app.ts`: `export const MAX_REQUEST_BODY_BYTES = Math.ceil((OUTGOING_ATTACHMENTS_LIMIT_BYTES * 4) / 3) + 2 * 1024 * 1024;` (base64 és a JSON többi része; spec D14: 16 MiB alatt), mindkét `createMcpHandler` hívásban `maxRequestBodySize`.

- [ ] **Step 1: Bukó tesztek**

```ts
it('offers send tools only for send-level accounts', async () => { /* accounts read + draft → no 'send'; + send → enum ['c'] */ });
it('sends a draft as it is', async () => { /* draftId + subject → invalid_id; draftId alone → writer.sendDraft called */ });
it('needs a recipient', async () => { /* no to/cc/bcc, no draftId → error */ });
it('refuses a reply to a message of a draft-level account', async () => { /* not_permitted, writer not called */ });
```

`tests/unit/http.test.ts`: egy 5 MiB-os (az SDK 4 MiB-os alapja fölötti, de a mi korlátunk alatti) `tools/list` kérés nem `413`; egy `MAX_REQUEST_BODY_BYTES + 1` bájtos `Content-Length`-ű kérés `413`.

- [ ] **Step 2: Futtasd, bukjon.**
- [ ] **Step 3: Implementáld.**
- [ ] **Step 4: Futtasd:** `pnpm test:unit && pnpm typecheck && pnpm lint`.
- [ ] **Step 5: Stage, állj meg.** Javasolt üzenet: `feat(tools): add send, reply and forward tools`.

---

### Task 11: Bekötés, hibakereső kapcsoló, dokumentáció

**Files:**
- Modify: `src/main.ts`, `src/imap/client.ts` (`tlsConnector` debug opció), `.env.example`, `README.md`
- Test: `tests/unit/imap-client.test.ts`

**Interfaces:**
- Consumes: `parseDebug`, `tlsSmtpSender`, `ImapMailWriter`, `protocolDebugLogger`.
- Produces:
  - `imapConnectionOptions(account, password, debug: boolean)`: `debug` esetén `logger: protocolDebugLogger('imap', account.id)`, különben `false`. `tlsConnector(passwordFor, debug)`.
  - `main.ts`: `const debug = parseDebug(process.env.MAILMCP_DEBUG)` a konfig mellett (hibánál a meglévő „cannot start” út); writerek fiókonként (`new ImapMailWriter(account, pool, providers.get(id), tlsSmtpSender(config.passwordFor, debug))`); `deps.writerFor`; debug módban az induló sor végén ` (protocol debug log on: mail content is printed)`.
  - Komment a `main.ts`-ben a `parseDebug` mellett: a 3. fázis nyilvános indítása ezzel a kapcsolóval nem indulhat (D25); ez a fázis csak `127.0.0.1`-en figyel.
  - `.env.example`: `# MAILMCP_DEBUG=1 prints the IMAP/SMTP protocol, mail content included. Local debugging only.` és alatta `MAILMCP_DEBUG=0`.
  - `README.md`: „Állapot” sor: `2. fázis kész: lokálisan futó szerver írással és küldéssel, hitelesítés nélkül. Nyilvános címre még nem telepíthető.`; a „Lokális futtatás” fejezet kiegészül: a szint a fiók `level` mezőjéből jön, a küldés csak `send` szinten; tesztlevelet csak saját `+mailmcp` címre; `MAILMCP_DEBUG=1` mire való és mit ír ki.

- [ ] **Step 1: Bukó teszt:** `imapConnectionOptions(acc, 'pw', false).logger === false`; `debug: true` mellett a `logger` objektum, amelynek `debug` metódusa van.
- [ ] **Step 2: Futtasd, bukjon.**
- [ ] **Step 3: Implementáld.**
- [ ] **Step 4: Teljes ellenőrzés:** `pnpm test && pnpm typecheck && pnpm lint && pnpm build && pnpm exec prettier --check .`. Füstteszt valódi TCP-n, kitalált fiókkal (`level: send`, elérhetetlen host): `tools/list` mind a 20 eszközt adja; `send` egy elérhetetlen SMTP hostra `send_failed`, és a naplósorban nincs címzett.
- [ ] **Step 5: Stage, állj meg.** Két commit:
  1. `feat(app): wire the writer, SMTP sender and protocol debug switch` (`src/main.ts`, `src/imap/client.ts`, `tests/unit/imap-client.test.ts`, `.env.example`)
  2. `docs(readme): describe phase 2 and the debug switch` (`README.md`)

---

## Kézi próba (Alex, a 11. task után)

1. `accounts.yaml`: a Gmail fiók és a másik IMAP fiók `level: send`.
2. `pnpm dev`, Claude Code-ból:
   - piszkozat létrehozása, módosítása, törlése (a Gmail felületén is látszik-e, és a törölt piszkozat a kukába került-e);
   - címke hozzáadása és levétele Gmailen, mappába áthelyezés és archiválás a másik fiókon;
   - kukába tétel és visszaállítás (Gmailen visszakapja-e a címkéit, ez a spec „mérjük” listáján van);
   - küldés, válasz és továbbítás **csak** a saját `+mailmcp-<bármi>` címre; a Gmail Sent mappájában pontosan egy példány van-e (D18), a másik fiók Sent mappájában a másolat Bcc-vel;
   - a másik szerver képességei: `MAILMCP_DEBUG=1`-gyel egy induláskor a naplóban a `CAPABILITY` sor (UIDPLUS, MOVE).
3. A mért eredményt a koordinátor a fázis lezáró összefoglalójába és a PR leírásába írja.

---

## Self-review (a terv írója végezte)

**Spec lefedettség:**
- D12 (nodemailer, fájl/URL tiltás): Task 3, Task 5.
- D13 (paraméterek, `cid:attN`): Task 3, Task 9.
- D14 (10 MB, 16 MiB alatti kérés): Task 3, Task 10.
- D15 (szintek, két védelmi vonal): Task 1, Task 9, Task 10.
- D16, D17 (piszkozatok, UIDPLUS/MOVE): Task 4, Task 6.
- D18 (küldés, Sent másolat, figyelmeztetés): Task 5, Task 8.
- D19, D20 (válasz, saját cím): Task 2, Task 6 (válaszpiszkozat), Task 8.
- D21 (továbbítás): Task 3, Task 8.
- D22, D23, D24 (címkék, mappák, kuka, spam): Task 7.
- D25 (hibakereső kapcsoló): Task 1, Task 5, Task 11.
- Új hibakódok: Task 1. Naplózás címzett és tárgy nélkül: Task 9.
- **Nem ebben a fázisban:** OAuth és nyilvános elérés (3. fázis), Docker, CI, deploy és a memória mérése mellékletekkel (4. fázis).

**Lépésellenőrzés:** minden kódlépés aláírást, fájlt és a spec rögzített értékeit adja; a törzseket az implementáló írja. Ahol a terv a GreenMail mért viselkedésére bíz egy részletet (Task 6), ott a tiltott kerülőút (a `src` igazítása a teszthez) meg van nevezve.

**Típus konzisztencia:** a `MailWriter`, `Composition`, `DraftPatch`, `ReplyInput`, `ForwardInput`, `WriteTarget`, `MimeSpec`, `MimeAttachment`, `SmtpSend` nevek Task 3, 5, 6, 7, 8, 9, 10 között azonosak; a `withMailbox(client, path, { access, from }, fn)` és a `threadLocation(client, account, ref, mailbox?)` aláírása Task 4, 6, 7 között azonos.

**Arány:** a terv a spec 2. fázisú fejezetének többszöröse, de kódtörzset csak a tesztekben és a típusoknál tartalmaz.
