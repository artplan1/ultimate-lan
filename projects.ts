import { request } from 'node:https'
import { basename } from 'node:path'
import type { IncomingMessage } from 'node:http'
import { ordinary, publicOrigin, readConfig } from './config.ts'
import type { Project, Proxy, Target } from './config.ts'
import type { Host } from './lan.ts'
import type { ProjectChoice } from './refs.ts'

const DEADLINE_MS = 1500
const MAX_BYTES = 512 * 1024

/** Verify the real TLS route through the configured proxy, without exporting its response or any credential. */
export function probeProject(
  proxy: Proxy,
  target: Target,
  project: Project,
  signal: AbortSignal,
): Promise<boolean> {
  if (!project.running) return Promise.resolve(false)
  const origin = publicOrigin(proxy, target)
  return new Promise((resolve) => {
    let finished = false
    let response: IncomingMessage | undefined
    const finish = (ready: boolean) => {
      if (finished) return
      finished = true
      response?.destroy()
      outgoing.destroy()
      resolve(ready)
    }
    const outgoing = request(
      {
        hostname: proxy.address,
        port: target.httpsPort,
        servername: proxy.hostname,
        path: '/api/events',
        headers: { host: new URL(origin).host, accept: 'text/event-stream' },
        signal: AbortSignal.any([signal, AbortSignal.timeout(DEADLINE_MS)]),
        agent: false,
      },
      (incoming) => {
        response = incoming
        if (
          incoming.statusCode !== 200 ||
          !incoming.headers['content-type']?.startsWith('text/event-stream')
        ) {
          finish(false)
          return
        }
        let buffer = ''
        let received = 0
        incoming.setEncoding('utf8')
        incoming.on('data', (chunk: string) => {
          received += Buffer.byteLength(chunk)
          if (received > MAX_BYTES) {
            finish(false)
            return
          }
          buffer += chunk
          let end: number
          while ((end = buffer.indexOf('\n\n')) !== -1) {
            const frame = buffer.slice(0, end)
            buffer = buffer.slice(end + 2)
            if (!frame.startsWith('event: system\n')) continue
            try {
              const data = frame.split('\n').find((line) => line.startsWith('data: '))
              const system = JSON.parse(data?.slice(6) ?? '')
              finish(
                system.project?.root === project.root &&
                  system.process?.url === project.running!.url &&
                  typeof system.persistence?.path === 'string' &&
                  system.persistence.path.startsWith(project.home + '/') &&
                  Array.isArray(system.access?.origins) &&
                  system.access.origins.includes(origin),
              )
            } catch {
              // An incomplete or invalid identity response is not route readiness.
              finish(false)
            }
            return
          }
        })
        incoming.on('end', () => finish(false))
        incoming.on('error', () => finish(false))
        incoming.on('aborted', () => finish(false))
      },
    )
    outgoing.on('error', () => finish(false))
    outgoing.end()
  })
}

/** Known ordinary projects only; an alive supervisor alone must never be shown as a ready HTTPS route. */
export async function listProjects(host: Host, signal: AbortSignal): Promise<ProjectChoice[]> {
  const config = await readConfig(host.userHome)
  if (!config?.proxy) return []
  const proxy = config.proxy
  return Promise.all(
    (await host.projects())
      .filter((project) => ordinary(project, host.userHome))
      .map(async (project) => {
        const target = proxy.projects.find((target) => target.home === project.home)
        const base = {
          id: basename(project.home),
          name: target?.label ?? project.name,
          current: project.home === host.home,
        }
        if (!project.running) return { ...base, state: 'offline' as const }
        if (!target) return { ...base, state: 'unpublished' as const }
        const ready = await probeProject(proxy, target, project, signal)
        return {
          ...base,
          state: ready ? ('ready' as const) : ('not-ready' as const),
          ...(ready ? { href: publicOrigin(proxy, target) + '/' } : {}),
        }
      }),
  )
}
