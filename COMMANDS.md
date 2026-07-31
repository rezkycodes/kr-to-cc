# Kiro to Claude - Commands Reference

## CLI Commands

### Start Server
```bash
kiro-to-claude start          # Start on default port 4000
kiro-to-claude start --debug  # Start with debug logging
kiro-to-claude                # Defaults to start command
```

### Help & Version
```bash
kiro-to-claude --help         # Show help message
kiro-to-claude --version      # Show version number
```

### Alternative Start Methods
```bash
npm start                        # If cloned locally
npx kiro-to-claude start      # Run without installing
```

---

## API Endpoints

Base URL: `http://localhost:4000`

### Health Check
```bash
GET /health
curl http://localhost:4000/health
```

### List Models
```bash
GET /v1/models
curl http://localhost:4000/v1/models
```

### Check Active Models
Probe each model with a tiny live request to see which are active on your account.
```bash
GET /v1/models/check                          # check all models
curl http://localhost:4000/v1/models/check
curl "http://localhost:4000/v1/models/check?models=claude-opus-4-8,auto"  # check specific
```

### Count Tokens (estimate)
```bash
POST /v1/messages/count_tokens
curl -X POST http://localhost:4000/v1/messages/count_tokens \
  -H "Content-Type: application/json" \
  -d '{"model":"claude-sonnet-4-5","messages":[{"role":"user","content":"Hello"}]}'
```

### Send Message
```bash
POST /v1/messages
curl -X POST http://localhost:4000/v1/messages \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-sonnet-4-5",
    "messages": [{"role": "user", "content": "Hello"}],
    "max_tokens": 1000
  }'
```

### Streaming Messages
```bash
POST /v1/messages
curl -X POST http://localhost:4000/v1/messages \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-sonnet-4-5",
    "messages": [{"role": "user", "content": "Hello"}],
    "max_tokens": 1000,
    "stream": true
  }'
```

### Telemetry
```bash
GET /ui/telemetry/data                      # JSON snapshot
curl "http://localhost:4000/ui/telemetry/data?window=15"

GET /ui/telemetry/stream                    # Server-Sent Events (init/tick/snapshot)
curl -N "http://localhost:4000/ui/telemetry/stream?window=15&live=90"
```
`window` is the aggregate window in minutes (default `15`); `live` is how many
seconds of per-second buckets to keep (default `90`, max `600`). At most 8
concurrent stream clients are accepted. Telemetry is in-memory only.

---

## Web UIs

Open in a browser:

- `http://localhost:4000/dashboard`      — Monitor (realtime traffic trace, metrics, failures)
- `http://localhost:4000/oauth/kiro`     — Sign in (Google/GitHub, auto-import, or paste token)
- `http://localhost:4000/config/claude`  — Configure Claude Code (`~/.claude/settings.json`) + model catalog

`/` redirects to `/dashboard`.

---

## Environment Variables

```bash
PORT=4000 kiro-to-claude start     # Set the server port (default: 4000)
DEBUG=true kiro-to-claude start    # Enable debug logging
```

---

## Prerequisites

```bash
kiro auth                             # Authenticate Kiro CLI
kiro --help                          # Verify Kiro CLI is installed
```

---

## Available Models

`GET /v1/models` returns all of these. Add `-thinking` to any Claude model id
(e.g. `claude-opus-4-8-thinking`) to request extended reasoning.

**Claude (Anthropic)**
- `claude-opus-4-8` — highest reliability (default)
- `claude-opus-4-7`
- `claude-opus-4-6`
- `claude-opus-4-5`
- `claude-sonnet-5`
- `claude-sonnet-4-6`
- `claude-sonnet-4-5`
- `claude-sonnet-4`
- `claude-haiku-4-5` — fastest, low cost

**Routing**
- `auto` — let Kiro pick the best model per task

**Open weight**
- `minimax-m2.5`
- `glm-5`
- `deepseek-3.2`
- `minimax-m2.1`
- `qwen3-coder-next`

> Availability depends on your Kiro plan/region. Probe which are actually active with:
> ```bash
> curl http://localhost:4000/v1/models/check
> ```
