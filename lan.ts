import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, request } from 'node:http'
import type { IncomingHttpHeaders, Server } from 'node:http'
import { ordinary, publicOrigin, readConfig, sameSubnet } from './config.ts'
import type { Project } from './config.ts'

interface Rule {
  origin: string
  verify(request: { headers: IncomingHttpHeaders }): { login: string } | undefined
}

export interface Host {
  home: string
  userHome: string
  projectRoot: string
  projects(): Promise<Project[]>
  system(): { process: { url: string } }
  access: { allow(rule: Rule): () => void }
  onOpen(callback: () => Promise<void>): void
  onRelease(callback: () => Promise<void>): void
  onClose(callback: () => Promise<void>): void
}

const hopHeaders = [
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]
const tokenHeader = 'x-ultimate-lan-token'

function stripHopHeaders(headers: IncomingHttpHeaders): IncomingHttpHeaders {
  const clean = { ...headers }
  for (const key of (headers.connection ?? '').toLowerCase().split(',')) delete clean[key.trim()]
  for (const key of hopHeaders) delete clean[key]
  return clean
}

/** One selected ordinary host owns one ingress per transport; the existing owner also retains its direct HTTP fallback. */
export function installLan(host: Host) {
  let servers: Server[] = []
  let revocations: (() => void)[] = []
  let generation = 0
  let pending = Promise.resolve()
  const serial = (operation: () => Promise<void>) => {
    const result = pending.then(operation)
    // The caller receives failures; later lifecycle operations must still be able to close or reopen the listener.
    pending = result.catch(() => {})
    return result
  }
  const stop = (server: Server) =>
    new Promise<void>((resolve) => {
      server.close(() => resolve())
      server.closeAllConnections()
    })
  const close = async () => {
    for (const revoke of revocations) revoke()
    revocations = []
    const closing = servers
    servers = []
    await Promise.all(closing.map(stop))
  }
  const release = () => {
    generation++
    return serial(close)
  }
  host.onRelease(release)
  host.onClose(release)
  host.onOpen(() => {
    const opening = ++generation
    return serial(async () => {
      await close()
      const config = await readConfig(host.userHome)
      if (
        !config ||
        opening !== generation ||
        !ordinary({ home: host.home, root: host.projectRoot }, host.userHome)
      )
        return
      const direct = config.home === host.home
      const target = config.proxy?.projects.find((target) => target.home === host.home)
      if (!direct && !target) return
      const port = target?.gatewayPort ?? config.port
      const directAuthority = `${config.address}:${port}`
      const directOrigin = `http://${directAuthority}`
      const httpsOrigin = config.proxy && target ? publicOrigin(config.proxy, target) : undefined
      const httpsAuthority = httpsOrigin ? new URL(httpsOrigin).host : undefined
      const tailscale = config.tailscale
      const tailAuthority = tailscale ? `${tailscale.address}:${port}` : undefined
      const peers = new Set(tailscale?.peers)
      const upstream = new URL(host.system().process.url)
      if (
        upstream.protocol !== 'http:' ||
        upstream.hostname !== '127.0.0.1' ||
        upstream.username ||
        upstream.password ||
        upstream.pathname !== '/' ||
        upstream.search ||
        upstream.hash
      )
        throw new Error('LAN upstream must be the loopback HTTP supervisor')
      const token = randomBytes(32).toString('hex')
      const verify: Rule['verify'] = ({ headers }) => {
        const value = headers[tokenHeader]
        return typeof value === 'string' &&
          Buffer.byteLength(value) === token.length &&
          timingSafeEqual(Buffer.from(value), Buffer.from(token))
          ? { login: 'unauthenticated-lan' }
          : undefined
      }
      const ingress = (transport: 'lan' | 'tailscale') => {
        const gateway = createServer((incoming, outgoing) => {
          const peer = incoming.socket.remoteAddress
          const allowed =
            transport === 'lan'
              ? (direct &&
                  incoming.headers.host === directAuthority &&
                  sameSubnet(peer, config.address)) ||
                (httpsAuthority !== undefined &&
                  incoming.headers.host === httpsAuthority &&
                  peer === config.proxy!.address)
              : incoming.headers.host === tailAuthority &&
                typeof peer === 'string' &&
                peers.has(peer)
          if (!allowed) {
            outgoing.writeHead(403).end('Forbidden')
            return
          }
          // Do not let a Connection-nominated security header disappear before the core checks it.
          if (
            // On the tailnet transport the Host header is the only authority discriminator, so a repeated or
            // present-but-empty value the core would read as absent fails closed here. A header block past the
            // parser's limits is answered 431 before this handler runs (pinned in test/lan.test.ts).
            (transport === 'tailscale' &&
              (incoming.headers.origin === '' ||
                (incoming.headersDistinct.host?.length ?? 0) > 1)) ||
            (incoming.headers.connection ?? '')
              .toLowerCase()
              .split(',')
              .some((value) => !['', 'close', 'keep-alive'].includes(value.trim())) ||
            incoming.headers.upgrade ||
            !incoming.url?.startsWith('/')
          ) {
            outgoing.writeHead(400).end('Unsupported request')
            return
          }
          const headers = stripHopHeaders(incoming.headers)
          for (const key of Object.keys(headers))
            if (/^(tailscale[-_]|x-forwarded-|forwarded$)/i.test(key)) delete headers[key]
          // A process-local proof that this ingress checked the real peer and exact authority, not a user identity.
          headers[tokenHeader] = token
          headers['x-forwarded-for'] = peer
          // Preserve Host, Origin and Fetch Metadata. The core still admits assets, API, actions and SSE itself.
          const forward = request(
            {
              hostname: upstream.hostname,
              port: upstream.port || 80,
              method: incoming.method,
              path: incoming.url,
              headers,
              agent: false,
            },
            (response) => {
              outgoing.writeHead(response.statusCode ?? 502, stripHopHeaders(response.headers))
              response.on('error', (error) => outgoing.destroy(error))
              response.pipe(outgoing)
            },
          )
          forward.on('error', () => {
            if (!outgoing.headersSent) outgoing.writeHead(502).end('Ultimate unavailable')
            else outgoing.destroy()
          })
          incoming.on('aborted', () => forward.destroy())
          incoming.on('error', () => forward.destroy())
          outgoing.on('close', () => forward.destroy())
          incoming.pipe(forward)
        })
        // Neither upgrades nor CONNECT may bypass the HTTP ingress checks.
        gateway.on('upgrade', (_request, socket) => socket.destroy())
        gateway.on('connect', (_request, socket) => socket.destroy())
        servers.push(gateway)
        return gateway
      }
      const bind = (gateway: Server, address: string) =>
        new Promise<void>((resolve, reject) => {
          gateway.once('error', reject)
          gateway.listen(port, address, () => {
            gateway.off('error', reject)
            resolve()
          })
        })
      try {
        await bind(ingress('lan'), config.address)
        if (direct) revocations.push(host.access.allow({ origin: directOrigin, verify }))
        if (httpsOrigin) revocations.push(host.access.allow({ origin: httpsOrigin, verify }))
      } catch (error) {
        await close()
        throw new Error(`Cannot open LAN gateway at ${directAuthority}`, { cause: error })
      }
      let tail = false
      if (tailscale) {
        const gateway = ingress('tailscale')
        try {
          await bind(gateway, tailscale.address)
          revocations.push(host.access.allow({ origin: `http://${tailAuthority}`, verify }))
          tail = true
        } catch (error) {
          // An absent Tailscale address (the daemon is off) must leave the LAN and proxy routes exactly as they were.
          servers = servers.filter((server) => server !== gateway)
          await stop(gateway)
          console.error(
            `Ultimate LAN: cannot listen on Tailscale address ${tailscale.address}: ${(error as Error).message}`,
          )
        }
      }
      if (opening !== generation) {
        await close()
        return
      }
      console.log(
        `Ultimate LAN gateway: ${config.address}:${port} (NO AUTHENTICATION${direct ? '; HTTP fallback enabled' : '; configured proxy only'})`,
      )
      if (tail)
        console.log(
          `Ultimate LAN Tailscale gateway: ${tailAuthority} (NO AUTHENTICATION; ${peers.size} exact peers)`,
        )
    })
  })
}
