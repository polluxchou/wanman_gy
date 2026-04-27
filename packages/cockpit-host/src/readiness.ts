import { spawn } from 'node:child_process'
import type { CommandCheckResult, ReadinessRunner, RuntimeProviderReadiness, RuntimeReadiness } from './types.js'
import { sanitizeMessage } from './safety.js'

async function runFixedCommand(command: 'claude' | 'codex' | 'github'): Promise<CommandCheckResult> {
  const args = command === 'github' ? ['auth', 'status'] : ['--version']
  const bin = command === 'github' ? 'gh' : command
  return await new Promise(resolve => {
    const child = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'], shell: false })
    let stderr = ''
    child.stderr?.on('data', chunk => {
      stderr += chunk.toString()
    })
    child.on('error', error => {
      resolve({ ok: false, message: `${command} executable is not available: ${error.message}` })
    })
    child.on('close', code => {
      if (code === 0) resolve({ ok: true, message: `${command} is available and authenticated.` })
      else resolve({ ok: false, message: stderr.trim() || `${command} readiness check exited with ${code}.` })
    })
  })
}

function provider(name: RuntimeProviderReadiness['name'], result: CommandCheckResult): RuntimeProviderReadiness {
  const message = sanitizeMessage(result.message)
  const available = !/not available|ENOENT|not found/i.test(message)
  return {
    name,
    available,
    authenticated: result.ok,
    ready: result.ok,
    message,
    executablePath: result.executablePath,
    suggestedFix: result.ok
      ? undefined
      : name === 'github'
        ? 'Install GitHub CLI and run gh auth login if takeover needs GitHub signals.'
        : `Install or authenticate the ${name} CLI before selecting this runtime.`,
  }
}

export async function checkRuntimeReadiness(runner: ReadinessRunner = runFixedCommand): Promise<RuntimeReadiness> {
  const [claude, codex, github] = await Promise.all([
    runner('claude'),
    runner('codex'),
    runner('github'),
  ])
  const providers = {
    claude: provider('claude', claude),
    codex: provider('codex', codex),
    github: provider('github', github),
  }
  return {
    providers,
    selectedRuntimeReady: {
      claude: providers.claude.ready,
      codex: providers.codex.ready,
    },
  }
}
