# MailMCP: 4. fázis (Docker, CI, telepítés, átvétel) implementációs terv

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A szerver Docker image-ként a ghcr.io-ra kerül a CI-ből, az infra repó `mailmcp` stackjeként fut a `https://mailmcp.csalex.dev` címen, és a claude.ai connectorként csatolható. A kliensazonosítás az átvétel után a mért pontos `client_id` URL-ekre szűkül.

**Architecture:** Az app repóban: a naplóba a teljes `client_id` kerül (Task 1), új `health` CLI parancs (Task 2), Dockerfile (Task 3), GitHub Actions (Task 4), dokumentáció (Task 5). Az infra repóban (`P:\00_Store\infra`, saját konvenciókkal): a stack, a hálózat és a figyelés (Task 6), az élesítés (Task 7). Végül az átvétel és a mért értékek rögzítése (Task 8, 9).

**Tech Stack:** a 3. fázisé. Új függőség nincs. CI: `actions/checkout@v7`, `pnpm/action-setup@v6`, `actions/setup-node@v7`, `docker/login-action@v4`, `docker/metadata-action@v6`, `docker/setup-buildx-action@v4`, `docker/build-push-action@v7`.

**Spec:** [`docs/superpowers/specs/2026-11-22-mailmcp-design.md`](../specs/2026-11-22-mailmcp-design.md), különösen a „Deploy” fejezet és a „Telepítés (4. fázis döntései)” tábla (D38-D48).

---

## Global Constraints

Az 1-3. fázis tervének Global Constraints része változatlanul érvényes (commit kapu, nincs AI attribution, függőség csak csomagkezelővel, TypeScript 6.0.3, `any` tilos, ESM `.js` importok, log csak stderr-re, titok soha nem kerül logba vagy tesztbe valódi értékkel). Ezen felül:

- **Élő rendszer:** a szerverre ható minden lépés (hálózat létrehozása, infra push, deploy, Kuma `apply`) előtt a pontos parancs és az ok, és Alex OK-ja. Olvasni szabad. A szerver műveletek az infra repó `scripts\*.ps1` scriptjeivel mennek, nem kézi SSH-val.
- **Titok:** a `.sops.env` tartalmát senki nem nézi és nem fejti vissza. A nyers `mailmcp/.env`-et Alex írja, a `Protect-StackEnv.ps1` titkosítja.
- **Infra repó:** a `main` ágra commitolunk (ott nincs PR), a push maga a deploy: 5 percen belül élesedik. A commit kapu ugyanaz.
- **Ellenőrzés:** minden factual állítást, amit kommentbe vagy dokumentumba írsz, vess össze a kóddal, a tervben szereplő állításokat is.

## Könyvtár tények (mérve 2026-11-26)

- **Actions legfrissebb kiadásai:** checkout v7.0.1, setup-node v7.1.0, pnpm/action-setup v6.1.1, login-action v4.8.0, metadata-action v6.2.0, setup-buildx-action v4.4.1, build-push-action v7.4.0 (`gh api repos/<repo>/releases/latest`). A workflow a major címkét használja, mint a journal repó.
- **`node:26.13.1-alpine3.24`:** létezik (Docker Hub), nincs benne corepack, npm 11.20.0, `node` felhasználó uid/gid 1000.
- **Lokális Docker:** 29.6.2, a build és a konténer itt kipróbálható.
- **pnpm:** `packageManager` `pnpm@12.21.0+sha512...`; a `pnpm-workspace.yaml` `allowBuilds` minden build scriptet tilt, natív modul nincs.
- **Az SQLite fájl:** `<MAILMCP_DATA_DIR>/mailmcp.sqlite` (`STORE_FILE_NAME`, `src/store/store.ts`), mellette `-wal` és `-shm`.
- **AS metaadat útvonala:** `AUTHORIZATION_SERVER_METADATA_PATH` (`src/http/oauth-routes.ts`).
- **Infra repó mintái:** saját Node app SQLite-tal: `journal/docker-compose.yml` (`x-svc` anchor, `mem_limit`, `NODE_OPTIONS`, Traefik címkék, `traefik.docker.network`). Hostnév: `<stack>/stack.vars` `APP_HOST=...`, a compose-ban `${APP_HOST:?}`. Belső háló a Traefikkel: `admin_network` (`bin/vps-from-scratch.sh` hozza létre `--internal`-lal, a `proxy/docker-compose.yml` külső hálóként hivatkozik rá). Végpontok és várt kódok: `common/endpoints.json`, ezt olvassa a `scripts/Test-PublicEndpoints.ps1` és a `kuma/tofu`. Stackek táblája: `README.md` „Stackek”. Az `oom_score_adj` értékek indoka: `README.md` „Compose konvenciók”.

## Review Focus

1. **Konténer jogosultság:** nem root, `read_only`, `cap_drop: ALL`, nincs `ports:`, a `/data` az egyetlen írható kötet a `/tmp` mellett.
2. **Hálózat:** a `mailmcp` nincs a `proxy_network`-ön; a Traefik a `mailmcp_network`-ön éri el, a kimenő forgalom a saját hálóján megy (D42).
3. **Titok az image-ben vagy a CI-ben:** a `.dockerignore` kizárja a `.env*`, `accounts.yaml`, `data/` fájlokat; a CI csak `GITHUB_TOKEN`-t használ, `packages: write` csak az image jobban.
4. **Egy hely:** a Node verzió (`.node-version`), a hostnév (`APP_HOST`), a várt végpont kódok (`common/endpoints.json`).

---

## Fájlszerkezet (4. fázis)

| Fájl | Felelősség |
|---|---|
| `src/log.ts`, `src/auth/flow.ts` | D47: a `client` mező a teljes `client_id` |
| `src/config/runtime.ts`, `src/cli.ts` | D40: `health` parancs |
| `Dockerfile`, `.dockerignore` (új) | D39 |
| `tests/unit/dockerfile.test.ts` (új) | A `FROM` sorok Node verziója egyezik a `.node-version`-nel |
| `.github/workflows/ci.yml` (új), `package.json` (`format:check`) | D41 |
| `README.md` | Konténeres futtatás, állapot |
| infra: `mailmcp/docker-compose.yml`, `mailmcp/stack.vars`, `mailmcp/accounts.yaml`, `mailmcp/.sops.env` (új) | A stack |
| infra: `proxy/docker-compose.yml`, `bin/vps-from-scratch.sh` | `mailmcp_network` |
| infra: `common/endpoints.json`, `README.md` | Figyelés, stack tábla |

---

### Task 1: A teljes `client_id` a naplóban (D47)

**Files:**
- Modify: `src/log.ts` (`AuthEventRecord.client` doc komment), `src/auth/flow.ts` (a két `clientHost(...)` hívás a naplórekordban)
- Modify: a tesztek, amelyek `client: 'claude.ai'`-t várnak (`grep -rn "client: 'claude.ai'" tests`)

- [ ] **Step 1:** A tesztekben a várt érték a teljes URL (például `https://claude.ai/oauth/claude-code-client-metadata`). Futtatás: piros.
- [ ] **Step 2:** A `flow.ts` naplórekordjában a `client` a `clientId` maga (vagy `null`, ha nincs). A `clientHost` a bejelentkező oldalon és a `tokens list`-ben marad (D36). Komment: „The client_id URL (D47).”
- [ ] **Step 3:** `pnpm test:unit`, `pnpm typecheck`, `pnpm lint` zöld.

### Task 2: `health` parancs (D40)

**Files:**
- Modify: `src/config/runtime.ts`, `src/cli.ts`, `tests/unit/cli.test.ts`, `tests/unit/runtime.test.ts`

**Interfaces:**
- Produces: `export function loadHealthTarget(env): { host: string; port: number; hostHeader: string }` a `runtime.ts`-ben. Ugyanazokkal a függvényekkel olvassa a `MAILMCP_PUBLIC_URL`-t, a `MAILMCP_HOST`-ot (alapérték ugyanaz a konstans, mint a `loadRuntime`-ban) és a `MAILMCP_PORT`-ot, a titkokat nem kéri. A `host` `0.0.0.0` helyett `127.0.0.1`, `::` helyett `::1`. A `hostHeader` a nyilvános cím `host` része (porttal, ha van).
- Produces: `pnpm cli health` / `node dist/cli.js health`.

- [ ] **Step 1:** Tesztek a `runtime.test.ts`-ben: a két helyettesítés, az alapértékek, hibás cím vagy port hibát dob.
- [ ] **Step 2:** Tesztek a `cli.test.ts`-ben egy valódi `node:http` szerverrel `127.0.0.1`-en, véletlen porton: 200 esetén 0 a kilépési kód és nincs kimenet a stderr-en; a kérés `Host` fejléce a nyilvános cím hostja, az útvonal `AUTHORIZATION_SERVER_METADATA_PATH`; 503 esetén 1 és egy sor `health: HTTP 503`; csatlakozási hiba esetén 1 és `health: <hibaosztály>` (a `log.ts` `errorClass` szerint, üzenet nélkül); 3 s után válaszoló szervernél 1 (`health: timeout`; a teszt az időkorlátot paraméterként kapja, hogy gyors legyen). Hibás env esetén 1, a `loadHealthTarget` üzenetével.
- [ ] **Step 3:** Megvalósítás `node:http` `request`-tel (a `fetch` nem enged `Host` fejlécet), a válasz törzsét eldobva. A `USAGE`-be: `health                 Check that the server answers (the Docker healthcheck)`.
- [ ] **Step 4:** Kézzel: `pnpm dev` mellett `pnpm cli health` kilépési kódja 0 (`echo $LASTEXITCODE`), leállított szervernél 1.
- [ ] **Step 5:** `pnpm test:unit`, `typecheck`, `lint` zöld.

### Task 3: Dockerfile (D39)

**Files:**
- Create: `Dockerfile`, `.dockerignore`, `tests/unit/dockerfile.test.ts`

- [ ] **Step 1:** A teszt beolvassa a `Dockerfile`-t és a `.node-version`-t, és minden `FROM node:` sor image-e `node:<.node-version>-alpine` kezdetű. Legalább egy ilyen sor van. Futtatás: piros (nincs Dockerfile).
- [ ] **Step 2:** Dockerfile, három réteg:
  ```dockerfile
  FROM node:26.13.1-alpine3.24 AS base
  WORKDIR /app
  COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
  # No corepack in the Node 26 image: install the pnpm version package.json pins.
  RUN npm install -g "pnpm@$(node -p "require('./package.json').packageManager.split('+')[0].split('@')[1]")"

  FROM base AS build
  RUN pnpm install --frozen-lockfile --ignore-scripts
  COPY tsconfig.json tsconfig.build.json ./
  COPY src ./src
  RUN pnpm build

  FROM base AS prod-deps
  RUN pnpm install --frozen-lockfile --ignore-scripts --prod

  FROM node:26.13.1-alpine3.24
  ENV NODE_ENV=production \
      MAILMCP_HOST=0.0.0.0 \
      MAILMCP_DATA_DIR=/data \
      MAILMCP_ACCOUNTS_FILE=/config/accounts.yaml
  WORKDIR /app
  RUN mkdir /data && chown node:node /data
  COPY package.json ./
  COPY --from=prod-deps /app/node_modules ./node_modules
  COPY --from=build /app/dist ./dist
  USER node
  EXPOSE 8787
  HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD ["node", "dist/cli.js", "health"]
  CMD ["node", "dist/main.js"]
  ```
  A `base` réteget a végső réteg nem örökli, így abban nincs pnpm. A `package.json` a `"type": "module"` miatt kell.
- [ ] **Step 3:** `.dockerignore`: `node_modules`, `dist`, `data`, `coverage`, `.git`, `.github`, `.husky`, `.superpowers`, `docs`, `tests`, `.env`, `.env.*`, `accounts.yaml`, `*.log`.
- [ ] **Step 4:** Mérés: `docker build -t mailmcp:local .`, az image mérete (`docker image ls mailmcp:local`), `docker run --rm mailmcp:local id` → uid 1000, `docker run --rm --entrypoint sh mailmcp:local -c 'command -v pnpm || echo none'` → `none`. Futtatás kitalált titkokkal (`pnpm cli hash-password` egy próbajelszóra, `pnpm cli totp-setup`), az `accounts.example.yaml` csatolva, `--read-only --tmpfs /tmp --cap-drop ALL`, egy named volume a `/data`-ra, `MAILMCP_PUBLIC_URL=https://mailmcp.example` és `-p 127.0.0.1:8799:8787`: a `docker inspect --format '{{.State.Health.Status}}'` `healthy` lesz, `curl -H 'Host: mailmcp.example' http://127.0.0.1:8799/mcp` → `401`. A memória üresjáratban: `docker stats --no-stream`.
- [ ] **Step 5:** `pnpm test:unit`, `lint`, `format:check` zöld (a `format:check` a Task 4-ben jön; addig `pnpm exec prettier --check .`).

### Task 4: CI (D41)

**Files:**
- Create: `.github/workflows/ci.yml`
- Modify: `package.json` (`"format:check": "prettier --check ."` a `pnpm pkg set` paranccsal)

- [ ] **Step 1:** Workflow:
  ```yaml
  name: CI
  on:
    push:
      branches: [main]
    pull_request:
      branches: [main]
  concurrency:
    group: ${{ github.workflow }}-${{ github.ref }}
    cancel-in-progress: true
  permissions:
    contents: read
  jobs:
    check:
      name: Lint, typecheck, test and build
      runs-on: ubuntu-latest
      steps:
        - uses: actions/checkout@v7
        - uses: pnpm/action-setup@v6
        - uses: actions/setup-node@v7
          with:
            node-version-file: .node-version
            cache: pnpm
        - run: pnpm install --frozen-lockfile
        - run: pnpm lint
        - run: pnpm typecheck
        - run: pnpm format:check
        - run: pnpm test
        - run: pnpm build
    image:
      name: Build and push the image
      needs: check
      if: github.event_name == 'push' && github.ref == 'refs/heads/main'
      runs-on: ubuntu-latest
      permissions:
        contents: read
        packages: write
      steps:
        - uses: actions/checkout@v7
        - uses: docker/login-action@v4
          with:
            registry: ghcr.io
            username: ${{ github.actor }}
            password: ${{ secrets.GITHUB_TOKEN }}
        - id: meta
          uses: docker/metadata-action@v6
          with:
            images: ghcr.io/${{ github.repository_owner }}/mailmcp
            tags: |
              type=sha,prefix=sha-
              type=raw,value=latest
        - uses: docker/setup-buildx-action@v4
        - uses: docker/build-push-action@v7
          with:
            context: .
            push: true
            tags: ${{ steps.meta.outputs.tags }}
            labels: ${{ steps.meta.outputs.labels }}
            cache-from: type=gha
            cache-to: type=gha,mode=max
  ```
  Az image neve kisbetűs, ezért nem a `github.repository` (`MailMCP`).
- [ ] **Step 2:** `pnpm format:check` lokálisan zöld. A workflow valódi mérése a PR-on: `gh pr checks --watch`.

### Task 5: Dokumentáció

**Files:**
- Modify: `README.md`

- [ ] **Step 1:** Állapot: 4. fázis, konténerben fut. Új „Konténer” rész: az image (`ghcr.io/csiszaralex/mailmcp`), a kötelező env változók (a „Beállítások” táblára hivatkozva, nem másolva), a `/data` kötet, az `accounts.yaml` a `/config`-ba csatolva, a CLI a konténerben (`docker compose exec mailmcp node dist/cli.js tokens list`), a healthcheck.
- [ ] **Step 2:** Prettier a README-re.

**Az app repó lezárása:** az utolsó task után záró review (fable), javítások, push, `gh pr create`, `gh pr checks --watch`, merge Alex szavára. A merge után a CI image jobja lefut: `gh run list --workflow CI --limit 1`, és az image megvan (`gh api /users/csiszaralex/packages/container/mailmcp/versions --jq '.[0].metadata.container.tags'`).

### Task 6: Az infra stack

**Files (infra repó):**
- Create: `mailmcp/docker-compose.yml`, `mailmcp/stack.vars` (`APP_HOST=mailmcp.csalex.dev`), `mailmcp/accounts.yaml`
- Create (Alex): `mailmcp/.sops.env` a `Protect-StackEnv.ps1`-gyel
- Modify: `proxy/docker-compose.yml` (a `traefik` szolgáltatás a `mailmcp_network`-ön is, a `networks:` alatt külsőként), `bin/vps-from-scratch.sh` (`docker network create --internal mailmcp_network`, az `admin_network` mintájára és indokával), `common/endpoints.json`, `README.md` („Stackek” sor, az `oom_score_adj` sor kiegészítése a `+500`-zal és az okával)

- [ ] **Step 1:** Compose, a `journal` mintájára:
  ```yaml
  name: mailmcp
  x-svc: &svc
    restart: unless-stopped
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "3"
  services:
    mailmcp:
      <<: *svc
      image: ghcr.io/csiszaralex/mailmcp:latest
      mem_limit: 256m
      oom_score_adj: 500
      read_only: true
      tmpfs:
        - /tmp:size=16m
      cap_drop: [ALL]
      env_file: .env
      environment:
        MAILMCP_PUBLIC_URL: https://${APP_HOST:?}
        MAILMCP_BEHIND_PROXY: "1"
        NODE_OPTIONS: --max-old-space-size=170
      volumes:
        - mailmcp_data:/data
        - ./accounts.yaml:/config/accounts.yaml:ro
      labels:
        - "traefik.enable=true"
        - "traefik.http.routers.mailmcp.rule=Host(`${APP_HOST:?}`)"
        - "traefik.http.routers.mailmcp.entrypoints=websecure"
        - "traefik.http.routers.mailmcp.tls.certresolver=myresolver"
        - "traefik.http.services.mailmcp.loadbalancer.server.port=8787"
        - "traefik.docker.network=mailmcp_network"
      networks:
        - mailmcp_network
        - egress
  volumes:
    mailmcp_data:
      name: mailmcp_data
  networks:
    mailmcp_network:
      external: true
    egress:
  ```
  A fejkomment a `money` stack mintájára: mi ez, a kód helye, nincs mentés (D43) és miért, a titkok neve (érték nélkül), a hálózat oka (D42).
- [ ] **Step 2:** `accounts.yaml`: Alex adja, a lokális fájl tartalma. Ez valódi címeket tartalmaz, ezért csak a privát infra repóba kerül.
- [ ] **Step 3:** `.sops.env`: Alex a `mailmcp/.env`-be írja: `MAILMCP_PASSWORD_<ID>` fiókonként, `MAILMCP_ADMIN_PASSWORD_HASH` (új jelszóból, a `$` jelek `$$`-ra cserélve), `MAILMCP_TOTP_SECRET` (új). Utána `.\scripts\Protect-StackEnv.ps1 mailmcp`.
- [ ] **Step 4:** `common/endpoints.json`: `{ "url": "https://mailmcp.csalex.dev/.well-known/oauth-authorization-server", "expect": "200" }` és `{ "url": "https://mailmcp.csalex.dev/mcp", "expect": "401", "miert": "token nélkül: a hitelesítés él" }`.
- [ ] **Step 5:** Lokális ellenőrzés: `docker compose -f mailmcp/docker-compose.yml --env-file mailmcp/stack.vars config` hibátlan, és a `proxy` compose is (`config --quiet`).

### Task 7: Élesítés (minden lépés Alex OK-jával)

- [ ] **Step 1:** A szerveren egyszer: `docker network create --internal mailmcp_network` (a `vps-from-scratch.sh` ezt csak új gépen futtatja).
- [ ] **Step 2:** Infra commit(ok) a `main`-re, fetch és log után push. Deploy az időzítővel vagy `.\scripts\Invoke-Deploy.ps1`. A Traefik a hálózat miatt újraindul (pár másodperc kiesés mindenhol).
- [ ] **Step 3:** `.\scripts\Wait-StackHealthy.ps1 mailmcp`, `.\scripts\Get-DeployLog.ps1`, `.\scripts\Test-PublicEndpoints.ps1` (a két új sor OK).
- [ ] **Step 4:** `.\scripts\Invoke-KumaTofu.ps1 plan`, majd OK után `apply`.

### Task 8: Átvétel

- [ ] **Step 1:** claude.ai → Settings → Connectors → Add custom connector, címe `https://mailmcp.csalex.dev/mcp/<fiók-id>`. Bejelentkezés. Mérés a `.\scripts\Get-StackLogs.ps1 mailmcp` kimenetén: a `login_ok` `client` mezője (a pontos `client_id`), a `resource`, egy eszközhívás `ok`. Ha `authorize_rejected` jön, az oka.
- [ ] **Step 2:** Claude Code a nyilvános címre: `claude mcp add --transport http mail-vps https://mailmcp.csalex.dev/mcp/<fiók-id>`, bejelentkezés, keresés.
- [ ] **Step 3:** Memória: egy nagy (több MB-os) melléklet lekérése alatt `.\scripts\Get-ServerStatus.ps1` (a `mailmcp` sor) és az OOM jelző. Ha a csúcs a limit 70%-a fölött van, a `mem_limit` és a `NODE_OPTIONS` hangolása.
- [ ] **Step 4:** Egy óránál hosszabb párhuzamos használatnál `refresh_reuse` sor keresése a naplóban (a refresh türelmi ablak döntéséhez).

### Task 9: A mért értékek rögzítése

- [ ] **Step 1:** App repó, új ág: az engedélyezett kliensek listája originek helyett a mért pontos `client_id` URL-ek (a Claude Code-é `https://claude.ai/oauth/claude-code-client-metadata`, a claude.ai-é a Task 8 méréséből), tesztekkel. A D10 és D35 szövege ehhez igazítva, a „Mért tények” közé a claude.ai mérése.
- [ ] **Step 2:** Ha a Task 8 Step 3 alapján kell: az infra `mem_limit` és `NODE_OPTIONS` új értéke a mérés dátumával a kommentben.
