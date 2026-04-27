# Stage 7 — CLI Decoupling Analysis

## Current Dependency Graph

```
@wanman/cockpit-host
  └─ @wanman/cli          (runtime dep)
       └─ @wanman/runtime  (runtime dep)
       └─ @wanman/host-sdk (runtime dep)
       └─ @wanman/core     (runtime dep)
```

`@wanman/cli` does **not** depend on `@wanman/cockpit-host`, so there is no
existing cycle.  The dependency flows one-way: `cockpit-host → cli`.

## Why cockpit-host depends on cli

Two concrete touch-points:

| File | Import | Purpose |
|------|--------|---------|
| `src/takeover-preview.ts` | `@wanman/cli/takeover-project` | Project analysis for the takeover preview feature |
| `src/launcher.ts` | `packages/cli/dist/index.js` (path reference) | Writes a `wanman` wrapper script that delegates to the CLI binary inside isolated agent `$HOME` |

## The blocker for `wanman cockpit host`

Adding a `wanman cockpit host` sub-command to the CLI would require `@wanman/cli`
to import from `@wanman/cockpit-host`.  Combined with the existing
`cockpit-host → cli` edge, that creates a hard cycle:

```
@wanman/cli  ──→  @wanman/cockpit-host  ──→  @wanman/cli  (cycle!)
```

This is a **high-risk** change for Stage 7 — forcing it would break the
existing build/type pipeline without meaningful benefit to the hardening goals
of this stage.

## Risk assessment: HIGH — not implemented in Stage 7

Breaking the cycle requires splitting cockpit-host into two packages:

- **`@wanman/cockpit-host-core`** — HTTP server, EventStore, SessionStore,
  validation, safety, SSE streaming.  Zero dependency on `@wanman/cli`.

- **`@wanman/cockpit-host-launcher`** (or keep in existing `cockpit-host`) —
  the `LocalProcessLauncher` and takeover-preview, which legitimately need CLI.

`@wanman/cli` would then depend only on `cockpit-host-core`, avoiding the cycle.

## Stage 8 plan

1. Create `@wanman/cockpit-host-core` with the split described above.
2. Move `LocalProcessLauncher` and `buildTakeoverPreview` to a thin
   `@wanman/cockpit-host-launcher` shim (or keep them in `cockpit-host` and
   have `cli` not import from that package directly).
3. Add `wanman cockpit host [--port <n>] [--storage <dir>]` command to CLI that
   calls `createLocalControlHostServer` from `cockpit-host-core`.
4. Update `apps/cockpit` `VITE_WANMAN_CONTROL_URL` documentation to match.
5. Verify full build + test pipeline is green before shipping.
