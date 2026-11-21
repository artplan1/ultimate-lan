import { request as localRequest } from 'node:http'
import { request as secureRequest } from 'node:https'
import type { ClientRequest, IncomingMessage } from 'node:http'
import { basename } from 'node:path'
import { ordinary, publicOrigin, readConfig } from './config.ts'
import type { Config, Project, Proxy, Tailscale, Target } from './config.ts'
import type { Host } from './lan.ts'
import type { ProjectChoice } from './refs.ts'

const DEADLINE_MS = 1500
const MAX_BYTES = 512 * 1024

type Transport = 'lan' | 'https' | 'tailscale'

/**
 * Match the page's own origin against the bases this configuration actually opens. The argument comes from the
 * browser, so it is only ever compared, never fetched: links and probes are built from the configuration alone.
 */
function transportOf(config: Config, origin: unknown): Transport | undefined {
  if (typeof origin !== 'string') return undefined
  const proxy = config.proxy
  const tailscale = config.tailscale
  if (proxy) {
    for (const target of proxy.projects) if (origin === publicOrigin(proxy, target)) return 'https'
  }
  // The owner's plaintext base this host's own gateway admits for its /24; it never serves another project.
  if (origin === `http://${config.address}:${config.port}`) return 'lan'
  if (tailscale) {
    if (origin === `http://${tailscale.address}:${config.port}`) return 'tailscale'
    for (const target of proxy?.projects ?? [])
      if (origin === `http://${tailscale.address}:${target.gatewayPort}`) return 'tailscale'
  }
  return undefined
}

/** Read the identity event once, with the exact origin the route must prove it admits. */
function probeEvents(
  origin: string,
  project: Project,
  signal: AbortSignal,
  send: (signal: AbortSignal, onResponse: (incoming: IncomingMessage) => void) => ClientRequest,
): Promise<boolean> {
  return new Promise((resolve) => {
    let finished = false
    let response: IncomingMessage | undefined
    let outgoing: ClientRequest | undefined
    const finish = (ready: boolean) => {
      if (finished) return
      finished = true
      response?.destroy()
      outgoing?.destroy()
      resolve(ready)
    }
    try {
      outgoing = send(AbortSignal.any([signal, AbortSignal.timeout(DEADLINE_MS)]), (incoming) => {
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
      })
    } catch {
      finish(false)
      return
    }
    outgoing.on('error', () => finish(false))
    outgoing.end()
  })
}

/** Verify the real TLS route through the configured proxy, without exporting its response or any credential. */
export function probeProject(
  proxy: Proxy,
  target: Target,
  project: Project,
  signal: AbortSignal,
): Promise<boolean> {
  if (!project.running) return Promise.resolve(false)
  const origin = publicOrigin(proxy, target)
  return probeEvents(origin, project, signal, (probe, onResponse) =>
    secureRequest(
      {
        hostname: proxy.address,
        port: target.httpsPort,
        servername: proxy.hostname,
        path: '/api/events',
        headers: { host: new URL(origin).host, accept: 'text/event-stream' },
        signal: probe,
        agent: false,
      },
      onResponse,
    ),
  )
}

/** Verify the plain HTTP route this host opens on its own Tailscale address for the configured peers. */
export function probeTailscale(
  tailscale: Tailscale,
  port: number,
  project: Project,
  signal: AbortSignal,
): Promise<boolean> {
  if (!project.running) return Promise.resolve(false)
  const authority = `${tailscale.address}:${port}`
  return probeEvents(`http://${authority}`, project, signal, (probe, onResponse) =>
    localRequest(
      {
        hostname: tailscale.address,
        port,
        path: '/api/events',
        headers: { host: authority, accept: 'text/event-stream' },
        signal: probe,
        agent: false,
      },
      onResponse,
    ),
  )
}

/** Known ordinary projects only; an alive supervisor alone must never be shown as a ready route. */
export async function listProjects(
  host: Host,
  signal: AbortSignal,
  origin?: unknown,
): Promise<ProjectChoice[]> {
  const config = await readConfig(host.userHome)
  if (!config) return []
  const transport = transportOf(config, origin)
  // The owner's plaintext base is served only by the owner's own process; in any other process it is a bare claim.
  if (!transport || (transport === 'lan' && config.home !== host.home)) return []
  const proxy = config.proxy
  return Promise.all(
    (await host.projects())
      .filter((project) => ordinary(project, host.userHome))
      .map(async (project) => {
        const target = proxy?.projects.find((candidate) => candidate.home === project.home)
        const current = project.home === host.home
        const base = {
          id: basename(project.home),
          name: target?.label ?? project.name,
          current,
        }
        if (!project.running) return { ...base, state: 'offline' as const }
        if (transport === 'lan') {
          // Only the page's own project is admitted on this base; the others stay behind the proxy.
          if (current) return { ...base, state: 'ready' as const }
          return { ...base, state: target ? ('https-only' as const) : ('unpublished' as const) }
        }
        if (transport === 'https') {
          if (!proxy || !target) return { ...base, state: 'unpublished' as const }
          const ready = await probeProject(proxy, target, project, signal)
          return {
            ...base,
            state: ready ? ('ready' as const) : ('not-ready' as const),
            ...(ready && !current ? { href: publicOrigin(proxy, target) + '/' } : {}),
          }
        }
        const tailscale = config.tailscale!
        const port = target?.gatewayPort ?? (project.home === config.home ? config.port : undefined)
        if (port === undefined) return { ...base, state: 'unpublished' as const }
        const ready = await probeTailscale(tailscale, port, project, signal)
        return {
          ...base,
          state: ready ? ('ready' as const) : ('not-ready' as const),
          ...(ready && !current ? { href: `http://${tailscale.address}:${port}/` } : {}),
        }
      }),
  )
}
