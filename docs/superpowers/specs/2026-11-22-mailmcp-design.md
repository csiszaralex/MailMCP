# MailMCP: tervezési specifikáció

Dátum: 2026-11-22
Állapot: jóváhagyásra vár

## Cél

Egy távoli MCP szerver a VPS-en, amely a Claude Gmail connectorához hasonló képességeket ad, de egyszerre több (legalább 5) postafiókhoz: Gmail, Google Workspace és általános IMAP/SMTP fiókokhoz. Két módon csatolható:

- **claude.ai connectorként**: minden fiók látszik, a keresés egyszerre több fiókban is fut;
- **mappánként `.mcp.json`-nal a Claude Code-ban**: egy mappához pontosan egy fiók tartozik.

## A Claude Gmail connector képességei (a kiindulópont)

Mérés alapja: a connector eszközlistája és paramétersémái egy Claude Code munkamenetben, 2026-11-21-én. Valódi levelet nem olvastunk.

| Terület | Connector eszközök | Részletek |
|---|---|---|
| Keresés | `search_threads` | Gmail keresőszintaxis, lapozás (max. 50 szál laponként), 4 nézet |
| Olvasás | `get_thread`, `get_message` | plain text, HTML, metadata, RAW MIME |
| Melléklet | `download_gmail_attachment` | max. 12 MB |
| Küldés | `send_message`, `reply`, `forward` | HTML, cc/bcc, mellékletek összesen 25 MB, inline képek, aláírás, szálba illesztés |
| Piszkozat | `create_draft`, `update_draft`, `get_draft`, `list_drafts`, `delete_draft` | |
| Címkék | `list_labels`, `create_label`, `update_label`, `delete_label`, `label_*`, `unlabel_*`, `update_message_labels` | olvasott jelzés, archiválás, csillag is címkével |
| Kuka, spam | `trash_*`, `untrash_*`, `mark_*_spam`, `unmark_*_spam` | üzenetre és szálra |

Nincs benne: végleges törlés, szűrők, automatikus válasz, aláírás szerkesztése, kötegelt műveletek, névjegyek. Csak egy fiókot kezel.

## Döntések

| # | Döntés | Indok |
|---|---|---|
| D1 | Minden fiók IMAP és SMTP protokollon érhető el, Gmailnél a Gmail IMAP kiterjesztéseivel (`X-GM-RAW`, `X-GM-THRID`, `X-GM-MSGID`, `X-GM-LABELS`) | Egy kódút, egy szemantika, egy tesztkészlet minden fiókra |
| D2 | A szerver a levelezőszerverekhez fiókonkénti **alkalmazásjelszóval** csatlakozik | Nem kell Google Cloud projekt és fiókonkénti OAuth hozzájárulás. Teljes postafiók hozzáférést ad, a szűkítést a jogosultsági szint végzi (D4) |
| D3 | **POP3 nincs** | A POP3 csak letölti a beérkezett leveleket: nincsenek mappák, címkék, jelzők, szálak és szerveroldali keresés. A connector szintjéhez saját levélindex kellene a VPS-en, ami nagyjából megduplázná a projektet. Minden jelenlegi fióknak van IMAP-ja. Ha egyszer csak POP3-as fiók jön, új `MailProvider` adapterként hozzáadható |
| D4 | Fiókonkénti jogosultsági szint: `read`, `draft`, `send` | A `send` szinttel a connectorral azonos működés érhető el, a fontos fiókok pedig korlátozhatók |
| D5 | Egy felhasználó (az első verzióban) | A többfelhasználós mód felhasználókezelést és felhasználónkénti titkokat igényelne, ami megsokszorozza a támadási felületet. A konfig `owner` mezője és a hívásokon végigvitt felhasználói azonosító nyitva hagyja a bővítést |
| D6 | OAuth mindenhol, a mappánkénti Claude Code is OAuth-tal lép be | Egy hitelesítési mechanizmus. A `.mcp.json` titkot nem tartalmaz, commitolható |
| D7 | Nincs levélcache és levélindex | 5 fióknál az IMAP keresés elég gyors; a cache a szűkös RAM-ot és a szinkronhibák esélyét növelné |
| D8 | TypeScript, hivatalos MCP SDK v2, pnpm, vitest | Ugyanez a stack fut a WebFetch projektben, a tooling és a minták újrahasznosíthatók |
| D9 | Kódkommentek angolul, README és dokumentáció magyarul | Alex többi projektjének mintája |
| D10 | Kliensazonosítás **Client ID Metadata Documenttel (CIMD)**, dinamikus kliensregisztráció (DCR) nélkül. Csak engedélyezett originről (`https://claude.ai`, `https://claude.com`) származó `client_id` URL fogadható el | Mindkét Claude kliens támogatja (lásd „Mért tények”). Nincs nyilvános regisztrációs végpont és kliensadatbázis, és idegen kliens el sem indíthatja a folyamatot. Mivel a szerver csak engedélyezett originről tölt le metaadatot, SSRF sem lehetséges. Ha az átvételi teszten a claude.ai mégsem CIMD-t használ, DCR kerül be fix visszahívási listával |
| D11 | Authorization szerver saját megvalósítással; az erőforrásszerver oldalon az MCP SDK segédei | Az SDK v2 csak az erőforrásszerver oldalt adja (lásd „Mért tények”) |

## Architektúra

Egyetlen Node folyamat Docker konténerben, nyilvános HTTPS hostnév mögött, Streamable HTTP MCP transzporttal.

### Végpontok

| Útvonal | Szerep |
|---|---|
| `/mcp` | Minden fiók. Az eszközöknek van `account` paramétere; a `search` eszközben elhagyható, ekkor minden fiókban keres |
| `/mcp/<fiók-id>` | Csak az adott fiók. Az `account` paraméter nem szerepel az eszközökben |
| `/.well-known/oauth-protected-resource/mcp`, `/.well-known/oauth-protected-resource/mcp/<fiók-id>` | Protected resource metaadat erőforrásonként (RFC 9728, útvonal utótaggal). A `resource` mező pontosan a csatolt URL |
| `/.well-known/oauth-authorization-server` | Authorization server metaadat (RFC 8414) |
| `/authorize`, `/token` | OAuth végpontok. Regisztrációs végpont (`/register`) nincs, lásd D10 |
| bejelentkező oldal | jelszó és TOTP |

Minden más útvonal 404. Hitelesítés nélkül csak az OAuth metaadat, az authorize és token végpont és a bejelentkezés érhető el, levélhez vezető útvonal nem. Token nélküli `/mcp` kérésre a válasz `401`, `WWW-Authenticate: Bearer resource_metadata="..."` fejléccel, mert a Claude csak erre indítja a bejelentkezést.

### Egységek

| Egység | Feladat | Függ |
|---|---|---|
| `config` | Az `accounts.yaml` és a titkok beolvasása, validálása zod sémával | semmi |
| `store` | SQLite: engedélyezések, tokenhash-ek, próbálkozásszámlálók, felhasznált TOTP lépések (D27). Levél nincs benne | semmi |
| `auth` | OAuth szerver, a token ellenőrzése minden `/mcp` kérésnél, erőforráshoz kötés | `store`, `config` |
| `providers` | `MailProvider` interfész; `ImapSmtpProvider` megvalósítás, Gmail kiterjesztésekkel, ha `provider: gmail` | `config` |
| `tools` | Az MCP eszközök. Csak a fiók szintje által engedett eszközök regisztrálódnak | `providers`, `aggregate` |
| `aggregate` | Párhuzamos keresés több fiókban, dátum szerinti összefésülés, fiókonkénti hibajelzés | `providers` |
| `cli` | Kezelőparancsok a konténeren belül (tokenek listázása és visszavonása, health check) | `store`, `config` |

### Kapcsolatok és azonosítók

- Az IMAP kapcsolat igény szerint nyílik, és kb. 60 másodperc tétlenség után bezárul.
- Az üzenetazonosító átlátszatlan szöveg, amely kódolja a fiókot, a mappát, a UIDVALIDITY értéket és a UID-t. Gmailnél is ugyanez a formátum, a mappa ott a `\All` speciális mappa („Összes levél”, a felület nyelvétől függő néven), a kukában és a spamben lévő levélé a Trash, illetve a Spam mappa (D24); így egyetlen azonosító formátum van. Szerver újraindítás után is feloldható.
- A szálazonosító Gmailnél az `X-GM-THRID`, más fióknál a mappa és a szál gyökerének Message-ID-je (a References fejléc első eleme, ennek hiányában az üzenet saját Message-ID-je).
- Ha a UIDVALIDITY megváltozott, az azonosító érvénytelen, és az eszköz ezt érthető hibával jelzi (új keresés kell).
- A többfiókos keresés lapozó tokenje fiókonkénti pozíciókat kódol.

## Eszközkészlet

20 eszköz. Az üzenet és szál párokat egy eszköz kezeli `messageId` vagy `threadId` paraméterrel.

| Eszköz | Szint | Connector megfelelő | Megjegyzés |
|---|---|---|---|
| `list_accounts` | read | nincs | fiók-id, cím, típus, szint |
| `search` | read | `search_threads` | Üzeneteket ad vissza (legújabb elöl), mindegyiknél `threadId`-val; a teljes beszélgetést a `get_thread` adja. Snippet nincs, mert minden találat törzsét le kellene tölteni. Nézetek: `ids`, `metadata`, `minimal` (alapértelmezett, tárggyal). Gmail: teljes Gmail szintaxis (`X-GM-RAW`) az „Összes levél” mappában, `in:trash` és `in:spam` (és aliasaik) esetén a Trash, illetve a Spam mappában (D24). Más fiók: részhalmaz IMAP SEARCH-re fordítva: `from:`, `to:`, `cc:`, `subject:`, `after:`, `before:`, `is:unread`/`read`/`starred`/`unstarred`, `has:attachment` (közelítés a `multipart/mixed` tartalomtípussal, mert az IMAP SEARCH mellékletre nem szűr), `in:` (mappa; alapból az INBOX, `in:anywhere` az „Összes levél”), a szabad szavak egy kifejezésként. Egy operátor legfeljebb egyszer szerepelhet. Hibát ad az OR, a `-` tagadás, a zárójel és a csak Gmailben létező operátor (például `newer_than:`, `label:`); minden más `szó:` alakú token szabad szöveg, így a `re:` vagy egy URL is kereshető. Lapozás `pageToken`-nel |
| `get_thread` | read | `get_thread` | Gmail: `X-GM-THRID` az „Összes levél” mappában. Más: a mappában a gyökér Message-ID-re és a rá hivatkozó References fejlécekre keres (az IMAP THREAD kiterjesztés nem kell, és az imapflow nem is támogatja) |
| `get_message` | read | `get_message` | plain, html, metadata, raw |
| `download_attachment` | read | `download_gmail_attachment` | max. 12 MB |
| `list_labels` | read | `list_labels` | Gmail címkék, illetve IMAP mappák |
| `list_drafts` | read | `list_drafts` | |
| `get_draft` | read | `get_draft` | |
| `create_draft` | draft | `create_draft` | `replyToMessageId` is |
| `update_draft` | draft | `update_draft` | |
| `delete_draft` | draft | `delete_draft` | |
| `update_labels` | draft | `label_*`, `unlabel_*`, `update_message_labels` | hozzáad és elvesz; olvasott jelzés, csillag, archiválás |
| `manage_label` | draft | `create_label`, `update_label`, `delete_label` | `action`: create, rename, delete |
| `trash` | draft | `trash_*` | |
| `untrash` | draft | `untrash_*` | |
| `mark_spam` | draft | `mark_*_spam` | |
| `unmark_spam` | draft | `unmark_*_spam` | |
| `send` | send | `send_message` | új levél vagy piszkozat elküldése (`draftId`), mellékletek összesen 10 MB (D14) |
| `reply` | send | `reply` | `replyAll` |
| `forward` | send | `forward` | |

Szintek: `read` semmit nem módosít; `draft` piszkozatot ír és rendszerez (minden művelete visszafordítható); `send` küldhet is. Végleges törlés egyik szinten sincs.

Nem Gmail fióknál a címke a mappának felel meg: `update_labels` mappák közti mozgatásra, illetve IMAP jelzőkre (`\Seen`, `\Flagged`) fordul. A kuka és a spam mappát a SPECIAL-USE attribútumok (`\Trash`, `\Junk`) alapján találja meg, ennek hiányában a fiók konfigjában adható meg.

Aláírás: a fiók konfigjából (`signature`), ha az eszközhívás kéri. IMAP-on a Gmail aláírása nem olvasható ki.

Minden eszközleírás jelzi, hogy a levéltartalom nem megbízható adat (prompt injection elleni figyelmeztetés).

### Írás, rendszerezés és küldés (2. fázis döntései, 2026-11-23)

| # | Döntés | Indok |
|---|---|---|
| D12 | Küldés és MIME összeállítás a `nodemailer` csomaggal; fájl- és URL-hozzáférése kikapcsolva (`disableFileAccess`, `disableUrlAccess`) | Az imapflow szerzőjének csomagja, saját típusokkal. Kikapcsolt hozzáférés nélkül egy melléklet `path` vagy `href` mezője helyi fájlt olvasna vagy URL-t hívna |
| D13 | A paraméterek a connectorét követik: `to`, `cc`, `bcc` címlisták, `subject`, `body`, `htmlBody`, `includeSignature`, mellékletek `{content (base64), filename, mimeType, inline}` alakban; inline kép `cid:attN` hivatkozással (N a melléklet sorszáma nullától) | A Claude ugyanúgy hívja, mint a Gmail connectort |
| D14 | A kimenő mellékletek összesen legfeljebb **10 MB**-osak (a továbbított levél eredeti mellékleteivel együtt), a kérés legfeljebb 16 MiB. **Eltérés a connector 25 MB-jától** | A 25 MB base64-ben kb. 34 MB-os kérés; a JSON, a dekódolt fájlok, a kész levél és a Sent másolat együtt nem fér a 256 MB-os konténerbe (170 MB heap). A Claude a mellékletet tokenekként írja ki, néhány MB fölött úgysem tud küldeni |
| D15 | Egy író eszköz akkor regisztrálódik, ha a végpont legalább egy fiókjának elég a szintje; az `account` paraméterben csak ezek a fiókok választhatók. Id alapú hívásnál az id fiókjának szintjét is ellenőrzi, hiba: `not_permitted` | Két védelmi vonal, ahogy a fiókhoz kötésnél |
| D16 | Piszkozat: `create_draft` APPEND a Drafts mappába (`\Draft`, `\Seen`). `update_draft` a connector szerint csak a megadott mezőket írja felül (a `body` és a `htmlBody` együtt cserélődik). A mellékleteket a megadott lista cseréli, `attachments: []` eldobja őket; ha a mező hiányzik és a piszkozatnak van melléklete, a hívás hibát ad, és semmi nem változik (eltérés a connectortól: a levelezőprogramban csatolt fájlt a Claude nem tudja újra megadni). Új verziót tölt fel és a régit eltávolítja, ezért **az id megváltozik**, a válasz az újat adja. `delete_draft` a kukába tesz | A `draft` szint minden művelete visszafordítható (a connector véglegesen töröl) |
| D17 | Végleges eltávolítás (EXPUNGE) csak a piszkozat régi verziójára és az elküldött piszkozatra, és csak UIDPLUS-szal (`UID EXPUNGE`). Áthelyezés MOVE kiterjesztéssel, vagy ennek hiányában UIDPLUS-szal (COPY, majd `UID EXPUNGE` csak az áthelyezett levelekre). Ha egyik sincs, az eszköz `unsupported_server` hibát ad. Ha MOVE nélkül a másolás sikerül, de az eredeti eltávolítása nem, a levél mindkét mappában megmarad, és a válasz `update_failed` | UIDPLUS nélkül az imapflow sima EXPUNGE-t küld, ami a mappa minden törlésre jelölt levelét törli, más kliensekéit is; MOVE nélkül az imapflow COPY és EXPUNGE lépéssel helyez át, ami UIDPLUS-szal csak a megnevezett leveleket érinti (mérve: a work fiók Courier-IMAP szervere UIDPLUS-t ad, MOVE-ot nem) |
| D18 | Küldés SMTP-n: 465 implicit TLS, 587 kötelező STARTTLS, tanúsítványellenőrzés kötelező. Nem Gmail fióknál másolat a Sent mappába (`\Seen`, a Bcc fejléccel); Gmailnél nincs másolat, mert a Gmail SMTP maga menti. Ha az SMTP elfogadta a levelet, de a másolat nem sikerült, vagy a szerver egyes címzetteket elutasított, a válasz sikeres, figyelmeztetéssel (az elutasított címekkel). A válasz megadja, kiknek ment a levél (`to`, `cc`, `bcc`). Piszkozat küldése (`draftId`) után a piszkozat eltávolítódik (D17) | Az SMTP elfogadás után a levél már elment, hibát jelezni félrevezető lenne |
| D19 | `reply`: `In-Reply-To`, `References`, `Re:` előtag, az eredeti levél idézve (plain: `>` sorok, HTML: `blockquote`). Címzett a `Reply-To`, ennek hiányában a `From`; ha az eredetit mi küldtük, az eredeti címzettjei; ha így a To üres marad (például csak magunknak küldött levélnél), a To a saját cím. A `Reply-To` a `get_message` válaszában is látszik; ha a levélben nincs, vagy pontosan a From címeit ismétli, üres (az IMAP ENVELOPE hiányzó fejlécnél a From-ot adná). `replyAll` a To és Cc címeket is hozzáadja, a saját címek nélkül. `create_draft` a `replyToMessageId`-vel ugyanígy készít választ; ha nem kap címzettet, a sima válasz címzettjeit kapja | A connector `create_draft` is idézi az eredetit |
| D20 | Saját cím felismerése: kis- és nagybetű és a `+` utáni rész nem számít (`asd+xxx@asd.hu` = `asd@asd.hu`); Gmail fióknál `gmail.com` és `googlemail.com` címeken a felhasználónév pontjai sem, és a két domain azonos | Így kézbesít a Gmail és a legtöbb szerver |
| D21 | `forward`: a törzs elején a megjegyzés, utána egy „Forwarded message” fejlécblokk (From, Date, Subject, To) és az eredeti szöveg; az eredeti mellékletek átkerülnek (D14 korláton belül). Tárgy: `Fwd:` előtag | A Gmail felületén is így néz ki egy továbbítás |
| D22 | Címkék nem Gmail fióknál (`update_labels`): `UNREAD` és `STARRED` a `\Seen` és `\Flagged` jelzőre fordul; egy mappa hozzáadása áthelyezés oda; az `INBOX` levétele archiválás az Archive mappába (SPECIAL-USE `\Archive` vagy a `mailboxes.archive` konfig). Más kombináció hibát ad. Gmailnél minden név valódi címke (`X-GM-LABELS`), az `UNREAD` és `STARRED` ott is jelző, és az id nem változik | Az IMAP mappában egy levél egyszerre csak egy helyen lehet |
| D23 | `manage_label` (`create`, `rename`, `delete`): az INBOX és a speciális mappák nem nevezhetők át és nem törölhetők. Mappa és címke csak üresen törölhető, Gmailnél is | Nem Gmail fióknál a mappa törlése a leveleit is törli; Gmailnél a levelek megmaradnak, de elveszik, melyiken volt a címke, és a `draft` szint minden művelete visszafordítható. A címke előbb az `update_labels`-szel szedhető le |
| D24 | `trash`, `untrash`, `mark_spam`, `unmark_spam` üzenetre és szálra, áthelyezéssel a Trash vagy Junk mappába. Visszaállítás Gmailnél az „Összes levél” mappába (a címkék megmaradnak, ahogy a connectorban; a beérkezettek címkéjét a Gmail a kukába tételkor leveszi, az `update_labels`-szel tehető vissza), más fióknál az INBOX-ba. A válasz az áthelyezett levelek új id-jét adja. Gmailnél a keresés az „Összes levél” mappában fut, amiben a kuka és a spam nincs benne, ezért az `in:trash` és `in:spam` (és az aliasaik, például `in:bin`, `in:junk`) a Trash, illetve a Spam mappában keres | Áthelyezés után a régi id (mappa és UID) érvénytelen |
| D25 | `MAILMCP_DEBUG=1`: az imapflow és a nodemailer protokoll naplója a stderr-re. Levéltartalmat is kiír (a jelszót az imapflow és a nodemailer kitakarja), ezért alapból ki van kapcsolva, és csak a lokális futásban engedett (D30); a nyilvános telepítés ezzel nem indul el | Hibakereséshez kell, de a valódi fiókok leveleit nem szabad minden futásnál a terminálba írni |

Hibakódok bővülnek: `invalid_argument` (a hívás paraméterei hiányosak vagy nem illenek össze; az `invalid_id` csak a nem értelmezhető azonosítóra marad), `not_permitted` (a fiók szintje nem engedi), `unsupported_server` (hiányzó UIDPLUS, illetve áthelyezésnél MOVE és UIDPLUS egyaránt hiányzik), `send_failed` (az SMTP szerver elutasította vagy nem érhető el), `update_failed` (az IMAP szerver elutasította a jelző, címke vagy áthelyezés módosítását; az elutasítás előtt már elmentett módosítások megmaradnak).

## Konfig és titkok

### `accounts.yaml` (titok nélkül)

Helye: a telepítés mellett (a privát infra repóban), csak olvashatóként csatolva. Az app repóban csak kitalált címekkel készült `accounts.example.yaml` van.

```yaml
owner: alex
accounts:
  - id: maganszemely          # [a-z0-9-], ez kerül az URL-be
    address: pelda@gmail.com
    provider: gmail           # a hostokat a szerver tölti ki
    level: send               # read | draft | send
    signature: |
      Üdv,
      Alex
  - id: ceges
    address: info@pelda.hu
    provider: imap
    imap: { host: mail.pelda.hu, port: 993 }
    smtp: { host: mail.pelda.hu, port: 465 }
    level: draft
```

### Titkok (környezeti változók, titkosított env fájlból)

- `MAILMCP_PASSWORD_<FIÓK-ID>`: alkalmazásjelszó, fiókonként egy (az id nagybetűvel, a kötőjel aláhúzásra cserélve);
- `MAILMCP_ADMIN_PASSWORD_HASH`: a bejelentkezés argon2id hash-e (D28);
- `MAILMCP_TOTP_SECRET`: a TOTP második faktor titka, base32 (D29).

### Beállítások (környezeti változók, nem titkok)

| Változó | Jelentés | Alapérték |
|---|---|---|
| `MAILMCP_PUBLIC_URL` | A szerver nyilvános címe útvonal nélkül, ebből képződnek az erőforrás-azonosítók (D30) | nincs, kötelező |
| `MAILMCP_HOST` | A figyelt cím; konténerben `0.0.0.0` | `127.0.0.1` |
| `MAILMCP_PORT` | A figyelt port | `8787` |
| `MAILMCP_DATA_DIR` | A SQLite fájl könyvtára (D27) | `./data` |
| `MAILMCP_BEHIND_PROXY` | `1`: a kliens címe az `X-Forwarded-For` utolsó eleme (D34) | `0` |
| `MAILMCP_ACCOUNTS_FILE` | Az `accounts.yaml` helye | `accounts.yaml` |
| `MAILMCP_DEBUG` | Protokollnapló (D25) | `0` |

### Indulás

A szerver nem indul el, ha a YAML hibás, ha két fióknak azonos az id-je, ha bármelyik fiókhoz hiányzik a jelszó, ha a `MAILMCP_PUBLIC_URL`, a jelszó hash vagy a TOTP titok hiányzik vagy hibás, vagy ha a hibakereső kapcsoló nem lokális futásban van bekapcsolva (D30). A log pontosan megnevezi a hibát. Futás közbeni újratöltés nincs: fiók hozzáadása a YAML és a titkok módosítása, majd a konténer újraindítása.

## OAuth és biztonság

### OAuth szerver

- A MCP authorization specifikáció és a Claude connector dokumentáció szerint: protected resource metaadat, authorization server metaadat, CIMD (D10), authorization code flow kötelező PKCE-vel (S256).
- Az authorization server metaadat tartalmazza: `client_id_metadata_document_supported: true`, `token_endpoint_auth_methods_supported: ["none"]`, `code_challenge_methods_supported: ["S256"]`, `grant_types_supported: ["authorization_code", "refresh_token"]`, valamint `scopes_supported`-ban az `offline_access`-t, hogy a Claude refresh tokent kérjen.
- Az `/authorize` letölti a `client_id` URL-t (csak engedélyezett originről), ellenőrzi, hogy a dokumentum `client_id` mezője egyezik az URL-lel, és a `redirect_uri`-t a dokumentum `redirect_uris` listájához méri. Loopback címeknél (`localhost`, `127.0.0.1`) a port nélküli egyezés számít.
- A bejelentkező oldal a `client_id` URL hostját és a visszahívási cím hostját mutatja, nem a dokumentum önbevallott `client_name` mezőjét. Loopback visszahívásnál külön figyelmeztetés jelenik meg.
- A token az erőforráshoz kötött (RFC 8707 `resource` paraméter): a `/mcp/<fiók-id>` címre kiadott token csak ott érvényes, a `/mcp` címre kiadott minden fiókhoz. A `resource` paraméter nélküli authorize kérést a szerver elutasítja. Hogy mindkét kliens valóban küldi, azt az átvételi teszten mérjük.
- A `/token` végpont `application/x-www-form-urlencoded` törzset fogad, érvénytelen refresh tokenre `invalid_grant` hibát ad, és jóval 10 másodperc alatt válaszol.
- Access token: 1 óra. Refresh token: 30 nap, minden használatkor cserélődik, az új token ugyanabban a válaszban jön; egy már felhasznált refresh token újbóli használata visszavonja a teljes tokenláncot.
- A tokenek véletlenszerű, átlátszatlan szövegek; a SQLite csak a hash-üket tárolja. Aláírókulcs nincs.

### Bejelentkezés

- Jelszó (argon2id, D28) és TOTP (D29), egy oldalon, munkamenet süti nélkül (D31).
- Próbálkozáskorlát: 5 hibás kísérlet után 15 perc tiltás IP-nként, és globális lassítás (D34).

### Kezelés

Konténeren belüli CLI (D36): jelszó hash és TOTP titok előállítása, az engedélyezések listázása és visszavonása. Egy engedélyezés egy bejelentkezés minden tokenje, így a visszavonása az adott kliens hozzáférését szünteti meg.

### Konténer

`read_only`, tmpfs a `/tmp`-re, nem root felhasználó, `cap_drop: ALL`, `no-new-privileges`, saját hálózat a reverse proxy felé, `mem_limit`, `oom_score_adj`, `ports:` nincs.

### Levelezőszerverek felé

Kötelező TLS: 993 és 465 implicit TLS, vagy 587 kötelező STARTTLS. A tanúsítványellenőrzés konfigból sem kapcsolható ki.

### Naplózás

Levéltartalom, jelszó és token soha nem kerül a logba. Minden eszközhívásról egy sor: eszköz, fiók, eredmény, időtartam, üzenetazonosító. Címzett és tárgy sem. Kivétel csak a lokális hibakereső kapcsoló (D25).

### Hitelesítés (3. fázis döntései, 2026-11-26)

| # | Döntés | Indok |
|---|---|---|
| D26 | Futtatókörnyezet: **Node 26 LTS** (`engines` `>=26.13`). SQLite a beépített `node:sqlite` modullal (`DatabaseSync` osztály: a Node 26 új neve `Database`, de a `@types/node` 26.6.11 csak a régit ismeri, és futásidőben a kettő ugyanaz), argon2 és HMAC a beépített `node:crypto` modullal. Új futásidejű függőség nincs | A Node 26 2026-10-28 óta Active LTS, 2029-04-30-ig támogatott; a 24 2026-10-20 óta csak karbantartást kap. A 26.13.1 a `node:sqlite` betöltésekor már nem ír „experimental” figyelmeztetést (a 24.11.1 még igen). A `better-sqlite3` natív fordítást igényelne, amit a `pnpm-workspace.yaml` tilt, és a Docker image-be build eszközök kellenének |
| D27 | Tárolás: SQLite fájl a `MAILMCP_DATA_DIR` könyvtárban (`mailmcp.sqlite`, WAL mód). Táblák: engedélyezések (kliens, erőforrás, létrehozás, utolsó használat, visszavonás), tokenek (hash, engedélyezés, fajta, lejárat, felhasználás ideje), hibás bejelentkezések (IP, időpont), felhasznált TOTP lépések. Az authorization code-ok és a CIMD gyorsítótár memóriában vannak. A függőben lévő authorize kérés nem a memóriában van, hanem titkosítva a bejelentkező űrlapban (D31), a kulcsa a memóriában. Újraindításkor mind elvesznek, és a bejelentkezést újra kell kezdeni. A token 32 véletlen bájt base64url alakban, a táblában a SHA-256 hash-e áll | A 256 bites véletlen tokent nem lehet szótárral törni, ezért gyors hash elég; a lassú argon2 a jelszónak kell. A rövid életű (legfeljebb 10 perces) adatot fölösleges lemezre írni |
| D28 | Jelszó hash: argon2id a `crypto.argon2` függvénnyel, 19 MiB memória, 2 menet, 1 szál, 16 bájtos só, 32 bájtos kimenet, a szokásos `$argon2id$v=19$m=19456,t=2,p=1$<só>$<hash>` alakban. Ellenőrzés időzítés-biztos összehasonlítással. A hash-t a `hash-password` parancs állítja elő (D36) | Az OWASP ajánlott argon2id paraméterei. Node 26.13.1-en egy ellenőrzés kb. 26 ms. A Node `--env-file` a `$` jeleket változatlanul hagyja (mérve), Compose interpolációnál `$$` kell (lásd Telepítés) |
| D29 | TOTP saját megvalósítással (RFC 6238): HMAC-SHA1, 30 másodperces lépés, 6 számjegy, ±1 lépés tűrés, az RFC tesztvektoraival tesztelve. Egy már elfogadott lépés kódja nem fogadható el újra, és a nála régebbi lépéseké sem, akkor sem, ha még a tűrésen belül vannak és nem használták őket. A titok 20 véletlen bájt base32 alakban, a `totp-setup` parancs adja egy `otpauth://` címmel együtt (D36) | Kb. 40 sor a `node:crypto` HMAC-ján, ezért nem éri meg miatta függőséget behozni. Az `otpauth://` címet a Bitwarden és az authenticator appok közvetlenül felveszik |
| D30 | **A hitelesítés mindig be van kapcsolva**, lokálisan is. A `MAILMCP_PUBLIC_URL` kötelező, útvonal nélküli cím: `http://` csak loopback hostnál (`127.0.0.1`, `localhost`), különben `https://`. Az erőforrás-azonosítók `<PUBLIC_URL>/mcp` és `<PUBLIC_URL>/mcp/<fiók-id>`, az issuer maga a `MAILMCP_PUBLIC_URL`. A kérés `Host` fejlécének hostja a cím hostja kell legyen; ha van `Origin` fejléc, annak a cím originjével kell egyeznie, különben `403`. A hibakereső kapcsoló (D25) csak akkor indul el, ha a cím és a `MAILMCP_HOST` is loopback | Egy véletlenül kitett szerver se legyen bejelentkezés nélkül elérhető, és lokálisan ugyanazt a folyamatot próbáljuk ki, mint élesben. Ez váltja a 2. fázis csak lokális, hitelesítés nélküli módját |
| D31 | Authorize: a `GET /authorize` ellenőrzi a kérést (`response_type=code`, engedélyezett `client_id` és a CIMD szerinti `redirect_uri` (D35), `code_challenge_method=S256`, ismert `resource`), és a bejelentkező oldalt adja. Amíg a `client_id` és a `redirect_uri` nincs ellenőrizve, a hiba egy HTML oldal, és a szerver nem irányít át; utána a hiba átirányítás `error` paraméterrel. A függőben lévő kérés nem a memóriában van: a kliens, a visszahívás, a PKCE challenge, az erőforrás, a scope, a `state` és a lejárat AES-256-GCM-mel titkosítva a bejelentkező űrlap rejtett `request` mezőjében utazik (base64url: 12 bájt iv, tag, titkosított JSON). A kulcs 32 véletlen bájt, induláskor készül és sehol nem tárolódik, ezért újraindítás után a régi kérés ismeretlen. A kérés 10 percig él, és egyszer vezethet belépéshez: a sikeres belépés a nonce-át a lejáratig megjegyzi. A `state` legfeljebb 1 KiB (UTF-8 bájt), a hosszabbra `invalid_request` átirányítás jár, így a mező jóval a 16 KiB-os űrlapkorlát alatt marad. A `POST /authorize` a titkosított kérést, a jelszót és a TOTP kódot fogadja, csak a cím saját `Origin`-jével. Siker után 60 másodperces, egyszer használható code megy a `redirect_uri`-ra a `state` és az `iss` paraméterrel. Munkamenet süti nincs. Az oldal mutatja a `client_id` hostját, a visszahívás hostját és az erőforrást, loopback visszahívásnál figyelmeztetéssel. Fejlécek: `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; form-action 'self' <a redirect_uri originje>; frame-ancestors 'none'` (a hibaoldalon csak `'self'`), `Cache-Control: no-store`, a bejelentkező oldalon `Referrer-Policy: same-origin`, a hibaoldalon `no-referrer`. A `no-referrer` mellett a Fetch szabvány szerint a böngésző az űrlap `POST` kérésében `Origin: null` fejlécet küldene, és az `Origin` ellenőrzés `403`-mal elutasítaná; a `same-origin` más originnek nem küld hivatkozót, a visszahívásnak sem. A Chrome a `form-action`-t az űrlapra adott átirányításra is alkalmazza, ezért kell a visszahívás originje | Süti nélkül nincs sütihez kötött támadási felület (CSRF, ellopott munkamenet), és a 30 napos refresh token miatt ritkán kell belépni. A csak a szerver által előállítható, titkosított kérés és az `Origin` ellenőrzés együtt kiváltja a CSRF tokent. Mivel egy megnyitott bejelentkező oldal semmit nem foglal a szerveren, sok `GET /authorize` sem tölti meg a memóriát, és korlát sem kell rá. A hibás `redirect_uri`-ra irányítás nyitott átirányító lenne |
| D32 | Token végpont: `application/x-www-form-urlencoded`. `authorization_code`: `code`, `redirect_uri`, `client_id`, `code_verifier` kötelező és egyezik a kiadáskorival; a `resource` elhagyható, de ha van, egyezik. `refresh_token`: cserélődik, és egy már felhasznált refresh token újbóli használata az egész engedélyezést visszavonja. Minden hiba `invalid_grant` vagy `invalid_request` JSON-ben, `Cache-Control: no-store`. A válasz: `access_token`, `token_type: Bearer`, `expires_in: 3600`, `refresh_token`, `scope`. Minden refresh token a kiadásától 30 napig él | A spec „OAuth szerver” pontjai, a code a kliens, a visszahívás, a PKCE és az erőforrás négyesére kötve |
| D33 | Erőforráshoz kötés: a token csak azon az erőforráson érvényes, amelyre kiadták; a `/mcp` címre kiadott token a `/mcp/<fiók-id>` címen sem. Az ellenőrzés az SDK `requireBearerAuth` segédjével megy (`expectedResource`), a `401` az adott végpont saját metaadat címét adja | Egyetlen szabály, kivétel nélkül. A `/mcp` minden fiókot elér, ezért a „minden fiókhoz érvényes” token ott is ezt jelenti |
| D34 | Próbálkozáskorlát: IP-nként 15 percen belül 5 hibás kísérlet után 15 perc tiltás (`429`, `Retry-After`). Ha 15 percen belül mindenhonnan együtt legalább 20 hibás kísérlet volt, a bejelentkezés 3 másodpercenként csak egy kísérletet fogad, a többire `429`. Sikeres belépés törli az IP számlálóját. A jelszó hash mindig kiszámolódik, a hibaüzenet nem árulja el, melyik mező volt hibás. A kliens címe `MAILMCP_BEHIND_PROXY=1` mellett az `X-Forwarded-For` utolsó eleme, különben a kapcsolat címe. Az IPv4-be ágyazott IPv6 cím (`::ffff:1.2.3.4`) sima IPv4 lesz, minden más IPv6 cím a /64 előtagja egységes alakban (`2001:DB8::1` és `2001:db8:0:0::1` egyaránt `2001:db8:0:0::/64`) | Az infra repó Traefikje nem bízik a bejövő `X-Forwarded-For`-ban (nincs `forwardedHeaders.trustedIPs`), ezért az utolsó elemet ő írja; a korábbiakat a kliens hamisíthatja. A globális korlát a sok címről jövő próbálkozást fogja meg. Egy IPv6 végpont rendszerint egy egész /64-et kap, és abból bármelyik címet használhatja, ezért a teljes címre szabott korlát nem fogná meg |
| D35 | CIMD letöltés: csak `https://claude.ai` és `https://claude.com` originről (D10), átirányítás követése nélkül, 5 másodperces időkorláttal, legfeljebb 64 KiB, JSON. A dokumentum `client_id` mezője egyezik az URL-lel, a `token_endpoint_auth_method` `none`, a `redirect_uris` nem üres. A dokumentum 10 percig a memóriában marad, a sikertelen letöltés hibája 60 másodpercig, és addig ugyanez a hiba jön vissza. Egy `client_id`-hoz egyszerre egy letöltés fut, az egyidejű kérések ezen osztoznak. Összesen legfeljebb 4 letöltés fut egyszerre; a további, gyorsítótárban nem lévő `client_id` azonnal hibát kap („Too many client metadata requests, try again.”), nem áll sorba. A terhelés miatti elutasítás nem kerül a hibák közé | Az átirányítás követése kivinné a letöltést az engedélyezett originről. A Claude a discovery-re és a tokenre 10 másodpercet vár, a letöltésnek bele kell férnie. Az engedélyezett originen bárki bármilyen útvonalat megadhat `client_id`-ként, ezért a korlátok nélkül a szerver tetszőleges számú kimenő kérést indítana |
| D36 | CLI: `pnpm cli <parancs>` (fejlesztésben), `node dist/cli.js <parancs>` (konténerben). Parancsok: `hash-password` (rejtve bekéri a jelszót, csak a hash-t írja ki), `totp-setup` (új titok és `otpauth://` cím), `tokens list` (engedélyezések: id, kliens host, erőforrás, létrehozás, utolsó használat), `tokens revoke <id>`. A Docker healthcheck parancs a 4. fázisba kerül | A titkok előállítása is a szerver kódjával megy, így a formátum biztosan egyezik |
| D37 | Naplózás: minden OAuth eseményről egy sor (elutasított authorize kérés, bejelentkezés sikere, hibája vagy tiltása, kiadott token, csere, a refresh token vagy a code újrafelhasználása miatti visszavonás) a kliens hostjával, az erőforrással és a kliens IP-címével; az IP minden eseménynél ott van, a D34 szerinti alakban. Token, code, jelszó és TOTP kód soha | A „Naplózás” pont szabálya az OAuth eseményekre |

Az OAuth végpontok hibái az RFC 6749 szerinti JSON-ök (`error`, `error_description`), nem a levéleszközök hibakódjai.

## Deploy

### App repó

- Publikus GitHub repó, tooling a WebFetch mintájára (pnpm, TypeScript, ESLint, Prettier, vitest, husky).
- GitHub Actions: lint, típusellenőrzés, tesztek, image build, push a ghcr.io-ra `:latest` címkével.

### Telepítés

A konkrét telepítés (hostnév, reverse proxy, titkok, mentés) egy külön, privát infra repóban él, annak konvencióival. Ez a repó csak az általános követelményeket rögzíti:

- Docker Compose szolgáltatás, publikált port nélkül; a forgalmat egy TLS-t lezáró reverse proxy hozza egy nyilvános HTTPS hostnévről (a claude.ai az Anthropic szervereiről hívja, ezért belső vagy VPN mögötti cím nem jó);
- `mem_limit: 256m`, `NODE_OPTIONS=--max-old-space-size=170` (a limit kb. kétharmada);
- `oom_score_adj` pozitív: memóriaszűkénél ez a szolgáltatás álljon le a fontosabbak előtt, a levelezés néhány perc kiesést elbír;
- a SQLite named volume-on van, és a mentése alatt a konténer áll (WAL miatt);
- `accounts.yaml` csak olvashatóként csatolva, a titkok titkosított env fájlból. Compose interpolációnál az argon2 hash `$` jeleit `$$`-ra kell cserélni.

### Health check

Docker healthcheck, amely a konténeren belül futtat egy CLI parancsot (nem HTTP útvonal). Külső figyelés (UptimeRobot) a nyilvános OAuth metaadat végpontra állítható.

## Tesztelés

TDD: előbb a teszt, aztán a kód.

| Szint | Mit | Eszköz |
|---|---|---|
| Unit | konfig validáció, Gmail szintaxis fordítása IMAP SEARCH-re, azonosító kódolás, jogosultsági szűrés, OAuth (PKCE, visszahívási lista, erőforráshoz kötés, refresh csere, újrafelhasználás), próbálkozáskorlát | vitest |
| Integráció | keresés, olvasás, piszkozat, címke, kuka, küldés valódi IMAP és SMTP szerveren | GreenMail konténer, CI-ban is |
| Gmail kiterjesztések | `X-GM-RAW`, `X-GM-THRID`, `X-GM-LABELS` | unit: rögzített szerverválaszok; élesben: teszt Gmail fiók, kézi átvétel |
| Átvétel | teljes OAuth folyamat mindkét klienssel, fiókhoz kötés, szintek | MCP Inspector lokálisan, majd claude.ai connector és egy mappánkénti `.mcp.json` |

Tesztlevél csak Alex saját, plusz jeles teszt címére megy (`<cím>+mailmcp-<bármi>@gmail.com`), valódi partnerhez soha. A pontos címet a repó nem tartalmazza.

## Mért tények

| Tény | Forrás és mérés módja |
|---|---|
| A `@modelcontextprotocol/server` 2.4.0 auth exportjai: `requireBearerAuth`, `verifyBearerToken`, `bearerAuthChallengeResponse`, `buildOAuthProtectedResourceMetadata`, `getOAuthProtectedResourceMetadataUrl`, `oauthMetadataResponse`, `checkResourceAllowed`, `OAuthError`. Authorize, token vagy regisztrációs végpont megvalósítása nincs benne | `npm pack @modelcontextprotocol/server@2.4.0`, a `dist/*.d.mts` exportjai és az `authorization_endpoint`, `registration_endpoint`, `code_challenge` kulcsok keresése a `dist` fájlokban (2026-11-22) |
| A claude.ai, Desktop, mobil és Cowork visszahívási címe: `https://claude.ai/api/mcp/auth_callback`. Egy régebbi Anthropic cikk szerint később `https://claude.com/api/mcp/auth_callback` is lehet | [Authentication for connectors](https://claude.com/docs/connectors/building/authentication) (2026-11-22) |
| A Claude CIMD-t választ, ha a metaadatban `client_id_metadata_document_supported: true` és `token_endpoint_auth_methods_supported` tartalmazza a `none` értéket; különben DCR-re vált | ugyanott |
| A Claude Code CIMD dokumentuma: `client_id` = `https://claude.ai/oauth/claude-code-client-metadata`, `redirect_uris` = `http://localhost/callback`, `http://127.0.0.1/callback`, `token_endpoint_auth_method` = `none`. A port véletlenszerű, port nélküli egyezés kell | a dokumentum letöltése (2026-11-22, változatlan 2026-11-26) |
| A bejelentkezés csak `401` válaszra indul `WWW-Authenticate: Bearer resource_metadata=...` fejléccel; a metaadat `resource` mezőjének pontosan egyeznie kell a csatolt URL-lel, útvonallal együtt | [Authentication for connectors](https://claude.com/docs/connectors/building/authentication), [Lazy authentication](https://claude.com/docs/connectors/building/lazy-authentication) (2026-11-22) |
| Időkorlátok: discovery és token 10 s, refresh 30 s. A Claude legfeljebb 5 perccel lejárat előtt és `401`-re frissít | [Authentication for connectors](https://claude.com/docs/connectors/building/authentication) (2026-11-22) |
| Az Anthropic kimenő forgalma a `160.79.104.0/21` tartományból jön | ugyanott |
| A GreenMail 2.1.15 képességei: `IMAP4rev1 LITERAL+ UIDPLUS SORT IDLE MOVE SASL-IR AUTH=XOAUTH2 QUOTA`; SPECIAL-USE nincs, alapból csak INBOX van; APPEND után visszaadja az új UID-t és a UIDVALIDITY-t | `greenmail/standalone:2.1.15` konténer, imapflow `capabilities`, `list()`, `append()` (2026-11-23) |
| Az imapflow 2.12.2 `messageDelete` UIDPLUS nélkül sima `EXPUNGE`-t küld (a mappa minden `\Deleted` levelét törli), a `messageMove` MOVE nélkül COPY, `\Deleted` és ugyanez az EXPUNGE | `dist/cjs/commands/expunge.js`, `move.js` (2026-11-23) |
| A nodemailer 10.6.1 ESM csomag saját `.d.ts` típusokkal (a `@types/nodemailer` nem kell); van `disableFileAccess`, `disableUrlAccess`, `keepBcc` | `npm pack nodemailer@10.6.1`, `dist/esm` (2026-11-23) |
| Az MCP SDK 2.4.0 alapból legfeljebb 4 MiB-os kéréstörzset fogad (`DEFAULT_MAX_REQUEST_BODY_SIZE`), a `maxRequestBodySize` opcióval állítható | `dist/index.mjs` (2026-11-23) |
| A Node 26 2026-10-28 óta Active LTS (Lithium), vége 2029-04-30; a Node 24 2026-10-20 óta maintenance. Legfrissebb: 26.13.1 (2026-11-10) | `nodejs.org/dist/index.json`, `nodejs/Release` `schedule.json` (2026-11-26) |
| A `node:sqlite` a 26.13.1 dokumentációjában „1.2 Release candidate”, de a `lib/sqlite.js` már nem hívja az `emitExperimentalWarning`-ot (a 24.11.1 igen). Az osztály neve `Database`, a `DatabaseSync` csak alias (DEP0210). A `crypto.argon2Sync('argon2id', …)` 19 MiB-tal kb. 26 ms | a `v26.13.1` és `v24.11.1` tag `lib/sqlite.js` fájlja, `api/sqlite.json`; `fnm exec --using=26.13.1 node -e …` (2026-11-26) |
| Az SDK `requireBearerAuth` `expectedResource` opciója a verifier által adott `AuthInfo.resource`-szal hasonlít (töredék és egy záró perjel nélkül), és elutasítja a lejárat nélküli tokent. A `buildOAuthProtectedResourceMetadata` localhoston kívül HTTPS issuert követel | `dist/index.d.mts` (2026-11-26) |
| Az infra repó Traefikje nem bízik a bejövő `X-Forwarded-For`-ban (nincs `forwardedHeaders.trustedIPs`), és felülírja | `proxy/docker-compose.yml`, `kaneo/docker-compose.yml` megjegyzése (2026-11-26) |
| A Node `--env-file` a `$` jeleket változatlanul hagyja (az argon2 hash idézőjel nélkül is épen jön át) | `node --env-file` egy `$argon2id$…` értékkel (2026-11-26) |

Nem mérhető most, az átvételi teszten mérjük: hogy a claude.ai (hosztolt) kliens a mi szerverünkkel valóban CIMD-t választ-e, és hogy mindkét kliens küldi-e a `resource` paramétert. A Claude Code-ot a 3. fázis végén lokálisan (`http://127.0.0.1`) mérjük: a szerver a CIMD dokumentumot kimenő kéréssel tölti le a claude.ai-ról, a visszahívás pedig loopback, ezért ehhez nem kell nyilvános cím. A claude.ai csak a 4. fázis nyilvános telepítése után próbálható ki, mert az Anthropic szervereiről hívja a szervert.

A 2. fázis kézi próbáján (2026-11-25) mért eredmények: a Gmail SMTP egy példányt ment a Sent mappába, a törölt piszkozat a kukába kerül, a kukából visszaállított levél a címkéit megtartja, a beérkezettek címkéjét nem; a work fiók Courier-IMAP szervere UIDPLUS-t ad, MOVE-ot és SPECIAL-USE-t nem, a Sent mappát név alapján találja meg; az IMAP ENVELOPE a hiányzó Reply-To helyett a From címet adja. Az eredeti mérési lista:

A 2. fázis kézi próbáján mérjük valódi Gmaillel és egy nem Gmail szerverrel: a UIDPLUS és MOVE megléte, hogy a Gmail SMTP valóban menti-e a küldött levelet, hogy a Gmail a Drafts mappából eltávolított piszkozatot törli-e, és hogy a kukából az „Összes levél” mappába áthelyezett levél visszakapja-e a címkéit.

## Feature requestek (nem része az első verziónak)

- **Gmail API adapter** a Gmail fiókokhoz: aláírás kiolvasása, a connectorral azonos címkeazonosítók. Google Cloud projekt és fiókonkénti OAuth hozzájárulás kell hozzá. Ellenőrizendő a Google dokumentációjában: tesztelési módban lévő alkalmazásnál a refresh tokenek 7 nap után lejárnak.
- **XOAUTH2 bejelentkezés IMAP/SMTP-re**: ha egy Workspace admin tiltja az alkalmazásjelszót, vagy a Google szigorít. Ugyanazon az IMAP rétegen.
- **Több felhasználó**: felhasználókezelés, felhasználónkénti fiókkészlet. Az `owner` mező már előkészíti.
- **POP3 adapter**: csak ha egy fióknak tényleg nincs IMAP-ja (lásd D3).
- **Fiókhoz kötött API token** CI-ból vagy szkriptből való híváshoz.
