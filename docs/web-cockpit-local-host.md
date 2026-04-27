# Wanman Cockpit Local Host

The **cockpit host** is a local HTTP server that manages Wanman runtime sessions and serves the control API consumed by the web cockpit UI. It is the bridge between the browser and the Wanman supervisor process.

## What it is

- A local-only Node.js HTTP server (binds to `127.0.0.1` by default)
- Manages session lifecycle: start run, start takeover, pause, resume, stop
- Persists session metadata and runtime events to disk (JSON + NDJSON)
- Streams runtime events to the browser via SSE (`/runtime/events/stream`)
- Monitors supervisor health and marks sessions stale when the process cannot be reached
- Captures supervisor stdout/stderr as structured runtime events
- Proxies `/health` and `/rpc` calls through to the active supervisor

The host is **local-only**. It never connects to remote services, never exposes an external port, and never sends session data or logs anywhere.

---

## Directory layout

```
.wanman/cockpit/
  sessions/           JSON file per session (RunSession)
  events/
    events.ndjson     Append-only log of all RuntimeEvent records
```

Both directories are created automatically under the repo root if they do not exist.

---

## How to build

The host package produces a single self-contained JS bundle.

```bash
pnpm --filter @wanman/cockpit-host build
```

Output: `packages/cockpit-host/dist/serve.js`

The bundle includes all workspace dependencies and can be run with plain Node.js — no `tsx`, no TypeScript toolchain, no workspace linking required.

---

## How to start (development)

During development the host runs directly from TypeScript source using `tsx`:

```bash
pnpm --filter @wanman/cockpit-host dev -- --repo /path/to/your/repo --port 5174
```

Or with environment variables:

```bash
WANMAN_COCKPIT_HOST_PORT=5174 pnpm --filter @wanman/cockpit-host dev
```

The dev command (`tsx src/serve.ts`) hot-reloads on file changes — useful when editing the host source.

---

## How to start (built artifact)

After building:

```bash
pnpm --filter @wanman/cockpit-host start -- --repo /path/to/your/repo --port 5174
```

Or directly with Node.js:

```bash
node packages/cockpit-host/dist/serve.js --repo /path/to/your/repo --port 5174
```

### Startup flags

| Flag | Default | Description |
|------|---------|-------------|
| `--repo <path>` | `process.cwd()` | Path to the Wanman repo root |
| `--port <n>` | `5174` | Port to listen on |
| `--host <addr>` | `127.0.0.1` | Bind address — must be a loopback address |
| `--storage <path>` | `<repo>/.wanman/cockpit` | Override session/event storage directory |

Environment variables `WANMAN_COCKPIT_HOST_PORT` and `WANMAN_COCKPIT_HOST_BIND` can be used instead of flags.

### Startup output

```
Wanman cockpit host started
  Host URL:     http://127.0.0.1:5174
  Repo root:    /path/to/repo
  Storage root: /path/to/repo/.wanman/cockpit
  Event stream: http://127.0.0.1:5174/runtime/events/stream
  Cockpit UI:   run  pnpm --filter apps/cockpit dev  then open http://localhost:5173
  Env hint:     VITE_WANMAN_CONTROL_URL=http://127.0.0.1:5174
```

---

## How to point the cockpit UI at the host

Set `VITE_WANMAN_CONTROL_URL` before starting the cockpit dev server:

```bash
VITE_WANMAN_CONTROL_URL=http://127.0.0.1:5174 pnpm --filter apps/cockpit dev
```

Or export it in your shell:

```bash
export VITE_WANMAN_CONTROL_URL=http://127.0.0.1:5174
pnpm --filter apps/cockpit dev
```

The cockpit UI will then call the control API on `http://127.0.0.1:5174` instead of going through the Vite dev bridge.

---

## Session storage

Each session is persisted as a JSON file:

```
.wanman/cockpit/sessions/<session-id>.json
```

Sessions survive host restarts. Sessions that were `running`, `starting`, `paused`, or `stopping` when the host was last shut down are automatically marked `stale` on the next startup, because their process state cannot be verified.

### Session fields

| Field | Description |
|-------|-------------|
| `id` | Unique session identifier |
| `kind` | `run` or `takeover` |
| `status` | `starting`, `running`, `paused`, `stopping`, `stopped`, `error`, `stale` |
| `goal` | Goal text |
| `runtime` | `claude` or `codex` |
| `supervisorUrl` | URL of the launched supervisor (e.g. `http://127.0.0.1:38201`) |
| `startedAt` / `endedAt` | Timestamps |
| `lastHeartbeatAt` | Timestamp of last successful supervisor health check |
| `heartbeatStatus` | `healthy`, `missed`, or `stale` |
| `heartbeatMisses` | Count of consecutive missed health checks |

---

## Event / log storage

All runtime events are appended to:

```
.wanman/cockpit/events/events.ndjson
```

Each line is a JSON-encoded `RuntimeEvent`:

```json
{"id":"evt-abc123","sessionId":"cockpit-run-...","timestamp":1700000000000,"level":"info","source":"supervisor","eventType":"supervisor.log","message":"Supervisor started on port 38201"}
```

Events are never deleted by the host. Rotate or truncate `events.ndjson` manually if the file grows large.

Secrets are redacted from event messages before they are persisted or streamed: API keys, tokens, bearer credentials, and JWT-shaped strings are replaced with `[redacted]`.

---

## Real-time event streaming (SSE)

The host exposes a Server-Sent Events stream:

```
GET /runtime/events/stream
```

The browser cockpit connects to this endpoint automatically. When SSE is available, the UI refreshes in near-real-time instead of waiting for the next polling interval.

### Query parameters

| Parameter | Description |
|-----------|-------------|
| `since=<timestamp>` | Only stream events after this timestamp (for manual reconnect) |

The stream also respects the `Last-Event-ID` HTTP header, which browsers send automatically when reconnecting after a dropped connection.

The stream sends a `: heartbeat` comment every 15 seconds to prevent proxy timeouts.

### Polling fallback

The cockpit UI falls back to polling when SSE is unavailable (e.g. the host is not reachable, the browser does not support `EventSource`, or the stream connection errors). The existing `GET /runtime/events` and `GET /runtime/logs` polling endpoints remain available and are not removed.

---

## Heartbeat and stale session detection

The host checks the active supervisor's `/health` endpoint every 10 seconds.

- On success: session `heartbeatStatus` is set to `healthy`, `lastHeartbeatAt` is updated.
- On first miss: session `heartbeatStatus` is set to `missed`, `heartbeatMisses` incremented.
- After 3 consecutive misses: session `status` is set to `stale`, a `runtime.stale` event is emitted.

A stale session means the host cannot verify the supervisor process is alive. The session metadata and events are preserved. Start a new run or takeover to resume work.

---

## Supervisor log ingestion

When a session is launched, the host captures the supervisor process's `stdout` and `stderr` streams. Each line is sanitized and persisted as a `supervisor.log` runtime event with level inferred from content:

- Lines matching `error`, `failed`, or `exception` → `error`
- Lines matching `warn` or `warning` → `warn`
- All other lines → `info`

These events appear in the cockpit's Logs and Events tabs alongside host-side events.

---

## Local-only safety model

- The host binds only to `127.0.0.1`, `localhost`, or `::1`. Any other `--host` value is rejected at startup.
- Process launch uses fixed entrypoints (`packages/runtime/dist/entrypoint.js`, `packages/cli/dist/index.js`) with structured argument arrays — no arbitrary shell command execution.
- Path inputs are validated and sanitized (shell control characters are rejected).
- Secrets are redacted from all persisted events and SSE streams.
- Error messages do not include environment variable values or credentials.
- Stop and pause operations require UI confirmation before the request is sent.

---

## Troubleshooting

### Port already in use

```
Error: listen EADDRINUSE: address already in use 127.0.0.1:5174
```

**Fix:** Another process is using port 5174. Either stop it, or start the host on a different port:

```bash
pnpm --filter @wanman/cockpit-host start -- --port 5175
```

Then set `VITE_WANMAN_CONTROL_URL=http://127.0.0.1:5175` before starting the cockpit UI.

---

### Supervisor unreachable

The UI shows "not running" for the supervisor connection and `502 SUPERVISOR_UNREACHABLE` in the network tab.

**Causes:**
- No session has been started yet — click **Start Run** or **Start Takeover**.
- The supervisor process crashed — check the Events tab for `runtime.error` or `supervisor.log` entries with `error` level.
- The session is `stale` — the process could not be verified; start a new session.

---

### Stale session

The Sessions tab shows `stale` status with a red badge.

**Cause:** The session was running when the host restarted, or the supervisor health check failed 3 times in a row.

**Fix:** Start a new run or takeover. The stale session's output files remain in the `outputDir` listed in the session details.

---

### Claude / Codex not logged in

The Readiness panel shows `needs auth` or `missing` for `claude` or `codex`.

**Fix:**
- For Claude: run `claude --version` in your terminal and follow login prompts if needed.
- For Codex: run `codex --version` and authenticate.
- For GitHub (needed for takeover): run `gh auth login`.

---

### Missing build artifacts

```
Error: Missing packages/runtime/dist/entrypoint.js. Run pnpm --filter @wanman/runtime build first.
Error: Missing packages/cli/dist/index.js. Run pnpm --filter @wanman/cli build first.
```

**Fix:** Build the required packages before starting a session:

```bash
pnpm --filter @wanman/runtime build
pnpm --filter @wanman/cli build
```

---

### Invalid repo path

```
Error: project-path contains shell control characters.
```

**Fix:** The `--repo` path or takeover project path contains characters like `;`, `&`, `|`, or backticks. Provide a clean absolute path.

---

### Browser cannot connect to SSE stream

The cockpit status shows `polling` instead of `SSE live`.

**Causes:**
- The host is not running — check that `pnpm --filter @wanman/cockpit-host start` is running.
- `VITE_WANMAN_CONTROL_URL` is not set or points to the wrong address.
- A proxy or firewall is stripping the `Connection: keep-alive` header for SSE.

**Checks:**
```bash
curl -N http://127.0.0.1:5174/runtime/events/stream
```
Should print `:ok` and then remain open, printing `: heartbeat` every 15 seconds.

The cockpit UI continues to work in polling mode — SSE is an enhancement, not a requirement.

---

### Events file growing large

`events.ndjson` is append-only and never trimmed automatically.

**Fix:** Stop the host and truncate or archive the file:

```bash
cp .wanman/cockpit/events/events.ndjson events-archive.ndjson
> .wanman/cockpit/events/events.ndjson
```

---

## API reference (brief)

All endpoints are under `http://127.0.0.1:<port>/runtime/`.

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/runtime/status` | Full runtime + session + readiness status |
| `GET` | `/runtime/sessions` | List persisted sessions |
| `GET` | `/runtime/sessions/:id` | Get single session |
| `GET` | `/runtime/events` | Poll runtime events (JSON) |
| `GET` | `/runtime/events/stream` | SSE event stream |
| `GET` | `/runtime/logs` | Poll runtime logs (JSON) |
| `GET` | `/runtime/readiness` | Check claude/codex/github readiness |
| `POST` | `/runtime/start-run` | Start a new run |
| `POST` | `/runtime/start-takeover` | Start a takeover |
| `POST` | `/runtime/stop` | Stop the active session |
| `POST` | `/runtime/pause` | Pause the supervisor |
| `POST` | `/runtime/resume` | Resume the supervisor |
| `GET` | `/health` | Proxied to active supervisor |
| `POST` | `/rpc` | Proxied to active supervisor |
