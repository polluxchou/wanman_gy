import * as fs from 'node:fs'
import * as net from 'node:net'
import * as path from 'node:path'
import { spawn } from 'node:child_process'
import type { AgentMatrixConfig } from '@wanman/core'
import type { ProcessLauncher, ProcessLauncherCallbacks, RunSession, StartRunInput, StartTakeoverInput, SupervisorHandle } from './types.js'

async function pickAvailablePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer()
    server.unref()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('Failed to pick a local supervisor port')))
        return
      }
      server.close(error => error ? reject(error) : resolve(address.port))
    })
  })
}

async function waitForHealth(endpoint: string, timeoutMs = 30_000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${endpoint}/health`, { signal: AbortSignal.timeout(1000) })
      if (res.ok) return
    } catch {
      // retry
    }
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  throw new Error('Supervisor did not become healthy before timeout.')
}

function copyDirIfExists(source: string, target: string): void {
  if (!fs.existsSync(source)) return
  fs.cpSync(source, target, { recursive: true, force: true, dereference: false })
}

function pipeLogLines(
  stream: import('node:stream').Readable,
  src: 'stdout' | 'stderr',
  onLine: (line: string, src: 'stdout' | 'stderr') => void,
): void {
  let buf = ''
  stream.on('data', (chunk: Buffer) => {
    buf += chunk.toString()
    let nl: number
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trimEnd()
      buf = buf.slice(nl + 1)
      if (line) onLine(line, src)
    }
  })
  stream.on('end', () => {
    if (buf.trim()) onLine(buf.trim(), src)
  })
}

export class LocalProcessLauncher implements ProcessLauncher {
  constructor(private readonly repoRoot: string) {}

  async start(session: RunSession, config: AgentMatrixConfig, input: StartRunInput | StartTakeoverInput, callbacks?: ProcessLauncherCallbacks): Promise<SupervisorHandle> {
    const runtimeEntrypoint = path.join(this.repoRoot, 'packages/runtime/dist/entrypoint.js')
    const cliEntrypoint = path.join(this.repoRoot, 'packages/cli/dist/index.js')
    if (!fs.existsSync(runtimeEntrypoint)) {
      throw new Error('Missing packages/runtime/dist/entrypoint.js. Run pnpm --filter @wanman/runtime build first.')
    }
    if (!fs.existsSync(cliEntrypoint)) {
      throw new Error('Missing packages/cli/dist/index.js. Run pnpm --filter @wanman/cli build first.')
    }

    const port = await pickAvailablePort()
    const outputDir = path.resolve(session.outputDir ?? path.join(this.repoRoot, '.wanman/cockpit/runs'), session.id)
    fs.rmSync(outputDir, { recursive: true, force: true })
    const workspacePath = path.join(outputDir, 'agents')
    const sharedSkillsDir = path.join(outputDir, 'shared-skills')
    const homeRoot = path.join(outputDir, 'home')
    const binDir = path.join(outputDir, 'bin')
    const configPath = path.join(outputDir, 'agents.json')
    fs.mkdirSync(workspacePath, { recursive: true })
    fs.mkdirSync(sharedSkillsDir, { recursive: true })
    fs.mkdirSync(homeRoot, { recursive: true })
    fs.mkdirSync(binDir, { recursive: true })

    const finalConfig: AgentMatrixConfig = {
      ...config,
      port,
      dbPath: path.join(outputDir, 'wanman.db'),
      workspaceRoot: workspacePath,
      gitRoot: session.projectPath ?? this.repoRoot,
    }
    fs.writeFileSync(configPath, JSON.stringify(finalConfig, null, 2))
    copyDirIfExists(path.join(this.repoRoot, 'packages/core/skills'), sharedSkillsDir)
    for (const agent of finalConfig.agents) {
      const agentDir = path.join(workspacePath, agent.name)
      fs.mkdirSync(path.join(agentDir, 'output'), { recursive: true })
      fs.writeFileSync(path.join(agentDir, 'AGENT.md'), `# ${agent.name}\n\n${agent.systemPrompt}\n`)
    }
    const wanmanWrapper = path.join(binDir, 'wanman')
    fs.writeFileSync(wanmanWrapper, `#!/usr/bin/env bash\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(cliEntrypoint)} "$@"\n`)
    fs.chmodSync(wanmanWrapper, 0o755)

    const child = spawn(process.execPath, [runtimeEntrypoint], {
      cwd: finalConfig.gitRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
      env: {
        ...process.env,
        HOME: homeRoot,
        PATH: `${binDir}:${process.env['PATH'] ?? ''}`,
        WANMAN_URL: `http://127.0.0.1:${port}`,
        WANMAN_CONFIG: configPath,
        WANMAN_WORKSPACE: workspacePath,
        WANMAN_SKILLS: workspacePath,
        WANMAN_SHARED_SKILLS: sharedSkillsDir,
        WANMAN_GIT_ROOT: finalConfig.gitRoot,
        WANMAN_GOAL: session.goal,
        WANMAN_RUNTIME: session.runtime,
        ...('codexModel' in input && input.codexModel ? { WANMAN_CODEX_MODEL: input.codexModel } : {}),
        ...('codexReasoningEffort' in input && input.codexReasoningEffort ? { WANMAN_CODEX_REASONING_EFFORT: input.codexReasoningEffort } : {}),
      },
    })
    if (callbacks?.onLogLine) {
      const cb = callbacks.onLogLine
      if (child.stdout) pipeLogLines(child.stdout, 'stdout', cb)
      if (child.stderr) pipeLogLines(child.stderr, 'stderr', cb)
    }

    const endpoint = `http://127.0.0.1:${port}`
    await waitForHealth(endpoint)

    return {
      endpoint,
      port,
      workspacePath,
      configPath,
      outputDir,
      async stop(force = false) {
        child.kill('SIGTERM')
        await new Promise(resolve => setTimeout(resolve, force ? 100 : 1000))
        if (child.exitCode === null) child.kill('SIGKILL')
      },
    }
  }
}
