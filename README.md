# MailMCP

Távoli MCP szerver, amelyen keresztül a Claude egyszerre több postafiókot kezel: Gmailt, Google Workspace-t és bármilyen IMAP/SMTP fiókot. A képességei a Claude beépített Gmail connectoráét követik (keresés, olvasás, mellékletek, piszkozatok, címkék, kuka, küldés), csak nem egy, hanem tetszőleges számú fiókra.

> **Állapot:** 3. fázis kész: OAuth bejelentkezés (jelszó és TOTP), lokálisan is kötelező. A nyilvános telepítés (Docker, reverse proxy) a 4. fázisban jön.

## Mire jó

- **claude.ai connectorként** minden fiók egy helyen látszik, és a keresés egyszerre több fiókban is fut.
- **Claude Code-ban mappánként** pontosan egy fiók csatolható. Így egy projektmappa csak a hozzá tartozó postafiókot látja.
- **Fiókonkénti jogosultsági szint:** `read` (csak olvasás), `draft` (piszkozat és rendszerezés, küldés nélkül), `send` (minden).

## Csatolás

### claude.ai

A claude.ai [Connectors oldalán](https://claude.ai/customize/connectors) **Add**, majd **Add custom connector**, és az URL:

```text
https://mailmcp.example.com/mcp
```

Az első használatkor a szerver bejelentkező oldala nyílik meg (jelszó és TOTP).

Soha ne lépj be olyan bejelentkező oldalon, amelyet nem te nyitottál meg a Claude-ból: egy idegen link a saját programjának kérhet így hozzáférést.

### Claude Code, egy mappához egy fiók

A mappa gyökerében egy `.mcp.json`:

```json
{
  "mcpServers": {
    "mail": {
      "type": "http",
      "url": "https://mailmcp.example.com/mcp/ceges"
    }
  }
}
```

Az URL végén a fiók azonosítója áll. Ezen a címen a szerver csak azt az egy fiókot mutatja, és a kiadott token máshol nem érvényes. A fájlban nincs titok, nyugodtan commitolható.

## Lokális futtatás

A hitelesítés lokálisan is be van kapcsolva: minden kliens a szerver bejelentkező oldalán lép be.

Node 26.13 vagy újabb kell. fnm-mel a `fnm use` a `.node-version` fájl alapján választja ki.

1. `cp accounts.example.yaml accounts.yaml`, és töltsd ki a saját fiókjaiddal (ez a fájl gitignore-olt).
2. `cp .env.example .env`, és írd be minden fiókhoz az alkalmazásjelszót (ez a fájl is gitignore-olt). A változók nevének szabálya a `.env.example` elején van. Élesben ugyanezek a változók a deploy env fájljából jönnek.
3. `pnpm install`
4. `pnpm cli hash-password`: rejtve kétszer bekéri a bejelentkezési jelszót (legalább 12 karakter), és kiírja a hash-t. Ez kerül a `.env` `MAILMCP_ADMIN_PASSWORD_HASH` sorába.
5. `pnpm cli totp-setup`: az első sor a `MAILMCP_TOTP_SECRET` értéke, a második `otpauth://` sort a Bitwarden vagy egy authenticator app veszi fel.
6. `pnpm dev`. A `.env.example` szerinti `MAILMCP_PUBLIC_URL=http://127.0.0.1:8787` lokálisan jó így.
7. Claude Code-ban: `claude mcp add --transport http mail-local http://127.0.0.1:8787/mcp`, vagy egy fiókhoz: `.../mcp/<fiók-id>`. Az első híváskor a Claude Code böngészőben nyitja meg a bejelentkező oldalt.

A fiók szintjét az `accounts.yaml` fiókonkénti `level` mezője adja (`read`, `draft`, `send`). Küldeni csak `send` szinten lehet.

Tesztlevelet csak a saját címed `+mailmcp-<bármi>` alakjára küldj, soha valódi másik címzettnek.

A belépések listája: `pnpm cli tokens list`. Egy belépés visszavonása: `pnpm cli tokens revoke <id>`; utána az a kliens újra bejelentkezést kér. Az adatbázis a `data/` könyvtárban van (`MAILMCP_DATA_DIR`).

`MAILMCP_DEBUG=1` bekapcsolja az IMAP és SMTP protokoll naplóját a stderr-en (a jelszót az imapflow és a nodemailer is kitakarja). A napló a levéltartalmat is kiírja, ezért csak lokális hibakereséshez való: a szerver csak akkor indul el vele, ha a `MAILMCP_PUBLIC_URL` és a `MAILMCP_HOST` is loopback cím. Az induló sor jelzi, hogy be van kapcsolva. Alapértelmezés: `0`.

Fejlesztéshez: `pnpm test` (Docker kell a GreenMail integrációs tesztekhez), `pnpm test:unit` (Docker nélkül).

## Hogyan működik

- Egyetlen Node folyamat Docker konténerben, Streamable HTTP transzporttal.
- Minden fiók IMAP-on és SMTP-n érhető el, fiókonkénti alkalmazásjelszóval. Gmailnél a szerver a Gmail saját IMAP kiterjesztéseit használja, ezért a keresés a megszokott Gmail szintaxissal megy (`from:`, `has:attachment`, `newer_than:7d`).
- A szerver nem tárol és nem indexel levelet.
- A Claude kliensek OAuth-tal lépnek be (PKCE, Client ID Metadata Document, erőforráshoz kötött tokenek).

A részletek, a döntések indoklásával együtt, a [specben](docs/superpowers/specs/2026-11-22-mailmcp-design.md) vannak.

## Amit szándékosan nem tud

- **POP3:** a POP3 csak letölti a beérkezett leveleket, nincsenek benne mappák, címkék, jelzők és szerveroldali keresés. Ezek pótlásához saját levélindex kellene, ami nagyjából megduplázná a projektet. Indoklás: a spec D3 döntése.
- **Végleges törlés:** a levél legfeljebb a kukába kerül, ahogy a Claude Gmail connectorában is.

A tervezett bővítések (Gmail API adapter, XOAUTH2, több felhasználó) a spec „Feature requestek” fejezetében vannak.
