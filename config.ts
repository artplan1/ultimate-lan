import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { isIPv4 } from 'node:net'
import { basename, isAbsolute, join } from 'node:path'

export interface Project {
  name: string
  home: string
  root?: string
  current: boolean
  running?: { pid: number; url: string }
}

export interface Target {
  home: string
  gatewayPort: number
  httpsPort: number
  label?: string
}

export interface Proxy {
  address: string
  hostname: string
  projects: Target[]
}

/** Plain HTTP on this host's own tailnet address, admitted by exact peers; the ports are the proxy targets'. */
export interface Tailscale {
  address: string
  peers: string[]
}

export interface Config {
  home: string
  address: string
  port: number
  proxy?: Proxy
  tailscale?: Tailscale
}

export function sameSubnet(peer: string | undefined, address: string) {
  return (
    !!peer &&
    isIPv4(peer) &&
    peer.split('.').slice(0, 3).join('.') === address.split('.').slice(0, 3).join('.')
  )
}

function privateAddress(address: unknown): address is string {
  if (typeof address !== 'string' || !isIPv4(address)) return false
  const [a, b] = address.split('.').map(Number)
  return a === 10 || (a === 172 && b! >= 16 && b! <= 31) || (a === 192 && b === 168)
}

/** Tailscale hands each node one address from the carrier-grade NAT range. */
function tailnet(address: unknown): address is string {
  if (typeof address !== 'string' || !isIPv4(address)) return false
  const [a, b] = address.split('.').map(Number)
  return a === 100 && b! >= 64 && b! <= 127
}

function port(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1024 && value <= 65535
}

/** This reproduces Ultimate's documented default home identity, not a new project registry. */
export function ordinary(project: Pick<Project, 'home' | 'root'>, userHome: string) {
  if (!project.root || !isAbsolute(project.root)) return false
  if (/\/\.ultimate\/projects\/[^/]+\/worktrees\//.test(project.root)) return false
  const hash = createHash('sha256').update(project.root).digest('hex').slice(0, 8)
  return project.home === join(userHome, '.ultimate/projects', `${basename(project.root)}-${hash}`)
}

export function publicOrigin(proxy: Proxy, target: Target) {
  return `https://${proxy.hostname}:${target.httpsPort}`
}

export async function readConfig(userHome: string): Promise<Config | undefined> {
  let settings: unknown
  try {
    settings = JSON.parse(await readFile(join(userHome, '.ultimate/settings.json'), 'utf8'))
  } catch (error) {
    // An unconfigured user home must not expose a listener.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  const value = (settings as { lan?: unknown } | null)?.lan
  if (value === undefined) return undefined
  if (!value || typeof value !== 'object') throw new Error('lan must be an object')
  const config = value as Config
  if (typeof config.home !== 'string' || !isAbsolute(config.home))
    throw new Error('lan.home must be an absolute instance home')
  if (!privateAddress(config.address))
    throw new Error('lan.address must be a specific private IPv4 address')
  config.port ??= 4751
  if (!port(config.port)) throw new Error('lan.port must be an integer from 1024 to 65535')
  const proxy = config.proxy
  if (proxy !== undefined) {
    if (!proxy || !privateAddress(proxy.address) || !sameSubnet(proxy.address, config.address))
      throw new Error('lan.proxy.address must be a specific IPv4 peer in the same /24')
    if (
      typeof proxy.hostname !== 'string' ||
      !/^[a-z0-9]+(?:[.-][a-z0-9]+)+$/.test(proxy.hostname) ||
      isIPv4(proxy.hostname)
    )
      throw new Error('lan.proxy.hostname must be a lowercase DNS hostname without a port')
    if (!Array.isArray(proxy.projects))
      throw new Error('lan.proxy.projects must be an explicit target list')
    const homes = new Set<string>()
    const gateways = new Set<number>()
    const https = new Set<number>()
    for (const target of proxy.projects) {
      if (
        !target ||
        typeof target.home !== 'string' ||
        !isAbsolute(target.home) ||
        !port(target.gatewayPort) ||
        !port(target.httpsPort)
      )
        throw new Error('Every LAN target needs an absolute home, gatewayPort and httpsPort')
      if (target.label !== undefined && (typeof target.label !== 'string' || !target.label.trim()))
        throw new Error('LAN target labels must be non-empty strings')
      if (homes.has(target.home) || gateways.has(target.gatewayPort) || https.has(target.httpsPort))
        throw new Error('LAN target homes and ports must be unique')
      if (
        (target.home === config.home && target.gatewayPort !== config.port) ||
        (target.home !== config.home && target.gatewayPort === config.port)
      )
        throw new Error('The existing HTTP fallback port belongs only to lan.home')
      homes.add(target.home)
      gateways.add(target.gatewayPort)
      https.add(target.httpsPort)
    }
  }
  const tailscale = config.tailscale
  if (tailscale !== undefined) {
    if (!tailscale || typeof tailscale !== 'object')
      throw new Error('lan.tailscale must be an object')
    if (!tailnet(tailscale.address))
      throw new Error('lan.tailscale.address must be this host\'s Tailscale IPv4 address')
    if (!Array.isArray(tailscale.peers) || tailscale.peers.length === 0)
      throw new Error('lan.tailscale.peers must be an explicit allowlist of Tailscale IPv4 addresses')
    const peers = new Set<string>()
    for (const peer of tailscale.peers) {
      if (!tailnet(peer))
        throw new Error('lan.tailscale.peers must contain Tailscale IPv4 addresses only')
      if (peers.has(peer)) throw new Error('LAN Tailscale peers must be unique')
      peers.add(peer)
    }
    // The host itself is a client of its own tailnet address, and every probe of another project comes from it.
    if (!peers.has(tailscale.address))
      throw new Error('lan.tailscale.peers must include lan.tailscale.address')
    if (!proxy) throw new Error('lan.tailscale needs lan.proxy for the per-project port map')
  }
  return config
}
