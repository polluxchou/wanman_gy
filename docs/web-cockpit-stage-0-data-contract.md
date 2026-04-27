# Wanman Web Cockpit Stage 0: Product Skeleton and Data Contract

> Status: Stage 0 — analysis only. No frontend code, no new backend service, no
> model-provider integration. Output of this stage is this design document; it
> exists to guide Stage 1 (the read-only Web Dashboard MVP).

## Scope

The Wanman Web Cockpit is a thin, local-only web frontend that lets a single
human operator observe a running Wanman supervisor: which agents exist, what
they are doing, what tasks are in flight, what conversations are happening,
what artifacts have been produced, and where a human decision is required.

Stage 0 deliverables (this document):

- An audit of existing Wanman runtime data sources and how a frontend can
  reach them today.
- A first cut of frontend-facing view models (`Story`, `Agent`, `Task`,
  `Thread`, `Artifact`, `HumanAction`).
- An information architecture — pages, panels, and the view models each one
  consumes — with read-only MVP behavior.
- A thin `WanmanCockpitClient` adapter contract that maps existing JSON-RPC
  and HTTP endpoints onto those view models.
- A flow for surfacing human-needed work, distinguishing what is derivable
  today from what needs minimal future runtime support.
- A future-compatible `ModelProvider` configuration shape — declared but not
  implemented — so a later stage can wire up Alibaba Bailian / DashScope,
  DeepSeek, Zhipu, and Volcengine without re-modelling.

The cockpit's first run target is a single local Wanman supervisor reachable
at the URL configured by `WANMAN_URL` (default `http://localhost:3120`).

## Non-goals

The following are explicitly out of scope for this stage and for the Stage 1
MVP that follows it:

- Building the frontend UI (no React/Vue/Svelte, no component library, no
  routing). This document only defines what those pages will need.
- Replacing or wrapping the Wanman supervisor with a new backend service.
  The cockpit is a frontend-only consumer of the existing JSON-RPC + HTTP
  surface; any glue code is a thin adapter, not a service.
- Authentication, organizations, multi-tenant routing, billing, role-based
  access. The cockpit assumes a single trusted local operator.
- Cloud deployment. The cockpit ships next to the supervisor and connects
  over loopback.
- A full model-provider marketplace. Provider configuration is shaped
  (so the UI shell can later host it) but not wired to any runtime.
- Implementing Alibaba Bailian / DashScope, DeepSeek, Zhipu, Volcengine, or
  any other provider runtime adapter. Existing Claude Code / Codex CLI
  runtimes remain the only supported execution path.
- Implementing write-side mutations beyond what is already exposed by the
  supervisor. The MVP is read-only; the contract sketches future write
  endpoints but does not require them.

## Existing Wanman Data Sources

References below cite source-of-truth files in this repository.

### Agents

- **Concept** — `AgentDefinition` describes a configured agent (name,
  lifecycle, runtime, model, system prompt, optional crons/events). At
  runtime, the supervisor wraps each definition in an `AgentProcess` with a
  live state machine: `idle | running | paused | stopped | error`.
- **Where it lives** — Definitions in `agents.json`
  ([`AgentMatrixConfig`](../packages/core/src/types.ts#L96)). Live state in
  the `Supervisor.agents` map
  ([`packages/runtime/src/supervisor.ts`](../packages/runtime/src/supervisor.ts)).
- **RPC / HTTP access** —
  - `agent.list` returns `{ agents: [{ name, state, lifecycle, model }] }`.
  - `GET /health` returns the same plus per-agent `state` and `lifecycle`,
    with run counters per agent under `runtime.completedRunsByAgent`.
  - `agent.spawn` / `agent.destroy` mutate dynamic clones at runtime.
- **TypeScript types** — `AgentDefinition`, `AgentState`, `HealthResponse`
  ([`packages/core/src/types.ts`](../packages/core/src/types.ts)).
- **Frontend-ready?** — Yes for read. The combination of `agent.list` and
  `/health` already gives a frontend everything it needs to render an agent
  list with state badges and run counts.
- **Minimal gap for later** — `agent.list` does not currently echo
  `systemPrompt`, `crons`, `events`, `runtime`, or `baseUrl`. A future
  `agent.get` (or richer `agent.list`) would let the cockpit show an agent
  detail panel without reading `agents.json` directly.

### Tasks

- **Concept** — `TaskPool` is the canonical SQLite-backed work queue.
  Statuses: `pending | assigned | in_progress | review | done | failed`.
  Tasks carry `scope` (paths/patterns), `priority`, `dependsOn`,
  `initiativeId`, `capsuleId`, `subsystem`, and `scopeType`.
- **Where it lives** —
  [`packages/runtime/src/task-pool.ts`](../packages/runtime/src/task-pool.ts).
- **RPC / HTTP access** — `task.create`, `task.list`, `task.get`,
  `task.update`. `task.list` accepts `status`, `assignee`, `initiativeId`,
  and `capsuleId` filters. Task transitions also emit `task.transition` /
  `task.blocked` events on the loop event bus and are POSTed to the
  optional story-sync hook.
- **TypeScript types** — `Task`, `TaskStatus`, `TaskScope`, `TaskScopeType`.
- **Frontend-ready?** — Yes. Task data is the most complete read path in
  the runtime.
- **Minimal gap for later** — None for MVP. For richer dashboards, a
  `task.events` stream or a server-sent task feed would remove the need
  for polling, but is not required.

### Messages / Threads

- **Concept** — Inter-agent messages with priority `steer | normal`. Stored
  in the `messages` SQLite table; the relay enqueues on send and atomically
  marks rows `delivered = 1` on `recv`.
- **Where it lives** —
  [`packages/runtime/src/message-store.ts`](../packages/runtime/src/message-store.ts),
  [`packages/runtime/src/relay.ts`](../packages/runtime/src/relay.ts).
- **RPC / HTTP access** — `agent.send` and `agent.recv`. **Note:**
  `agent.recv` is *destructive* — calling it from the cockpit would consume
  messages out from under the target agent. There is no read-only "list
  messages" RPC today.
- **TypeScript types** — `AgentMessage` (`from`, `to`, `type`, `payload`,
  `priority`, `timestamp`, `delivered`).
- **Frontend-ready?** — **Not safely.** The cockpit must not call
  `agent.recv`. Until a read-only message endpoint exists, the cockpit can
  only show "live" thread activity through one of two indirect paths:
  - The optional **story-sync** hook
    (`WANMAN_SYNC_URL` + `WANMAN_STORY_ID`) receives every message via
    `postStorySyncEvent` (see
    [`supervisor.ts`](../packages/runtime/src/supervisor.ts)). A cockpit
    deployment can act as the sync target.
  - The **loop event NDJSON file** consumed by `wanman watch` includes
    `queue.backlog` events but not message bodies.
- **Minimal gap for later** — A read-only `thread.list` / `thread.get` (or
  `agent.messages`) RPC that returns delivered + pending messages without
  mutating `delivered`. This is the single most important missing surface
  for the cockpit.

### Artifacts

- **Concept** — Structured agent outputs (research summaries, plans,
  scripts, etc.) with `kind`, `agent`, optional `path`, `content`,
  `metadata`, `confidence`, `verified`.
- **Where it lives** — `db9` brain (Postgres-backed via
  `BrainManager.executeSQL`). The local SQLite path does **not** store
  artifacts; if the supervisor was started without a `brain` config, the
  artifact RPCs return `INTERNAL_ERROR: "Brain not initialized"`.
- **RPC / HTTP access** — `artifact.put`, `artifact.list`, `artifact.get`.
  Artifact creations also POST to the optional story-sync `/artifact`
  endpoint and emit `artifact.created` loop events.
- **TypeScript types** — `ArtifactPutParams`, `ArtifactListParams` are in
  [`packages/core/src/protocol.ts`](../packages/core/src/protocol.ts);
  there is no first-class `Artifact` interface yet.
- **Frontend-ready?** — Partial. Available when db9 is configured;
  unavailable otherwise. The cockpit must treat "no brain" as a normal
  empty state, not an error.
- **Minimal gap for later** —
  - Lift a canonical `Artifact` interface into `@wanman/core`.
  - When db9 is absent, fall back to enumerating the supervisor's loop-event
    `artifact.created` records or to an on-disk artifact directory if/when
    one is introduced.

### Health

- **Concept** — Snapshot of supervisor + agents + loop + runtime counters.
- **Where it lives** —
  [`Supervisor.getHealth()`](../packages/runtime/src/supervisor.ts).
- **RPC / HTTP access** — `GET /health` and `health.check` over RPC. Body
  shape today:
  ```ts
  {
    status: 'ok',
    agents: Array<{ name, state, lifecycle }>,
    timestamp: string,
    loop?: { runId, currentLoop },
    runtime?: {
      completedRuns, completedRunsByAgent,
      initiatives, activeInitiatives,
      capsules, activeCapsules,
    },
  }
  ```
- **TypeScript types** — `HealthResponse` in `@wanman/core` covers the
  baseline; the `loop` and `runtime` extensions are documented here.
- **Frontend-ready?** — Yes. Strongest single endpoint for an "overview"
  page.
- **Minimal gap for later** — Promote the inline `loop` / `runtime`
  extensions into `HealthResponse` so the cockpit's typings and the
  runtime's response stay in lockstep.

### Context

- **Concept** — Cross-agent shared key/value store (e.g., "current MRR",
  "last build result").
- **Where it lives** —
  [`packages/runtime/src/context-store.ts`](../packages/runtime/src/context-store.ts).
- **RPC / HTTP access** — `context.get`, `context.set`, `context.list`.
- **TypeScript types** — `ContextEntry` in
  [`packages/core/src/types.ts`](../packages/core/src/types.ts).
- **Frontend-ready?** — Yes for read. `context.list` returns every entry
  with author + timestamp.
- **Minimal gap for later** — None for MVP. A future `context.subscribe`
  for live updates is nice-to-have, not blocking.

### Adjacent surfaces (worth knowing about)

- **Initiatives** — `initiative.{create,list,get,update}`,
  type `Initiative`. SQLite-backed; always available.
- **Change capsules** — `capsule.{create,list,get,update,mine}`,
  type `ChangeCapsule`. SQLite-backed; always available.
- **Hypotheses** — `hypothesis.{create,list,update}`. db9-only, like
  artifacts.
- **Auth** — `auth.providers`, `auth.start`, `auth.status` for the local
  Claude / Codex / GitHub CLI logins. The cockpit can show login status
  for these CLIs but should not surface them as model providers (see
  Model Provider Extension below).
- **Loop events** — NDJSON file consumed by `wanman watch`, plus the same
  event stream POSTed to `WANMAN_SYNC_URL` when configured. Useful for
  Stage 2+ live-streaming; not required for Stage 1.

## Frontend View Models

These are frontend-facing shapes. They deliberately differ from runtime
internals: they collapse multiple runtime sources into one model, drop
fields the cockpit does not display, and make every "needs the brain" or
"needs a future RPC" field optional.

Legend:

- **MVP** — required for Stage 1 read-only dashboard.
- **Ext** — extension, populated when the underlying source is available;
  the UI must render gracefully without it.

### `Story`

A `Story` is the cockpit's top-level frame for "one running Wanman
supervisor". It is what the user sees when they open the dashboard. There
is exactly one story per connected supervisor in MVP.

| Field | Type | Meaning | Source | MVP/Ext |
|---|---|---|---|---|
| `id` | `string` | Stable identifier. Defaults to `WANMAN_STORY_ID` if set, else `"local"`. | env / config | MVP |
| `title` | `string` | Display name. Defaults to repo name or `gitRoot` basename. | `AgentMatrixConfig.gitRoot` | MVP |
| `goal` | `string \| null` | The CEO goal driving the matrix. | `AgentMatrixConfig.goal` | MVP |
| `supervisorUrl` | `string` | URL the cockpit is connected to. | `WANMAN_URL` | MVP |
| `connection` | `'connected' \| 'reconnecting' \| 'down'` | Frontend-derived from `/health` polling. | computed | MVP |
| `runtimeStats` | `{ completedRuns, agents, activeInitiatives, activeCapsules }` | Headline counters. | `/health.runtime` | MVP |
| `loop` | `{ runId, currentLoop } \| null` | Current loop pointer, when `LoopEventBus` is on. | `/health.loop` | Ext |
| `lastUpdatedAt` | `number` (ms) | Timestamp of the latest `/health` snapshot. | computed | MVP |

### `Agent`

| Field | Type | Meaning | Source | MVP/Ext |
|---|---|---|---|---|
| `name` | `string` | Unique agent identifier. | `agent.list` / `/health` | MVP |
| `state` | `'idle' \| 'running' \| 'paused' \| 'stopped' \| 'error'` | Live state. | `/health` | MVP |
| `lifecycle` | `'24/7' \| 'on-demand' \| 'idle_cached'` | Configured lifecycle. | `agent.list` | MVP |
| `runtime` | `'claude' \| 'codex'` | Active CLI adapter. | `AgentDefinition.runtime` | Ext (until `agent.get` exists) |
| `model` | `string` | Model tier or id. | `agent.list` | MVP |
| `pendingMessages` | `number` | Count of undelivered messages. | derived from queue / loop events | Ext |
| `completedRuns` | `number` | Per-agent run counter. | `/health.runtime.completedRunsByAgent` | MVP |
| `lastActivityAt` | `number \| null` | Most recent run/message timestamp. | loop events / story-sync | Ext |
| `isDynamic` | `boolean` | Spawned via `agent.spawn`. | `Supervisor.dynamicAgents` (needs RPC) | Ext |
| `systemPrompt` | `string` | Persona / mission. | `AgentDefinition.systemPrompt` | Ext |
| `crons` | `string[]` | Cron triggers. | `AgentDefinition.crons` | Ext |
| `events` | `string[]` | Subscribed event types. | `AgentDefinition.events` | Ext |

### `Task`

| Field | Type | Meaning | Source | MVP/Ext |
|---|---|---|---|---|
| `id` | `string` | Full UUID. | `task.list` | MVP |
| `shortId` | `string` | First 8 chars, for display. | computed | MVP |
| `title` | `string` |  | `task.list` | MVP |
| `description` | `string` |  | `task.get` | MVP |
| `status` | `'pending' \| 'assigned' \| 'in_progress' \| 'review' \| 'done' \| 'failed' \| 'blocked'` | `'blocked'` is a derived UI status when `dependsOn` are unmet. | computed from `task.list` | MVP |
| `assignee` | `string \| null` |  | `task.list` | MVP |
| `priority` | `number` | 1..10. | `task.list` | MVP |
| `scope` | `{ paths: string[], patterns?: string[] }` |  | `task.get` | MVP |
| `dependsOn` | `string[]` | Task IDs that must finish first. | `task.list` | MVP |
| `initiativeId` | `string \| null` |  | `task.list` | Ext |
| `capsuleId` | `string \| null` |  | `task.list` | Ext |
| `result` | `string \| null` | Final summary when `done`. | `task.get` | MVP |
| `createdAt`, `updatedAt` | `number` |  | `task.list` | MVP |

### `Thread`

A `Thread` is a frontend grouping of `AgentMessage`s between a stable pair
(or between an agent and `human`). The MVP draws threads from whatever
read-only message source becomes available; if none is wired up, the
`Thread` view is empty and the page shows "messages coming soon" rather
than an error.

| Field | Type | Meaning | Source | MVP/Ext |
|---|---|---|---|---|
| `id` | `string` | Frontend-derived, e.g. `"a:ceo|b:dev"` (sorted endpoints). | computed | MVP |
| `participants` | `string[]` | Agent names; `"human"` is a participant when applicable. | computed | MVP |
| `lastMessage` | `ThreadMessage \| null` | Latest message snapshot. | future read-only RPC / story-sync | Ext |
| `messageCount` | `number` |  | future read-only RPC / story-sync | Ext |
| `pendingForHuman` | `boolean` | True if the latest message targets `human` and is undelivered. | derived | Ext |

```ts
interface ThreadMessage {
  id: string;
  from: string;
  to: string;
  type: string;          // 'message' | 'decision' | 'blocker' | 'event' | ...
  priority: 'steer' | 'normal';
  payload: unknown;      // structured; the cockpit renders strings as text
  timestamp: number;
  delivered: boolean;
}
```

### `Artifact`

| Field | Type | Meaning | Source | MVP/Ext |
|---|---|---|---|---|
| `id` | `string` |  | `artifact.list` | MVP (when brain configured) |
| `kind` | `string` | e.g. `research`, `plan`, `script`. | `artifact.list` | MVP |
| `agent` | `string` | Producing agent. | `artifact.list` | MVP |
| `path` | `string \| null` |  | `artifact.list` | MVP |
| `contentLength` | `number \| null` | From `length(content)` in `artifact.list`. | `artifact.list` | MVP |
| `content` | `string \| null` | Full body, fetched lazily via `artifact.get`. | `artifact.get` | MVP |
| `metadata` | `Record<string, unknown>` |  | `artifact.list` | MVP |
| `confidence` | `number` | 0..1. | `metadata.confidence` | MVP |
| `verified` | `boolean` |  | `metadata.verified` | MVP |
| `taskId` | `string \| null` | Producing task. | `metadata.taskId` | Ext |
| `createdAt` | `number` |  | `artifact.list.created_at` | MVP |

### `HumanAction`

The unified inbox model the human operator works against. See "Human Action
Flow" below for derivation rules; some sources are derived today, others
require minimal future metadata.

| Field | Type | Meaning | Source | MVP/Ext |
|---|---|---|---|---|
| `id` | `string` | Stable id (message id, task id, run id...) prefixed by `kind`. | computed | MVP |
| `kind` | `'decision' \| 'blocker' \| 'access_request' \| 'agent_error' \| 'task_review'` | Categorization. | computed | MVP |
| `summary` | `string` | One-line preview. | computed | MVP |
| `originator` | `string` | Agent or `'system'`. | computed | MVP |
| `relatedTaskId` | `string \| null` |  | linked task | Ext |
| `relatedThreadId` | `string \| null` |  | computed | Ext |
| `relatedAgent` | `string \| null` |  | computed | MVP |
| `priority` | `'steer' \| 'normal'` |  | source | MVP |
| `createdAt` | `number` |  | source | MVP |
| `payload` | `unknown` | Raw underlying payload, for the detail pane. | source | Ext |

## Page Skeleton

Six top-level areas. The MVP is a single SPA shell with these as routes or
panels; explicit non-goals follow each entry.

### Project Overview

- **Purpose** — One-screen answer to "is anything happening, and is
  anything stuck?".
- **View models** — `Story`, `Agent[]` (counts only), `Task[]` (counts
  by status), `HumanAction[]` (count + top 3).
- **MVP behavior** — Read-only. Headline cards: connection status, agent
  count by state, task count by status, active initiatives, active
  capsules, completed runs, items needing a human. Each card links into
  the relevant page.
- **Future actions** — Pause / resume the supervisor (`supervisor.pause` /
  `supervisor.resume`). Trigger an on-demand agent.
- **Not in MVP** — Editing goals, editing agents, deploying anywhere,
  charts beyond simple counters.

### Task Board

- **Purpose** — See every task, filter by status / assignee / initiative,
  drill into dependencies.
- **View models** — `Task[]` with derived `blocked` status; optional
  initiative / capsule grouping.
- **MVP behavior** — Read-only kanban-or-table view. Polls `task.list`.
  Clicking a task opens a detail pane that calls `task.get` and shows
  `description`, `scope`, `result`, and links to dependencies.
- **Future actions** — Re-assign a task, mark `review` → `done`, add a
  task. Send a steer to the assignee.
- **Not in MVP** — Drag-and-drop status changes, time tracking, burndown.

### Agent List

- **Purpose** — At-a-glance status of every agent and quick access to its
  current activity.
- **View models** — `Agent[]`; per-agent `Task[]` for "currently working
  on", `Thread[]` for "currently talking to".
- **MVP behavior** — Read-only list with state badge, lifecycle,
  completed runs, pending message count when available. Selecting an
  agent shows its system prompt (when reachable), crons, events, and the
  task and thread lists scoped to that agent.
- **Future actions** — Pause one agent, send it a message, restart it,
  spawn a clone via `agent.spawn`.
- **Not in MVP** — Editing system prompts, editing the agents config.

### Conversation / Thread List

- **Purpose** — Read what the agents are saying to each other and to the
  human.
- **View models** — `Thread[]`, `ThreadMessage[]`.
- **MVP behavior** — Read-only. Source is whichever of (a) a future
  `thread.list` RPC, (b) the story-sync sink, or (c) a frontend NDJSON
  reader fed by the loop event file is wired in Stage 1. If none is
  available, the page shows an empty state explaining the missing surface.
  Selecting a thread shows the message timeline grouped by day.
- **Future actions** — Reply (call `agent.send` from the cockpit), steer
  an agent, mute a thread.
- **Not in MVP** — Search across history, attachments, manual message
  edits, calling `agent.recv` (which would be destructive).

### Artifact Preview

- **Purpose** — Browse and read structured outputs.
- **View models** — `Artifact[]`, `Artifact` (with content).
- **MVP behavior** — Read-only list (`artifact.list`). Selecting an
  artifact lazily loads `artifact.get` and renders the content as either
  Markdown or raw text. When the brain is not configured, the page shows
  a clear "artifact storage requires the optional db9 brain adapter"
  state and a link to the architecture docs.
- **Future actions** — Mark verified, download, export.
- **Not in MVP** — Editing artifacts, full-text search, diffing.

### Human Inbox / Human Action Queue

- **Purpose** — Show the operator the work they personally need to do.
- **View models** — `HumanAction[]`.
- **MVP behavior** — Read-only list ordered by `priority` then
  `createdAt`. Items the cockpit can derive today (agent errors from
  `agent.state === 'error'`, tasks in `failed` or `review` status, tasks
  blocked on missing dependencies, capsules with `status: 'in_review'`)
  are shown as a best-effort starting set. Items that require richer
  source metadata (`decision`, `blocker`, `access_request`) become
  available once the read-only message endpoint or explicit
  `human_action` metadata exists.
- **Future actions** — Approve / reject capsule, answer a decision
  request, retry a failed task, grant an access request.
- **Not in MVP** — Snoozing items, assigning items to other humans,
  email/Slack notifications.

## Adapter / API Contract

The frontend talks to the supervisor through one TypeScript class. The
class is **thin**: every method maps to one HTTP or JSON-RPC call plus
a small adapter from the wire shape to the view model. It does not
batch, cache (beyond the polling cycle), or duplicate runtime logic.

```ts
// File suggestion: packages/cockpit-client/src/index.ts
// Stage 0 design only — not implemented yet.

import type {
  Agent,
  Artifact,
  ContextEntry,
  HumanAction,
  Story,
  Task,
  Thread,
  ThreadMessage,
} from './view-models';

export interface WanmanCockpitClientOptions {
  /** Supervisor URL — defaults to WANMAN_URL or http://localhost:3120. */
  baseUrl?: string;
  /** Optional fetch implementation override (tests, SSR, etc.). */
  fetchImpl?: typeof fetch;
}

export interface WanmanCockpitClient {
  // ── Story (the connection itself) ──
  getStory(): Promise<Story>;

  // ── Agents ──
  listAgents(): Promise<Agent[]>;
  /** Optional. Returns null when agent.get is not yet implemented in runtime. */
  getAgent(name: string): Promise<Agent | null>;

  // ── Tasks ──
  listTasks(filter?: {
    status?: Task['status'];
    assignee?: string;
    initiativeId?: string;
    capsuleId?: string;
  }): Promise<Task[]>;
  getTask(id: string): Promise<Task | null>;

  // ── Threads / messages (read-only) ──
  /**
   * Stage 1 best-effort. Returns [] when no read-only message source is
   * wired. Implementations may consume the story-sync sink, the loop
   * event NDJSON, or a future `thread.list` RPC — never `agent.recv`.
   */
  listThreads(filter?: { agent?: string }): Promise<Thread[]>;
  getThread(id: string): Promise<{ thread: Thread; messages: ThreadMessage[] } | null>;

  // ── Artifacts ──
  /** Returns [] gracefully when the db9 brain is not configured. */
  listArtifacts(filter?: {
    agent?: string;
    kind?: string;
    verified?: boolean;
  }): Promise<Artifact[]>;
  getArtifact(id: string): Promise<Artifact | null>;

  // ── Context ──
  listContext(): Promise<ContextEntry[]>;

  // ── Health ──
  getHealth(): Promise<{
    status: 'ok' | 'degraded';
    agents: Agent[];
    loop: Story['loop'];
    runtime: Story['runtimeStats'];
    timestamp: number;
  }>;

  // ── Human inbox ──
  listHumanActions(): Promise<HumanAction[]>;

  // ── Subscriptions / lifecycle ──
  /** Cleans up timers / sockets created by the polling strategy. */
  dispose(): void;
}
```

### Mapping table (RPC → adapter method)

| Adapter method | RPC / HTTP | Notes |
|---|---|---|
| `getStory` | `GET /health` + `agents.json`-derived metadata | Pure read. |
| `listAgents` | `agent.list` + `GET /health` | Merge state + run counters. |
| `getAgent` | (future) `agent.get` | Returns `null` until added. |
| `listTasks` | `task.list` | Derive `'blocked'` client-side. |
| `getTask` | `task.get` |  |
| `listThreads` / `getThread` | (future) `thread.list` / `thread.get`, *or* story-sync, *or* loop NDJSON | Empty list is a valid MVP answer. |
| `listArtifacts` | `artifact.list` | Empty list when brain absent. |
| `getArtifact` | `artifact.get` |  |
| `listContext` | `context.list` |  |
| `getHealth` | `GET /health` |  |
| `listHumanActions` | derived (see Human Action Flow) | No single RPC today. |

### Refresh strategy for MVP

Polling-only, kept dumb:

- `getHealth` every **2 seconds** while the dashboard is focused, **15
  seconds** when backgrounded.
- `listAgents` every `getHealth` tick (the call is cheap and `/health`
  already implies a refresh).
- `listTasks` every **5 seconds** when the Task Board is visible, every
  **30 seconds** otherwise.
- `listArtifacts` and `listContext` every **30 seconds** while their
  pages are visible.
- `listHumanActions` every **5 seconds**; the inbox should feel live.
- Threads page polls every **5 seconds** when its source supports it.

A future Stage adds a streaming subscription: server-sent events fed by
`LoopEventBus`, or a websocket bridged from the loop event NDJSON. MVP
must work without it.

### What the adapter must NOT do

- Call `agent.recv` (destructive — would steal messages from agents).
- Call `agent.send`, `task.create`, `task.update`, `context.set`,
  `artifact.put`, or any mutating RPC. Stage 1 is read-only.
- Hold open connections beyond the polling timers.
- Import anything from `@wanman/runtime`. The contract sits on top of
  `@wanman/core` types only.

## Human Action Flow

The cockpit's job here is to take heterogeneous "humans need to look at
this" signals and present them as one inbox. Today's wanman has no
explicit "human action" record; the cockpit must derive them.

### What we can derive today (MVP-able)

- **`agent_error`** — Any agent in `agent.list` with `state === 'error'`.
  Summary: `"<agent> crashed; supervisor will retry"`. No related task.
- **`task_review`** — Any task in `status === 'review'`. Summary uses the
  task title; `relatedTaskId` set.
- **Failed tasks** — Tasks in `status === 'failed'`. Same handling as
  `task_review`, kind `'task_review'` with a "failed" subtype in the
  summary.
- **Capsule review** — Change capsules in `status === 'in_review'` map to
  `task_review` with a capsule subtype.
- **Blocked-on-dependency** — Tasks whose `dependsOn` includes a task
  that is itself `failed` (a stuck blocker the human probably needs to
  unstick). Map to `kind: 'blocker'`.

### What needs minimal future metadata

- **`decision`** — Today the supervisor *infers* `decision` vs `blocker`
  for messages targeted at `to: 'human'` (`inferHumanMessageType` in
  [`supervisor.ts`](../packages/runtime/src/supervisor.ts)) but those
  messages are **not** persisted in the SQLite `messages` table — the
  human send path bypasses the relay and only fires `postStorySyncEvent`.
  To surface them in the cockpit we need one of:
  1. Persist human-bound messages to the `messages` table (or a sibling
     `human_inbox` table) and add a read-only `human.list` RPC.
  2. Run the cockpit as a story-sync target so it receives the existing
     POSTs.
- **`access_request`** — There is currently no first-class "agent
  requests an access grant" event. Until one exists, agents that need an
  access grant emit a normal message addressed to `human` with
  `payload.kind: 'access_request'`; the cockpit should respect that
  convention so the same plumbing as `decision` / `blocker` covers it.
- **`agent_error` with cause** — Today `state === 'error'` is the only
  signal; the *reason* lives in agent stderr/log files. A future
  `agent.lastError` field on `agent.list` (string + timestamp) would let
  the cockpit show the cause inline.

### Priority and ordering

`steer`-priority items rank above `normal`. Within a priority bucket,
order by `createdAt` ascending (oldest first — the human should clear
backlog before triaging fresh items). Errored agents always sort to the
top.

### Acknowledgement (out of scope for MVP)

There is no "mark as handled" RPC today; the inbox in MVP is a live
projection that simply removes items as the underlying state changes
(e.g., the task leaves `review`, the agent transitions out of `error`).
Explicit acknowledgement is a Stage 2 concern.

## Model Provider Extension

This section is **declarative only**. Stage 0 does not integrate any
provider; Stage 1 MVP does not either. The shape exists so that the UI
shell and the configuration model agree from day one.

```ts
// File suggestion: packages/cockpit-client/src/model-provider.ts
// Stage 0 design only.

export type ModelProviderRegion =
  | 'global'
  | 'cn'        // Mainland China endpoints
  | 'eu'
  | 'us'
  | 'jp';

export type ModelProviderCapability =
  | 'chat'
  | 'tools'        // function/tool calling
  | 'vision'
  | 'streaming'
  | 'embeddings'
  | 'caching';

export interface ModelProviderAuthField {
  /** Form field key, e.g. "apiKey", "endpoint", "region". */
  name: string;
  /** Display label for the cockpit settings page. */
  label: string;
  /** UI input hint. Secret values are write-only and never echoed back. */
  type: 'string' | 'secret' | 'url' | 'enum';
  enumValues?: string[];
  required: boolean;
  helpText?: string;
}

export interface ModelProviderModel {
  id: string;                     // e.g. "qwen-max", "deepseek-chat"
  displayName: string;
  capabilities: ModelProviderCapability[];
  contextWindow?: number;
  /** Free-form labels: 'fast', 'reasoning', 'cheap', 'preview'. */
  tags?: string[];
}

/** Describes which Wanman runtime adapter can drive this provider. */
export interface ModelProviderRuntimeCompatibility {
  /** Existing adapters today: 'claude' | 'codex'. */
  builtin: Array<'claude' | 'codex'>;
  /** Future runtime keys the provider would need. */
  future?: string[];
  /** Notes for the cockpit settings page. */
  notes?: string;
}

export interface ModelProvider {
  id: string;                     // 'anthropic' | 'openai' | 'dashscope' | 'deepseek' | ...
  displayName: string;
  region: ModelProviderRegion;
  authFields: ModelProviderAuthField[];
  models: ModelProviderModel[];
  capabilities: ModelProviderCapability[];
  runtimeCompatibility: ModelProviderRuntimeCompatibility;
  /** Pre-shipped reference; users may add custom providers later. */
  builtin: boolean;
  /** Marketing/help URL — never used as an API endpoint. */
  homepageUrl?: string;
}
```

### Sketch of declarative entries (not wired)

The following four entries are illustrative future targets. They are
included here only to show the shape; **no runtime adapter exists** for
any of them in Stage 0 or Stage 1.

- `dashscope` / Alibaba Bailian — `region: 'cn'`, `authFields: apiKey +
  endpoint`, models: `qwen-max`, `qwen-plus`, etc.
- `deepseek` — `region: 'cn'`, `authFields: apiKey`, models:
  `deepseek-chat`, `deepseek-reasoner`.
- `zhipu` — `region: 'cn'`, `authFields: apiKey`, models: `glm-4`,
  `glm-4v`.
- `volcengine` — `region: 'cn'`, `authFields: apiKey + endpointId`,
  models: bring-your-own deployments.

### MVP boundary for providers

- The cockpit **does not** ship provider integrations.
- The cockpit **does** reserve a `Settings → Model Providers` UI slot in
  the page skeleton (deferred to Stage 1.5+) but that page is hidden by
  default in MVP.
- Existing Claude Code / Codex CLI runtimes remain the only execution
  path. The cockpit reads `auth.providers` only to surface CLI login
  status, not as a proxy for "model provider configured".
- A later stage owns: (a) implementing each provider's runtime adapter
  in `packages/runtime/src/`, (b) persisting provider configs in the
  supervisor (probably a new SQLite table), (c) wiring per-agent
  `runtime` selection through the existing `AgentDefinition`.

## MVP Boundary

In scope for Stage 1 (the read-only Web Dashboard MVP that follows this
document):

- Single SPA frontend, served locally next to the supervisor.
- Read-only views for: Project Overview, Task Board, Agent List, Artifact
  Preview, Human Inbox.
- Conversation / Thread List page exists in the navigation but is allowed
  to be empty until a read-only message endpoint or a story-sync sink is
  wired in.
- Connection only to a single local supervisor at `WANMAN_URL`.
- Polling-based refresh as defined above.
- Graceful empty / disabled states for: db9 brain absent (artifacts,
  hypotheses), thread source absent, loop bus absent.

Out of scope for the MVP:

- Any mutating action (no `agent.send`, no `task.update`, no
  `supervisor.pause`).
- User accounts, RBAC, multi-tenant routing.
- Cloud deployment, hosted edition features (db9 cross-run search,
  sandbox isolation).
- Model-provider configuration UI behavior (the slot is reserved but
  hidden).
- Streaming / push updates beyond polling.
- Editing `agents.json` from the cockpit.

## Minimal Future API Additions

Listed in priority order. None are required by the design above; each
unlocks a specific UX upgrade.

1. **`thread.list` / `thread.get` (or `agent.messages`)** — read-only,
   non-destructive view of the `messages` table. Without this the
   Conversation page is empty unless the story-sync sink is configured.
   Suggested shape:
   ```ts
   // thread.list
   params: { agent?: string; peer?: string; since?: number; limit?: number }
   result: { threads: Thread[] }

   // thread.get
   params: { id: string; limit?: number; before?: number }
   result: { thread: Thread; messages: AgentMessage[] }
   ```
2. **Persist human-bound messages.** Today `to: 'human'` short-circuits
   the relay (`supervisor.ts` near line 848) and is only POSTed to
   story-sync. Persisting to the `messages` table (or a sibling table)
   gives the cockpit a complete `decision` / `blocker` / `access_request`
   inbox without an external sink.
3. **`agent.get`** — return the full `AgentDefinition` minus secrets so
   the cockpit can render the system prompt, crons, events, and runtime
   on the agent detail page.
4. **`agent.lastError`** — last crash reason + timestamp on `agent.list`
   entries, so `agent_error` `HumanAction`s carry a useful summary.
5. **Stable `Artifact` type in `@wanman/core`.** Today the wire shape is
   ad-hoc (`artifact.list` returns rows directly). A canonical
   `Artifact` interface keeps the cockpit and runtime in lockstep.
6. **Promote `loop` and `runtime` fields into `HealthResponse`.** Today
   they are appended in `getHealth()` but absent from the `@wanman/core`
   type.
7. **`supervisor.subscribe` / SSE bridge for `LoopEventBus`** — Stage 2
   nice-to-have. Removes polling. Not blocking for MVP.
8. **`human.ack` (or `humanAction.update`)** — Stage 2. Lets the cockpit
   record that a human handled a decision/blocker.

## Open Questions

1. **Where does the cockpit live in the repo?** Two reasonable options:
   - `apps/cockpit/` (Vite/Next + a `packages/cockpit-client/`
     for the typed adapter). Keeps frontend separate from runtime.
   - `packages/cockpit/` (a published npm-style sibling of `cli/` and
     `runtime/`). Simpler workspace story, less idiomatic for SPAs.
   Decision belongs to Stage 1.
2. **Story-sync as primary message source for MVP, yes/no?** Wiring the
   cockpit as the `WANMAN_SYNC_URL` target gives us full message
   coverage today, but couples the cockpit to a runtime-side env var.
   The alternative is shipping `thread.list` first and skipping
   story-sync entirely. Recommendation: ship `thread.list`; use
   story-sync only as an interim fallback.
3. **Multi-supervisor in Stage 2?** The `Story` model has an `id` so it
   can host a list later, but the connection model is still 1:1 in MVP.
   Confirm with the user before changing.
4. **Brain dependency for artifacts.** Should the cockpit guide the user
   to enable `@sandbank.dev/db9` when artifacts are absent, or stay
   neutral? Recommendation: a small banner with a doc link, no
   automation.
5. **Auth bleed-through.** `auth.providers` covers Claude / Codex /
   GitHub CLI logins, *not* model provider API keys. The cockpit must
   not conflate the two; this needs UI copy that distinguishes "CLI
   login" from "model provider".
6. **Local-only assumption hardening.** Stage 1 assumes a trusted local
   operator. If the cockpit is ever exposed beyond loopback, a CSRF /
   origin-check story will be needed before any write endpoints land.

## Acceptance Criteria

This Stage 0 deliverable is acceptable when:

- This document exists at
  [`docs/web-cockpit-stage-0-data-contract.md`](web-cockpit-stage-0-data-contract.md).
- No frontend implementation has been created.
- No new backend service or framework has been created.
- Each existing Wanman runtime concept (agents, tasks, messages,
  artifacts, context, health) is mapped to a frontend view model and to
  a concrete RPC / HTTP source, with explicit notes for partial or
  missing surfaces.
- The MVP boundary is explicit: which view models, pages, and behaviors
  ship in Stage 1 and which do not.
- Data that is unavailable today is called out as a
  *minimal future API addition*, not silently assumed.
- The first connection target is a single local Wanman supervisor at
  `WANMAN_URL`. No accounts, organizations, billing, or cloud
  deployment is introduced.
- China-region model providers (Alibaba Bailian / DashScope, DeepSeek,
  Zhipu, Volcengine) are represented as a future-compatible
  configuration shape only. No runtime adapter is implemented.
- The document is detailed enough that Stage 1 can begin by creating a
  `WanmanCockpitClient` package and a small SPA without re-litigating
  any of these decisions.
