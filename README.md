# MailMCP

Távoli MCP szerver, amelyen keresztül a Claude egyszerre több postafiókot kezel: Gmailt, Google Workspace-t és bármilyen IMAP/SMTP fiókot. A képességei a Claude beépített Gmail connectoráét követik (keresés, olvasás, mellékletek, piszkozatok, címkék, kuka, küldés), csak nem egy, hanem tetszőleges számú fiókra.

> **Állapot:** tervezés. A szerver még nem működik. A jóváhagyott terv: [docs/superpowers/specs/2026-11-22-mailmcp-design.md](docs/superpowers/specs/2026-11-22-mailmcp-design.md).

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
