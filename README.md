# Kiro to Claude

A proxy server that exposes an **Anthropic-compatible API** backed by **Kiro's AWS CodeWhisperer**, letting you use Claude models with **Claude Code CLI** or any Anthropic-compatible client.

## How It Works

```
┌──────────────────┐     ┌─────────────────────┐     ┌────────────────────────────┐
│   Claude Code    │────▶│  This Proxy Server  │────▶│  AWS CodeWhisperer         │
│   (Anthropic     │     │  (Anthropic → AWS   │     │  (codewhisperer.           │
│    API format)   │     │   CodeWhisperer)    │     │   us-east-1.amazonaws.com) │
└──────────────────┘     └─────────────────────┘     └────────────────────────────┘
```

1. Receives requests in **Anthropic Messages API format**
2. Uses OAuth tokens from Kiro (CLI database, IDE, or in-app sign-in)
3. Transforms to AWS CodeWhisperer format
4. Sends to AWS CodeWhisperer API
5. Converts responses back to **Anthropic format** with full streaming support

## Features

- **Anthropic-compatible API** — drop-in for Claude Code and other Anthropic clients
- **Full streaming (SSE)** support
- **16 models** including Claude Opus 5 / 4.8 / 4.7 / 4.6 / 4.5, Sonnet 5 / 4.6 / 4.5 / 4, Haiku 4.5, `auto`, and open-weight models (MiniMax, GLM-5, DeepSeek, Qwen)
- **Automatic token refresh** — stays signed in until you log out; no repeated `kiro auth`
- **Browser sign-in UI** (`/oauth/kiro`) — Google/GitHub login, auto-import from Kiro IDE / CLI, or manual token import
- **Claude Code config UI** (`/config/claude`) — write `~/.claude/settings.json` with a click
- **Realtime monitor** (`/dashboard`) — live traffic trace over SSE, plus per-model and failure breakdowns
- **Live model checker** (`/v1/models/check`) — probe which models are actually active

## Clients that speak OpenAI

Besides the Anthropic route, the gateway exposes **`POST /v1/chat/completions`** in
OpenAI shape, with streaming and tool calling. Combos, account rotation, quota
parking, and telemetry all apply the same way — it is a translation layer over the
same pipeline, not a second one.

Three places the two formats do not line up, handled rather than ignored:

- OpenAI carries system prompts inside `messages`; Anthropic takes one top-level
  `system` string, so several are joined.
- OpenAI has a `tool` role for results; Anthropic puts a `tool_result` block on a
  **user** turn.
- Tool arguments are a JSON *string* in OpenAI and an object in Anthropic. A
  malformed string is passed through as `_raw_arguments` rather than dropped, so the
  model can see what it produced.

`thinking` deltas are not forwarded: OpenAI has no field for them.

**Tool schemas are repaired before they reach Gemini**, whose `Schema` type is a
subset of JSON Schema. Union types, `anyOf`, `const`, and `$ref` are already
collapsed; two shapes that agent frameworks emit are also handled, because Gemini
rejects the *entire* tool set over one of them and names only an array index in the
error:

- A property given as a bare type name — `{"globs": "array"}` instead of
  `{"globs": {"type": "array"}}` — is coerced. A value that is not a schema at all
  is dropped, and any `required` entry naming it is dropped with it.
- An array without `items` is given a permissive one, since Gemini treats `items` as
  required.

The cleaning is **keyword-aware about where schemas live**, which matters more than
it sounds. A `properties` map is keyed by names the tool author chose, and those
names collide with JSON Schema keywords — a tool with a property called `items` or
`type` is perfectly legal. Walking every nested object as if it were a schema
corrupts those maps, and Gemini then rejects the whole tool set while naming only an
array index.

### Pi Agent

[Pi Agent](https://github.com/parcelvoy/pi) reads `~/.pi/agent/models.json` and
declares each backend as a provider. Write this gateway into it:

```bash
curl -X POST http://localhost:4985/config/pi/apply \
  -H 'Content-Type: application/json' -d '{"baseUrl":"http://localhost:4985/v1"}'
```

That merges a `krcc` provider using `"api": "openai-completions"` and leaves every
other provider in the file untouched, writing a timestamped backup first. A file that
cannot be parsed is refused rather than overwritten, since it holds your other
backends.

What it declares, and why it may look conservative:

- **Reasoning** is marked where it is known: Google flags it per model, and Kiro
  publishes the reasoning variant as its own `-thinking` id. Both are honoured.
- **Image input is claimed only when the provider reports it.** Kiro reports nothing
  here and Google only in its live catalog, so a model is listed as text-only unless
  proven otherwise — claiming otherwise would make Pi Agent send an image the
  upstream then rejects.
- **A provider that cannot be reached contributes no models**, and the response says
  which, so a partial config is visible instead of you finding half the catalog
  missing later.

## Prerequisites

- **Node.js 20.19 or later**
- A Kiro account. Sign in one of these ways:
  - the built-in UI at `/oauth/kiro` (Google/GitHub, or import from Kiro IDE/CLI), **or**
  - the **Kiro CLI** (`kiro auth`), **or**
  - the **Kiro IDE** (its token is auto-detected)

---

## Installation

### Option 1: npm (Recommended)

```bash
# Run directly with npx (no install needed)
npx kiro-to-claude start

# Or install globally
npm install -g kiro-to-claude
kiro-to-claude start
```

### Option 2: Clone Repository

```bash
git clone https://github.com/rezkycodes/kr-to-cc.git
cd kr-to-cc
npm install
npm start
```

---

## Quick Start

### 1. Start the Proxy Server

```bash
# If installed via npm
kiro-to-claude start

# If using npx
npx kiro-to-claude start

# If cloned locally
npm start
```

The server runs on `http://localhost:4985` by default.

### 2. Sign in to Kiro

Open the sign-in UI in your browser:

```
http://localhost:4985/oauth/kiro
```

From there you can:

- **Login with Google / GitHub** (social login), or
- **Auto-import** an existing token detected on this machine (Kiro IDE or Kiro CLI), or
- **Paste a refresh token** manually.

Alternatively, if you already use the Kiro CLI (`kiro auth`) or Kiro IDE, the proxy
auto-detects that token — no extra step needed. Once signed in, the proxy keeps the
token fresh automatically (see [Staying signed in](#staying-signed-in)).

### 3. Configure Claude Code (one click)

Open the config UI and click **Apply**:

```
http://localhost:4985/config/claude
```

This writes the right values into `~/.claude/settings.json` for you.

### 4. Verify It's Working

```bash
# Health check
curl http://localhost:4985/health

# List available models
curl http://localhost:4985/v1/models

# Probe which models are actually active (makes one tiny request per model)
curl http://localhost:4985/v1/models/check
```

---

## Using with Claude Code CLI

### Easiest: the config UI

Open `http://localhost:4985/config/claude`, pick your models, and click **Apply**.
The proxy merges the right settings into `~/.claude/settings.json` (preserving your
other settings and writing a timestamped backup first). Then restart Claude Code.

> **Base URL:** `http://localhost:4985/v1` (what the Configure page writes) or the
> bare origin `http://localhost:4985`. Claude Code appends its own `/v1/messages`
> to this setting, so the first form requests `/v1/v1/messages` and the second
> requests `/v1/messages`; the proxy mounts its API at both prefixes, so either
> works. Anything else in the path will be carried into the request and 404.

### Manual: edit settings.json

Create or edit the Claude Code settings file:

**macOS:** `~/.claude/settings.json`
**Linux:** `~/.claude/settings.json`
**Windows:** `%USERPROFILE%\.claude\settings.json`

Add this configuration:

```json
{
  "env": {
    "ANTHROPIC_AUTH_TOKEN": "dummy",
    "ANTHROPIC_BASE_URL": "http://localhost:4985",
    "ANTHROPIC_MODEL": "claude-opus-4-6",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "claude-opus-4-6",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "claude-sonnet-4-5",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "claude-haiku-4-5",
    "CLAUDE_CODE_SUBAGENT_MODEL": "claude-sonnet-4-5"
  }
}
```

### Load Environment Variables

Add the proxy settings to your shell profile:

**macOS / Linux:**

```bash
echo 'export ANTHROPIC_BASE_URL="http://localhost:4985"' >> ~/.zshrc
echo 'export ANTHROPIC_API_KEY="dummy"' >> ~/.zshrc
source ~/.zshrc
```

> For Bash users, replace `~/.zshrc` with `~/.bashrc`

**Windows (PowerShell):**

```powershell
Add-Content $PROFILE "`n`$env:ANTHROPIC_BASE_URL = 'http://localhost:4985'"
Add-Content $PROFILE "`$env:ANTHROPIC_API_KEY = 'dummy'"
. $PROFILE
```

**Windows (Command Prompt):**

```cmd
setx ANTHROPIC_BASE_URL "http://localhost:4985"
setx ANTHROPIC_API_KEY "dummy"
```

Restart your terminal for changes to take effect.

### Run Claude Code

```bash
# Make sure the proxy is running first
kiro-to-claude start

# In another terminal, run Claude Code
claude
```

---

## Available Models

`GET /v1/models` returns all of these. Add `-thinking` to any Claude model id
(e.g. `claude-opus-4-8-thinking`) to request extended reasoning.

| Model ID | Description | Context | Cost¹ |
|----------|-------------|:-------:|:-----:|
| `claude-opus-5` | Claude Opus 5 — strongest for long-running agentic tasks (experimental) | 1M | 2.2x |
| `claude-opus-4-8` | Claude Opus 4.8 — highest reliability (default) | 1M | 2.2x |
| `claude-opus-4-7` | Claude Opus 4.7 — adaptive deep reasoning | 1M | 2.2x |
| `claude-opus-4-6` | Claude Opus 4.6 — long sessions, debugging | 1M | 2.2x |
| `claude-opus-4-5` | Claude Opus 4.5 — cross-system architecture | 200K | 2.2x |
| `claude-sonnet-5` | Claude Sonnet 5 — most agentic Sonnet | 1M | 1.3x |
| `claude-sonnet-4-6` | Claude Sonnet 4.6 — near-Opus, token efficient | 1M | 1.3x |
| `claude-sonnet-4-5` | Claude Sonnet 4.5 — strong agentic coding | 200K | 1.3x |
| `claude-sonnet-4` | Claude Sonnet 4.0 — predictable baseline | 200K | 1.3x |
| `claude-haiku-4-5` | Claude Haiku 4.5 — fastest, low cost | 200K | 0.4x |
| `auto` | Let Kiro route each task to the best model | — | 1.0x |
| `minimax-m2.5` | MiniMax M2.5 (open weight) | 200K | 0.25x |
| `glm-5` | GLM-5 (open weight) | 200K | 0.5x |
| `deepseek-3.2` | DeepSeek 3.2 (open weight) | 128K | 0.25x |
| `minimax-m2.1` | MiniMax M2.1 (open weight) | 200K | 0.15x |
| `qwen3-coder-next` | Qwen3 Coder Next (open weight) | 256K | 0.05x |

¹ Credit multiplier relative to `auto` (1.0x baseline), per Kiro's docs.

> **Note:** availability depends on your Kiro plan/region. Run
> `curl http://localhost:4985/v1/models/check` to see which models are actually
> active for your account.

---

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Health check |
| `/v1/messages` | POST | Anthropic Messages API (streaming + non-streaming) |
| `/v1/chat/completions` | POST | OpenAI Chat Completions API (streaming + non-streaming) |
| `/config/pi/state` | GET | What is in `~/.pi/agent/models.json`, and what would be written |
| `/config/pi/apply` | POST | Merge this gateway into Pi Agent's model config |
| `/config/pi` | DELETE | Remove this gateway's block from that config |
| `/v1/models` | GET | List available models |
| `/v1/models/check` | GET/POST | Probe which models are actually active (1 tiny request/model) |
| `/v1/messages/count_tokens` | POST | Heuristic token count estimate |
| `/ui/combos` | GET/POST | List or create/replace combos |
| `/ui/combos/:name` | GET/DELETE | Read or delete one combo |
| `/ui/providers/:id/models` | GET | That provider's models, with quota |
| `/ui/providers/:id/models/:model/test` | POST | Send one tiny request to that model |
| `/ui/usage` | GET | Usage history: totals, per provider, per model, per day |
| `/ui/usage` | DELETE | Forget the stored usage counters |
| `/ui/telemetry/data` | GET | Telemetry snapshot as JSON |
| `/ui/telemetry/stream` | GET | Server-Sent Events telemetry stream (see below) |

### Web UIs

Three pages, each with its own layout:

| URL | Description |
|-----|-------------|
| `/` or `/dashboard` | **Monitor** — realtime traffic trace, aggregate metrics, per-model and failure breakdowns |
| `/oauth/kiro` | **Sign in** — Google/GitHub, auto-import from Kiro IDE/CLI, or paste a refresh token |
| `/config/claude` | **Configure** — edit Claude Code env values with a live JSON preview |
| `/providers` | **Providers** — accounts per provider: add, enable, reorder, test, remove; plus that provider's models with quota and a per-model test |
| `/combos` | **Combos** — build and edit combos, with the strategy and member order side by side |
| `/usage` | **Usage** — which provider served your traffic, over days rather than the live window |

### Providers and accounts

A provider can hold several signed-in accounts. Each carries its own quota, so
requests rotate between them — on a free tier that is the difference between one
ceiling and several.

Sign in from the **Providers** page. **Add account** opens a dialog per provider:

- **Google / Antigravity** — a browser popup, with a manual path always shown
  alongside it (copy the URL, approve, paste the address you land on), because a
  popup can be blocked or opened in a profile that cannot report back.
- **Kiro** — pick a method: import a login this machine already has, Google/GitHub
  sign-in, paste a refresh token, or paste a CLIProxyAPI auth JSON. Pasted
  credentials are checked against Kiro before being saved, so a bad paste fails on
  the form rather than on your next request.

Three Kiro methods are listed but not implemented — AWS Builder ID, AWS IAM
Identity Center, and API key. They are shown greyed out with the reason rather than
hidden, so it is clear they exist and why they are unavailable. An IDC login already
made by the Kiro CLI or IDE does work through **import**.

Accounts already on the machine are imported once. For Google that is
`~/.gemini/antigravity-cli/antigravity-oauth-token` and `~/.gemini/oauth_creds.json`;
for Kiro it is the Kiro CLI database and the AWS SSO cache the Kiro IDE writes. The import only runs while the store is empty, so
an account you delete stays deleted.

How failures are handled:

- **A quota error parks that account** for ten minutes rather than disabling it —
  quota comes back.
- **Any other error is recorded but leaves the account in rotation.** One transient
  failure should not cost capacity; the reason shows on the account row.
- **A revoked login is skipped, not fatal.** If refreshing fails, the next account
  is tried, so one dead login does not take the provider down.

### Models and quota

Each provider's models are listed on its own detail page, with context window, credit
multiplier, and a **Test** button that sends one tiny request so you can see whether a
model actually answers for your account. **Test all** walks the list one at a time —
sequentially, because each call spends quota and firing them together would make a
rate-limit impossible to attribute.

Quota is reported the way each provider actually meters, because the two differ and
flattening them would mislead:

- **Google/Antigravity meters per model — and per account.** Each account holds its
  own set of model allowances, so the page shows an account picker and the rows
  report the selected account's remaining fraction and reset time. Above the list a
  summary gives the lowest remaining figure and which model holds it, plus how many
  models are untouched, partly used, or exhausted, and the soonest reset. There is
  deliberately no total: a per-model provider has no single allowance to total. Merging accounts
  would invent a total that no single account has. The account's plan comes from
  Code Assist (`Gemini Code Assist` for a standard tier); Antigravity often omits
  `currentTier`, so the default allowed tier is used and reported as unknown when
  absent.
- **Kiro meters each account in credits.** One monthly allowance is shared by every
  model, and each model draws from it at its own multiplier — so there is no
  per-model figure to show. The page reports one block per account instead, since
  accounts can sit on different plans with different allowances.

Two limitations worth knowing:

- **Some tokens cannot read quota at all.** A Kiro token may return `403` from the
  usage API while still serving requests fine, and a revoked Google login fails to
  refresh. Either way that account reports the reason instead of a fabricated
  number, and its rows show no figure rather than `0%`, which would read as
  exhausted rather than unknown.
- **The model list does not depend on a working account.** If every account is spent
  or revoked the catalog still lists, with the reason shown — only the quota figures
  and the Test buttons stop working.
- **A thinking model can spend its whole budget on thought** and return no text. The
  test allows enough headroom to clear reasoning and still answer, but a pass with an
  empty reply is reported as such rather than counted as a failure.
- **Retired models are dropped from the catalog.** Antigravity keeps a deprecated id
  in its model list while the backend rejects it with a bare "Request contains an
  invalid argument". The catalog names the successor, so the old id is filtered out
  and the replacement recorded — `gemini-3.1-pro-high` became `gemini-pro-agent`.
- **Antigravity fronts three model families that disagree about tool calls.**
  `gemini-*` pairs a tool result with its call by function name and rejects an `id`
  field; `claude-*` is served by Anthropic and requires `tool_use.id`; `gpt-oss-*` is
  OpenAI-shaped and requires an id too. The proxy sends the id for everything except
  Gemini, so a tool-using conversation works on all three.

`GOOGLE_STICKY_REQUESTS` and `KIRO_STICKY_REQUESTS` (both default `1`) set how many consecutive requests one
account serves before rotating. Rotating on every single request defeats upstream
prompt caching, which is keyed per account.

Tokens are stored in `~/.config/kiro-proxy/connections.json` with `0600`
permissions and are never returned by the management API — the UI only ever sees
whether a refresh token exists.

### Combos

A combo groups models from any provider under one name and appears in
`GET /v1/models`, so a client can select it without knowing it is a group. It also
appears in the **Configure** page's model pickers, grouped under *Combos* above the
provider models, since a combo is a valid value to write into `settings.json`. Manage
them on the **Combos** page (`/combos`) or via `GET`/`POST`/`DELETE /ui/combos`.

The strategy is switchable straight from the combo list, so changing how an
existing combo behaves does not mean reopening the editor; membership and order
still go through **Edit**.

Four strategies, chosen per combo:

| Strategy | Behaviour | Cost |
|----------|-----------|------|
| `failover` | Try members top to bottom; move on when one errors or hits its quota | One member per request |
| `load-balance` | Rotate through members to stretch several quotas | One member per request |
| `router` | Pick by request shape — tools or a large prompt go further down the list | One member per request |
| `race` | Ask several at once, keep the fastest | **Every** member per request |

Notes worth knowing before relying on them:

- **Member order matters** in all four. `router` assumes members are listed
  cheapest first; that is a convention it cannot verify.
- **A stream cannot fail over once it has started.** Members are swapped only
  before the first event. If a member dies mid-stream the request fails rather
  than silently restarting on another model, which would send the client
  overlapping messages.
- **A failure on one member moves to the next, including a bare `400`.** That was
  once treated as final, on the assumption every member would reject it identically
  — wrong once members span providers, where a model retired upstream or a schema
  rule only one backend enforces surfaces as an undetailed 400. Each member is still
  tried at most once. Only a mapping mistake (`does not serve model`) or an
  unparseable body is final.
- **`race` streaming uses the first member only** — a stream has to commit before
  latency is known.
- Combos cannot contain other combos, and cannot take the name of an existing
  model or provider.

The Monitor page attributes traffic to the member that actually answered, not to
the combo, so `by_provider` reflects real upstream load.

### Usage history

The Monitor page draws a realtime trace from memory, which keeps six hours and is
lost on restart. That cannot answer "which provider served my traffic this week", so
usage is also rolled up to disk and shown on the **Usage** page (`/usage`).

What is stored is deliberately narrow: **counters only**, bucketed per UTC day per
served provider and model — requests, successes, failures, tokens, credits, total
latency, and a `last_used`. No prompts, no responses, no request ids. Losing the file
leaks nothing about what was asked. It lives at
`~/.config/kiro-proxy/usage.json` with `0600` permissions and is kept 90 days.

Attribution is on **who served** the request, not what was asked for, so a combo's
traffic lands against the member that actually answered.

Two things the page states rather than hides:

- **Individual requests come from the live window**, not the rollups, so that list
  is short and resets when the proxy restarts. The aggregate figures do not.
- **Token counts are measured for Google and estimated for Kiro**, so a window
  covering both is labelled *part estimated* rather than presented as exact.

### Telemetry stream (`GET /ui/telemetry/stream`)

The Monitor page draws its live trace from an SSE stream instead of polling.

| Query param | Default | Description |
|-------------|---------|-------------|
| `window` | `15` | Aggregate window in minutes |
| `live` | `90` | Seconds of per-second buckets to keep (max `600`) |

Frames:

- `init` — snapshot, live backlog, and `tick_interval_ms`, sent immediately on connect
- `tick` — current second (`ok`/`fail`/`hold`/`p95`) plus `in_flight`, at 1 Hz
- `snapshot` — full aggregates every 5 s, and coalesced within ~400 ms of any change
- `: keep-alive` comment every 20 s

At most 8 concurrent stream clients are accepted; further connections get `503`.
Telemetry lives in memory only — no request or response bodies are recorded, and
everything is discarded when the process exits.

#### Token and cost figures

The Monitor page reports input/output tokens, estimated credits, and a per-request
breakdown. Two caveats, because the numbers are not what a billing dashboard would
show:

- **Token counts are measured for Google, estimated for Kiro.** Google's Cloud Code
  API returns real `usageMetadata`, including the thinking tokens a request spent.
  Kiro's CodeWhisperer backend returns nothing — a completed request reports `0` in
  / `0` out even when it produced text — so those counts are estimated locally from
  the text that crossed the boundary, using the same ~4-characters-per-token
  heuristic as `/v1/messages/count_tokens`. Each request records which basis it
  used; the dashboard says *estimated*, *measured*, or *part estimated* accordingly.
- **Cached tokens depend on the provider.** Google reports cache hits; Kiro exposes
  no cache information at all, so Kiro-only windows show `—` (unknown) rather than a
  misleading `0`.
- **Cost is in Kiro credits, not dollars.** Kiro bills per request scaled by a
  model multiplier (see the Cost column in [Available Models](#available-models)),
  and publishes no per-token dollar rate. Requests on an unrecognised model are
  counted as *unpriced* rather than free.

---

## Signing In

You can authenticate in several ways — pick whichever is easiest:

- **Browser (recommended):** open `/oauth/kiro` and either log in with Google/GitHub,
  click **Auto-import** to pull a token already on this machine (Kiro IDE or CLI), or
  paste a refresh token manually.
- **Kiro CLI:** run `kiro auth`. The proxy reads the CLI token automatically.
- **Kiro IDE:** if the IDE is signed in, its token (in the AWS SSO cache) is detected
  by the auto-import.

### Staying signed in

The proxy stores credentials in `~/.config/kiro-proxy/config.json` and **refreshes the
access token automatically** before it expires, using the stored refresh token. You stay
signed in until you explicitly log out of Kiro — no need to re-run `kiro auth` on every
expiry.

---

## Troubleshooting

### Not signed in / "not authenticated"

Open `http://localhost:4985/oauth/kiro` and sign in (or click **Auto-import**), or run
`kiro auth` in a terminal.

### "Kiro CLI database not accessible"

Ensure Kiro CLI is properly installed and has created its database. Try running any Kiro command first:
```bash
kiro --help
```

### 401 Authentication Errors

Your Kiro authentication may have expired. Re-authenticate:
```bash
kiro auth
```

---

## Development


### Nx workspace commands

The backend lives in `apps/server/src/` and the Vue 3 + Vite dashboard lives in `apps/web/`.
Nx coordinates both projects and caches build, test, and typecheck work.

```bash
# Start Express on :4985 and Vite on :3210 with API proxying
npm run dev

# Production frontend build (dist/apps/web)
npm run build

# Build, Node tests, and Vue/Vitest tests
npm test

# Vue TypeScript validation
npm run typecheck
```

The production Express server serves the built Vue app at `/`, `/dashboard`,
`/oauth/kiro`, and `/config/claude`. When the frontend build is absent, the
legacy server-rendered pages remain available as a development fallback.
### Running in Debug Mode

```bash
kiro-to-claude start --debug
```

### Environment Variables

- `PORT` - Server port (default: `4985`)
- `HOST` - Bind address (default: `127.0.0.1`). Set explicitly only when remote access is intentional.
- `PROXY_API_KEY` - Optional key required by all `/v1/*` routes. Set Claude Code's `ANTHROPIC_AUTH_TOKEN` to the same value.
- `ALLOWED_ORIGINS` - Optional comma-separated browser origins in addition to localhost origins.
- `REQUEST_BODY_LIMIT` - Express JSON body limit (default: `10mb`).
- `UPSTREAM_TIMEOUT_MS` - Kiro request/stream timeout in milliseconds (default: `300000`).
- `DEBUG` - Enable debug logging (set to `true`).
- `GOOGLE_OAUTH_CLIENT_ID` - Google OAuth client ID for Google provider connections.
- `GOOGLE_OAUTH_CLIENT_SECRET` - Google OAuth client secret for Google provider connections.

The proxy binds to localhost by default because it can consume your Kiro quota and
its management UI can update local Claude Code settings. If you intentionally
bind it to a non-loopback interface, configure `PROXY_API_KEY`, restrict
`ALLOWED_ORIGINS`, and place TLS in front of the server.

Example with optional proxy authentication:

```bash
PROXY_API_KEY="replace-with-a-long-random-value" npm start
export ANTHROPIC_BASE_URL="http://localhost:4985"
export ANTHROPIC_AUTH_TOKEN="replace-with-a-long-random-value"
```

---

## License

MIT

---

## Credits

This project uses Kiro CLI's authentication system to access AWS CodeWhisperer models through an Anthropic-compatible API interface.
