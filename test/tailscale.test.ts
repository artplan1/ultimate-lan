import assert from 'node:assert/strict'
import { after, test, mock } from 'node:test'
import * as http from 'node:http'
import * as https from 'node:https'
import { createServer, type Server } from 'node:https'
import { getCACertificates, setDefaultCACertificates } from 'node:tls'
import type { AddressInfo } from 'node:net'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Host } from '../lan.ts'
import type { Project, Tailscale } from '../config.ts'

// No test machine owns a Tailscale or private LAN address, so each request is forwarded to loopback while the exact
// hostname, port, servername and Host header production builds are recorded and asserted.
const asks: http.RequestOptions[] = []
const routes = new Map<number, number>()
const forward =
  (send: typeof http.request) =>
  (options: http.RequestOptions, callback?: (response: http.IncomingMessage) => void) => {
    asks.push({ ...options })
    const port = routes.get(Number(options.port)) ?? Number(options.port)
    return send({ ...options, hostname: '127.0.0.1', port }, callback)
  }
mock.module('node:http', { exports: { ...http, request: forward(http.request) } })
mock.module('node:https', { exports: { ...https, request: forward(https.request) } })
const { listProjects, probeTailscale } = await import('../projects.ts')

const tailscale: Tailscale = { address: '100.64.0.9', peers: ['100.64.0.9', '100.64.0.10'] }

const temp = await mkdtemp(join(tmpdir(), 'ultimate-lan-tailnet-test-'))
after(async () => {
  await rm(temp, { recursive: true, force: true })
})
const homeFor = (root: string) =>
  join(
    temp,
    '.ultimate/projects',
    root.split('/').at(-1) + '-' + createHash('sha256').update(root).digest('hex').slice(0, 8),
  )
const project: Project = {
  name: 'project-a',
  root: '/workspace/project-a',
  home: homeFor('/workspace/project-a'),
  current: true,
  running: { pid: process.pid, url: 'http://127.0.0.1:4790' },
}
const other: Project = {
  name: 'project-b',
  root: '/workspace/project-b',
  home: homeFor('/workspace/project-b'),
  current: false,
  running: { pid: process.pid, url: 'http://127.0.0.1:4791' },
}
const offline: Project = {
  name: 'project-c',
  root: '/workspace/project-c',
  home: homeFor('/workspace/project-c'),
  current: false,
}
const unmapped: Project = {
  name: 'project-d',
  root: '/workspace/project-d',
  home: homeFor('/workspace/project-d'),
  current: false,
  running: { pid: process.pid, url: 'http://127.0.0.1:4792' },
}

let mode: 'valid' | 'wrong-origin' = 'valid'
const servers: http.Server[] = []

/** One project's plaintext tailnet route: a real HTTP stream that names the project and the origin it admits. */
async function events(gatewayPort: number, subject: Project) {
  const server = http.createServer((request, response) => {
    assert.equal(request.url, '/api/events')
    assert.equal(request.headers.host, `100.64.0.9:${gatewayPort}`)
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    const system = {
      project: { root: subject.root },
      process: { url: subject.running!.url },
      persistence: { path: subject.home + '/chapters/example/state.sqlite' },
      access: {
        origins:
          mode === 'valid' ? [`http://100.64.0.9:${gatewayPort}`] : ['http://100.64.0.15:1'],
      },
    }
    response.write('event: system\ndata: ' + JSON.stringify(system) + '\n\n')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  routes.set(gatewayPort, (server.address() as AddressInfo).port)
  servers.push(server)
  return server
}

test('tailnet readiness proves the exact plaintext authority and project identity', async () => {
  await events(4751, project)
  const signal = new AbortController().signal
  try {
    assert.equal(await probeTailscale(tailscale, 4751, project, signal), true)
    assert.equal(asks.at(-1)!.hostname, '100.64.0.9')
    assert.equal(asks.at(-1)!.port, 4751)
    assert.equal((asks.at(-1)!.headers as Record<string, string>).host, '100.64.0.9:4751')
    assert.equal((asks.at(-1)!.headers as Record<string, string>).accept, 'text/event-stream')
    mode = 'wrong-origin'
    assert.equal(
      await probeTailscale(tailscale, 4751, project, signal),
      false,
      'a route that does not admit this origin is not ready',
    )
    mode = 'valid'
    assert.equal(
      await probeTailscale(tailscale, 4751, { ...project, running: undefined }, signal),
      false,
      'a stopped project is never ready',
    )
    const cancelled = new AbortController()
    cancelled.abort()
    assert.equal(await probeTailscale(tailscale, 4751, project, cancelled.signal), false)
  } finally {
    for (const server of servers) {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }
})

test('links keep the page base and its per-project ports; any other origin gets none', async () => {
  await events(4751, project)
  await events(4752, other)
  await mkdir(join(temp, '.ultimate'), { recursive: true })
  await writeFile(
    join(temp, '.ultimate/settings.json'),
    JSON.stringify({
      lan: {
        home: project.home,
        address: '10.20.30.1',
        port: 4751,
        proxy: {
          address: '10.20.30.4',
          hostname: 'lan.example.org',
          projects: [
            { home: project.home, gatewayPort: 4751, httpsPort: 8443 },
            { home: other.home, gatewayPort: 4752, httpsPort: 8444 },
          ],
        },
        tailscale,
      },
    }),
  )
  const host = {
    userHome: temp,
    home: project.home,
    projects: async () => [project, other, offline, unmapped],
  } as Host
  const signal = new AbortController().signal
  try {
    assert.deepEqual(
      (await listProjects(host, signal, 'http://100.64.0.9:4751')).map((p) => [
        p.name,
        p.state,
        p.href,
      ]),
      [
        ['project-a', 'ready', undefined],
        ['project-b', 'ready', 'http://100.64.0.9:4752/'],
        ['project-c', 'offline', undefined],
        ['project-d', 'unpublished', undefined],
      ],
    )
    // The same base is reachable from another project's page: its own port is the page, the rest stay on it.
    const second = { ...host, home: other.home } as Host
    assert.deepEqual(
      (await listProjects(second, signal, 'http://100.64.0.9:4752')).map((p) => [
        p.name,
        p.state,
        p.href,
      ]),
      [
        ['project-a', 'ready', 'http://100.64.0.9:4751/'],
        ['project-b', 'ready', undefined],
        ['project-c', 'offline', undefined],
        ['project-d', 'unpublished', undefined],
      ],
    )
    // A route that no longer admits its own origin is reported, not linked.
    mode = 'wrong-origin'
    assert.deepEqual(
      (await listProjects(host, signal, 'http://100.64.0.9:4751')).map((p) => [p.name, p.state, p.href]),
      [
        ['project-a', 'not-ready', undefined],
        ['project-b', 'not-ready', undefined],
        ['project-c', 'offline', undefined],
        ['project-d', 'unpublished', undefined],
      ],
    )
    mode = 'valid'
    // The owner's plaintext LAN base admits only the page's own project; the proxy serves the others.
    assert.deepEqual(
      (await listProjects(host, signal, 'http://10.20.30.1:4751')).map((p) => [
        p.name,
        p.state,
        p.href,
      ]),
      [
        ['project-a', 'ready', undefined],
        ['project-b', 'https-only', undefined],
        ['project-c', 'offline', undefined],
        ['project-d', 'unpublished', undefined],
      ],
    )
    // The owner's plaintext LAN base is a bare claim from any process that does not own it, so it links nothing.
    assert.deepEqual(await listProjects(second, signal, 'http://10.20.30.1:4751'), [])
    // An unmapped owner still serves its own tailnet port, so another project's page links it there.
    await writeFile(
      join(temp, '.ultimate/settings.json'),
      JSON.stringify({
        lan: {
          home: project.home,
          address: '10.20.30.1',
          port: 4751,
          proxy: {
            address: '10.20.30.4',
            hostname: 'lan.example.org',
            projects: [{ home: other.home, gatewayPort: 4752, httpsPort: 8444 }],
          },
          tailscale,
        },
      }),
    )
    assert.deepEqual(
      (await listProjects(second, signal, 'http://100.64.0.9:4752')).map((p) => [
        p.name,
        p.state,
        p.href,
      ]),
      [
        ['project-a', 'ready', 'http://100.64.0.9:4751/'],
        ['project-b', 'ready', undefined],
        ['project-c', 'offline', undefined],
        ['project-d', 'unpublished', undefined],
      ],
    )
    // An origin this configuration does not open is a browser claim, not a base: no link may follow from it.
    for (const origin of [
      'http://100.64.0.9:4753',
      'http://100.64.0.9',
      'http://100.64.0.11:4751',
      'https://100.64.0.9:4751',
      'http://10.20.30.1:4752',
      'http://evil.invalid:4751',
      'http://100.64.0.9:4751/',
      'file:///etc/passwd',
    ])
      assert.deepEqual(await listProjects(host, signal, origin), [], origin)
    assert.deepEqual(await listProjects(host, signal), [])
  } finally {
    for (const server of servers) {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }
})

test('an HTTPS page links every healthy published project on its own host and port, never itself', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ultimate-lan-https-test-'))
  const roots = getCACertificates()
  const certPath = join(dir, 'fixture.crt')
  const keyPath = join(dir, 'fixture.key')
  // Synthetic test key is generated outside the source tree, never printed, persisted in the artifact or used by a host.
  const generated = spawnSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      keyPath,
      '-out',
      certPath,
      '-days',
      '1',
      '-subj',
      '/CN=lan.example.org',
      '-addext',
      'subjectAltName=DNS:lan.example.org',
      '-addext',
      'extendedKeyUsage=serverAuth',
    ],
    { stdio: 'ignore' },
  )
  assert.equal(
    generated.status,
    0,
    'existing OpenSSL must generate the private loopback-only TLS fixture',
  )
  const cert = await readFile(certPath, 'utf8')
  const key = await readFile(keyPath, 'utf8')
  const published: Server[] = []
  const publish = async (httpsPort: number, subject: Project) => {
    const server = createServer({ cert, key }, (request, response) => {
      assert.equal(request.url, '/api/events')
      assert.equal(request.headers.host, `lan.example.org:${httpsPort}`)
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write(
        'event: system\ndata: ' +
          JSON.stringify({
            project: { root: subject.root },
            process: { url: subject.running!.url },
            persistence: { path: subject.home + '/chapters/example/state.sqlite' },
            access: { origins: [`https://lan.example.org:${httpsPort}`] },
          }) +
          '\n\n',
      )
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    routes.set(httpsPort, (server.address() as AddressInfo).port)
    published.push(server)
  }
  await publish(8443, project)
  await publish(8444, other)
  await mkdir(join(temp, '.ultimate'), { recursive: true })
  await writeFile(
    join(temp, '.ultimate/settings.json'),
    JSON.stringify({
      lan: {
        home: project.home,
        address: '10.20.30.1',
        port: 4751,
        proxy: {
          address: '10.20.30.4',
          hostname: 'lan.example.org',
          projects: [
            { home: project.home, gatewayPort: 4751, httpsPort: 8443 },
            { home: other.home, gatewayPort: 4752, httpsPort: 8444 },
          ],
        },
      },
    }),
  )
  const host = {
    userHome: temp,
    home: project.home,
    projects: async () => [project, other, offline, unmapped],
  } as Host
  try {
    // Trust is changed only in this isolated test process, not the OS, browser or production host.
    setDefaultCACertificates([...roots, cert])
    assert.deepEqual(
      (await listProjects(host, new AbortController().signal, 'https://lan.example.org:8443')).map(
        (p) => [p.name, p.state, p.href],
      ),
      [
        ['project-a', 'ready', undefined],
        ['project-b', 'ready', 'https://lan.example.org:8444/'],
        ['project-c', 'offline', undefined],
        ['project-d', 'unpublished', undefined],
      ],
    )
    assert.equal(asks.at(-1)!.servername, 'lan.example.org')
    assert.equal(asks.at(-1)!.hostname, '10.20.30.4')
  } finally {
    setDefaultCACertificates(roots)
    for (const server of published) {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
    await rm(dir, { recursive: true, force: true })
  }
})
