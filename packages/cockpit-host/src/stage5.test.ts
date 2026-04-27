import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  EventStore,
  LocalControlHost,
  SessionStore,
  buildTakeoverPreview,
  checkRuntimeReadiness,
  createDefaultRoster,
  validateStartRunInput,
  validateStartTakeoverInput,
} from './index.js'
import type { ProcessLauncher, RuntimeEvent } from './index.js'

const tempDirs: string[] = []

function tempRoot(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `wanman-${name}-`))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('Stage 5 session persistence', () => {
  it('persists sessions and marks active sessions stale after host restart', () => {
    const store = new SessionStore(path.join(tempRoot('sessions'), '.wanman/cockpit/sessions'))
    const created = store.create({
      kind: 'run',
      status: 'running',
      goal: 'Ship Stage 5',
      runtime: 'codex',
      supervisorUrl: 'http://127.0.0.1:3912',
      port: 3912,
      projectPath: '/repo',
      workspacePath: '/repo/.wanman/cockpit/runs/one/agents',
      configPath: '/repo/.wanman/cockpit/runs/one/agents.json',
      outputDir: '/repo/.wanman/cockpit/runs/one',
      createdBy: 'cockpit',
      metadata: { test: true },
    })

    const restarted = new SessionStore(store.rootDir)
    const stale = restarted.get(created.id)

    expect(stale?.status).toBe('stale')
    expect(stale?.endedAt).toBeNull()
    expect(restarted.list()).toHaveLength(1)
  })
})

describe('Stage 5 event persistence and filtering', () => {
  it('persists runtime events and filters by session, agent, level, type, since, and limit', () => {
    const store = new EventStore(path.join(tempRoot('events'), '.wanman/cockpit/events'))
    const first = store.append({
      sessionId: 's1',
      level: 'info',
      source: 'host',
      eventType: 'runtime.started',
      message: 'started',
    })
    store.append({
      sessionId: 's1',
      level: 'warn',
      source: 'agent',
      eventType: 'agent.warning',
      agent: 'ceo',
      message: 'watch it',
    })
    store.append({
      sessionId: 's2',
      level: 'error',
      source: 'supervisor',
      eventType: 'runtime.error',
      message: 'failed',
    })

    const restarted = new EventStore(store.rootDir)
    const events = restarted.query({
      sessionId: 's1',
      agent: 'ceo',
      level: 'warn',
      eventType: 'agent.warning',
      since: first.timestamp,
      limit: 1,
    })

    expect(events).toHaveLength(1)
    expect(events[0]?.message).toBe('watch it')
  })
})

describe('Stage 5 host validation and endpoints', () => {
  it('rejects arbitrary command-shaped inputs and accepts typed run inputs', () => {
    const roster = createDefaultRoster('codex', 'Build')

    expect(validateStartRunInput({
      goal: 'Build',
      runtime: 'codex',
      loopMode: 'finite',
      loops: 5,
      pollInterval: 10,
      errorLimit: 2,
      roster,
    }).ok).toBe(true)

    expect(validateStartTakeoverInput({
      projectPath: '/tmp/repo && rm -rf /',
      runtime: 'codex',
      dryRun: false,
      infinite: true,
      pollInterval: 10,
    }).ok).toBe(false)
  })

  it('serves typed endpoints through the shared local host implementation', async () => {
    const root = tempRoot('host')
    const project = path.join(root, 'project')
    fs.mkdirSync(project, { recursive: true })
    fs.writeFileSync(path.join(project, 'package.json'), JSON.stringify({
      name: 'demo',
      scripts: { test: 'vitest' },
      devDependencies: { vitest: '^4.0.0', react: '^18.0.0' },
    }))
    fs.writeFileSync(path.join(project, 'README.md'), '# Demo\n\nUseful project.')

    const launcher: ProcessLauncher = {
      start: vi.fn(async session => ({
        endpoint: 'http://127.0.0.1:3999',
        port: 3999,
        stop: vi.fn(async () => undefined),
      })),
    }
    const host = new LocalControlHost({
      repoRoot: project,
      storageRoot: path.join(root, '.wanman/cockpit'),
      launcher,
      readinessRunner: async command => ({ ok: command === 'codex', message: `${command} checked` }),
    })

    const run = await host.startRun({
      goal: 'Build',
      runtime: 'codex',
      loopMode: 'finite',
      loops: 5,
      pollInterval: 10,
      errorLimit: 2,
      roster: createDefaultRoster('codex', 'Build'),
    })
    await host.pauseSupervisor({ sessionId: run.id })
    await host.resumeSupervisor({ sessionId: run.id })

    const status = await host.getRuntimeStatus()
    const sessions = host.listSessions()
    const events = host.getRuntimeEvents({ sessionId: run.id, eventType: 'runtime.resumed' })

    expect(status.activeSession?.id).toBe(run.id)
    expect(sessions[0]?.id).toBe(run.id)
    expect(events[0]?.eventType).toBe('runtime.resumed')
    expect(launcher.start).toHaveBeenCalledOnce()
  })
})

describe('Stage 5 dev bridge integration', () => {
  it('keeps the Vite dev bridge as a thin wrapper around cockpit-host', () => {
    const bridgePath = path.resolve(process.cwd(), '../../apps/cockpit/dev-runtime-bridge.ts')
    const source = fs.readFileSync(bridgePath, 'utf-8')

    expect(source).toContain("from '@wanman/cockpit-host'")
    expect(source).toContain('createLocalControlHost')
    expect(source).not.toContain('spawn(')
    expect(source).not.toContain('activeSession')
  })
})

describe('Stage 5 takeover preview and readiness', () => {
  it('maps project scan metadata without modifying the target repository', () => {
    const project = tempRoot('preview')
    fs.mkdirSync(path.join(project, 'src'))
    fs.mkdirSync(path.join(project, '.github/workflows'), { recursive: true })
    fs.writeFileSync(path.join(project, 'package.json'), JSON.stringify({
      name: 'preview-app',
      description: 'Preview app',
      scripts: { test: 'vitest', build: 'vite build' },
      dependencies: { react: '^18.0.0' },
      devDependencies: { vitest: '^4.0.0', vite: '^5.0.0' },
    }))
    fs.writeFileSync(path.join(project, 'README.md'), '# Preview App\n\nDocs.')

    const before = new Set(fs.readdirSync(project))
    const preview = buildTakeoverPreview({ projectPath: project, runtime: 'codex' })
    const after = new Set(fs.readdirSync(project))

    expect(preview.projectName).toBe('preview-app')
    expect(preview.frameworks).toContain('react')
    expect(preview.packageScripts).toContain('test')
    expect(preview.ciProviders).toContain('github-actions')
    expect(preview.generatedAgentRoster.agents.some(agent => agent.name === 'ceo')).toBe(true)
    expect(preview.overlayPath).toBeUndefined()
    expect(after).toEqual(before)
  })

  it('maps executable and auth readiness without exposing secrets', async () => {
    const readiness = await checkRuntimeReadiness(async command => ({
      ok: command !== 'claude',
      message: command === 'claude' ? 'not logged in' : 'ready token abc123',
      executablePath: `/usr/bin/${command}`,
    }))

    expect(readiness.selectedRuntimeReady.codex).toBe(true)
    expect(readiness.providers.codex.message).not.toContain('abc123')
    expect(readiness.providers.claude.ready).toBe(false)
    expect(readiness.providers.github.available).toBe(true)
  })
})
