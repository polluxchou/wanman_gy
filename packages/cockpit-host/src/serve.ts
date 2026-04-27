#!/usr/bin/env node
import * as path from 'node:path'
import { createLocalControlHostServer } from './host.js'

function readArg(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  if (index < 0) return undefined
  return process.argv[index + 1]
}

const repoRoot = path.resolve(readArg('--repo') ?? process.cwd())
const storageRoot = readArg('--storage')
  ? path.resolve(readArg('--storage')!)
  : path.join(repoRoot, '.wanman/cockpit')
const port = Number(readArg('--port') ?? process.env['WANMAN_COCKPIT_HOST_PORT'] ?? 5174)
const host = readArg('--host') ?? process.env['WANMAN_COCKPIT_HOST_BIND'] ?? '127.0.0.1'

if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') {
  console.error(`Error: cockpit host only binds to local addresses (127.0.0.1, localhost, ::1).`)
  console.error(`Received: --host ${host}`)
  console.error(`The host is local-only for safety. Do not expose it on a network interface.`)
  process.exit(1)
}

const server = createLocalControlHostServer({
  repoRoot,
  storageRoot,
  port,
  host,
  hostMode: 'local',
})

await server.listen()

const hostUrl = `http://${host}:${port}`
console.log(`Wanman cockpit host started`)
console.log(`  Host URL:     ${hostUrl}`)
console.log(`  Repo root:    ${repoRoot}`)
console.log(`  Storage root: ${storageRoot}`)
console.log(`  Event stream: ${hostUrl}/runtime/events/stream`)
console.log(`  Cockpit UI:   run  pnpm --filter apps/cockpit dev  then open http://localhost:5173`)
console.log(`  Env hint:     VITE_WANMAN_CONTROL_URL=${hostUrl}`)
