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

The server runs on `http://localhost:4000` by default.

### 2. Sign in to Kiro

Open the sign-in UI in your browser:

```
http://localhost:4000/oauth/kiro
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
http://localhost:4000/config/claude
```

This writes the right values into `~/.claude/settings.json` for you.

### 4. Verify It's Working

```bash
# Health check
curl http://localhost:4000/health

# List available models
curl http://localhost:4000/v1/models

# Probe which models are actually active (makes one tiny request per model)
curl http://localhost:4000/v1/models/check
```

---

## Using with Claude Code CLI

### Easiest: the config UI

Open `http://localhost:4000/config/claude`, pick your models, and click **Apply**.
The proxy merges the right settings into `~/.claude/settings.json` (preserving your
other settings and writing a timestamped backup first). Then restart Claude Code.

> **Base URL:** use `http://localhost:4000` (no `/v1` suffix). The Anthropic SDK
> appends `/v1/messages` itself.

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
    "ANTHROPIC_BASE_URL": "http://localhost:4000",
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
echo 'export ANTHROPIC_BASE_URL="http://localhost:4000"' >> ~/.zshrc
echo 'export ANTHROPIC_API_KEY="dummy"' >> ~/.zshrc
source ~/.zshrc
```

> For Bash users, replace `~/.zshrc` with `~/.bashrc`

**Windows (PowerShell):**

```powershell
Add-Content $PROFILE "`n`$env:ANTHROPIC_BASE_URL = 'http://localhost:4000'"
Add-Content $PROFILE "`$env:ANTHROPIC_API_KEY = 'dummy'"
. $PROFILE
```

**Windows (Command Prompt):**

```cmd
setx ANTHROPIC_BASE_URL "http://localhost:4000"
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
> `curl http://localhost:4000/v1/models/check` to see which models are actually
> active for your account.

---

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Health check |
| `/v1/messages` | POST | Anthropic Messages API (streaming + non-streaming) |
| `/v1/models` | GET | List available models |
| `/v1/models/check` | GET/POST | Probe which models are actually active (1 tiny request/model) |
| `/v1/messages/count_tokens` | POST | Heuristic token count estimate |
| `/ui/telemetry/data` | GET | Telemetry snapshot as JSON |
| `/ui/telemetry/stream` | GET | Server-Sent Events telemetry stream (see below) |

### Web UIs

Three pages, each with its own layout:

| URL | Description |
|-----|-------------|
| `/` or `/dashboard` | **Monitor** — realtime traffic trace, aggregate metrics, per-model and failure breakdowns |
| `/oauth/kiro` | **Sign in** — Google/GitHub, auto-import from Kiro IDE/CLI, or paste a refresh token |
| `/config/claude` | **Configure** — edit Claude Code env values with a live JSON preview, plus the model catalog and availability probe |

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

Open `http://localhost:4000/oauth/kiro` and sign in (or click **Auto-import**), or run
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
# Start Express on :4000 and Vite on :3210 with API proxying
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

- `PORT` - Server port (default: `4000`)
- `HOST` - Bind address (default: `127.0.0.1`). Set explicitly only when remote access is intentional.
- `PROXY_API_KEY` - Optional key required by all `/v1/*` routes. Set Claude Code's `ANTHROPIC_AUTH_TOKEN` to the same value.
- `ALLOWED_ORIGINS` - Optional comma-separated browser origins in addition to localhost origins.
- `REQUEST_BODY_LIMIT` - Express JSON body limit (default: `10mb`).
- `UPSTREAM_TIMEOUT_MS` - Kiro request/stream timeout in milliseconds (default: `300000`).
- `DEBUG` - Enable debug logging (set to `true`).

The proxy binds to localhost by default because it can consume your Kiro quota and
its management UI can update local Claude Code settings. If you intentionally
bind it to a non-loopback interface, configure `PROXY_API_KEY`, restrict
`ALLOWED_ORIGINS`, and place TLS in front of the server.

Example with optional proxy authentication:

```bash
PROXY_API_KEY="replace-with-a-long-random-value" npm start
export ANTHROPIC_BASE_URL="http://localhost:4000"
export ANTHROPIC_AUTH_TOKEN="replace-with-a-long-random-value"
```

---

## License

MIT

---

## Credits

This project uses Kiro CLI's authentication system to access AWS CodeWhisperer models through an Anthropic-compatible API interface.
