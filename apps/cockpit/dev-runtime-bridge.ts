import type { ViteDevServer, Plugin } from 'vite'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createLocalControlHost } from '@wanman/cockpit-host'

const moduleDir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(moduleDir, '../..')

export function wanmanRuntimeBridgePlugin(): Plugin {
  const host = createLocalControlHost({
    repoRoot,
    storageRoot: path.join(repoRoot, '.wanman/cockpit'),
    defaultSupervisorUrl: process.env['VITE_WANMAN_URL'] ?? 'http://localhost:3120',
    hostMode: 'dev',
  })

  return {
    name: 'wanman-runtime-bridge',
    configureServer(server: ViteDevServer) {
      server.middlewares.use(async (req, res, next) => {
        if (!req.url) return next()
        if (await host.handleRequest(req, res)) return
        if (req.url === '/health' || req.url === '/rpc') {
          try {
            await host.proxyToSupervisor(req, res)
          } catch {
            res.writeHead(502, { 'content-type': 'application/json' })
            res.end(JSON.stringify({
              error: {
                code: 'SUPERVISOR_UNREACHABLE',
                message: 'Supervisor is not reachable.',
              },
            }))
          }
          return
        }
        next()
      })
    },
  }
}
