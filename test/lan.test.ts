import assert from 'node:assert/strict'
import { test, mock } from 'node:test'
import * as http from 'node:http'
import { connect, type AddressInfo } from 'node:net'
import { once } from 'node:events'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Host } from '../lan.ts'
import type { Config, Project } from '../config.ts'

const clone = process.env.ULTIMATE_ROOT
if (!clone) throw new Error('Set ULTIMATE_ROOT to the existing Ultimate checkout')
const { admit } = await import(pathToFileURL(join(clone, 'server/request-security.ts')).href)
let gateway: http.Server
let peer = '10.20.30.2'
let failListen = false
let requestedBind: unknown[]
let created = 0
let beforeRead: (() => Promise<void>) | undefined
mock.module('node:fs/promises', {
  exports: {
    readFile: async (...args: Parameters<typeof readFile>) => {
      await beforeRead?.()
      return readFile(...args)
    },
  },
})
// Real HTTP streams, but every requested private bind is replaced by an ephemeral loopback bind.
mock.module('node:http', {
  exports: {
    request: http.request,
    createServer: (handler: http.RequestListener) => {
      created++
      const server = http.createServer((request, response) => {
        Object.defineProperty(request.socket, 'remoteAddress', { value: peer, configurable: true })
        handler(request, response)
      })
      const listen = server.listen.bind(server)
      server.listen = ((port: number, address: string, callback: () => void) => {
        requestedBind = [port, address]
        if (failListen) {
          queueMicrotask(() =>
            server.emit('error', Object.assign(new Error('occupied'), { code: 'EADDRINUSE' })),
          )
          return server
        }
        return listen(0, '127.0.0.1', callback)
      }) as typeof server.listen
      gateway = server
      return server
    },
  },
})
const { installLan } = await import('../lan.ts')
const { ordinary } = await import('../config.ts')

async function fixture(proxyOnly = false) {
  peer = '10.20.30.2'
  failListen = false
  const userHome = await mkdtemp(join(tmpdir(), 'ultimate-lan-test-'))
  const root = '/workspace/project-a'
  const home = join(
    userHome,
    '.ultimate/projects',
    'project-a-' + createHash('sha256').update(root).digest('hex').slice(0, 8),
  )
  const config: Config = {
    home: proxyOnly ? '/another-owner' : home,
    address: '10.20.30.1',
    port: 4751,
  }
  if (proxyOnly)
    config.proxy = {
      address: '10.20.30.4',
      hostname: 'lan.example.org',
      projects: [{ home, gatewayPort: 4752, httpsPort: 8444 }],
    }
  await mkdir(join(userHome, '.ultimate'))
  const settings = (lan: unknown) =>
    writeFile(join(userHome, '.ultimate/settings.json'), JSON.stringify({ lan }))
  await settings(config)
  const rules = new Set<Parameters<Host['access']['allow']>[0]>()
  const seen: http.IncomingHttpHeaders[] = []
  const upstream = http.createServer(async (request, response) => {
    seen.push(request.headers)
    if (!(await admit(request, '4750', rules))) {
      response.writeHead(403).end()
      return
    }
    if (request.url === '/events') {
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write('data: first\n\n')
      return
    }
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(chunk)
    response
      .writeHead(201)
      .end(request.method + ':' + request.url + ':' + Buffer.concat(chunks).toString('hex'))
  })
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`
  const project: Project = {
    name: 'project-a',
    home,
    root,
    current: true,
    running: { pid: process.pid, url },
  }
  let open!: () => Promise<void>
  let release!: () => Promise<void>
  let close!: () => Promise<void>
  const host: Host = {
    home,
    userHome,
    projectRoot: root,
    projects: async () => [project],
    system: () => ({ process: { url } }),
    access: {
      allow: (rule) => {
        rules.add(rule)
        return () => {
          rules.delete(rule)
        }
      },
    },
    onOpen: (callback) => {
      open = callback
    },
    onRelease: (callback) => {
      release = callback
    },
    onClose: (callback) => {
      close = callback
    },
  }
  installLan(host)
  const wire = (options: http.RequestOptions = {}, body?: Buffer) =>
    new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port: (gateway.address() as AddressInfo).port,
          ...options,
          headers: {
            host: proxyOnly ? 'lan.example.org:8444' : '10.20.30.1:4751',
            ...options.headers,
          },
          agent: false,
        },
        (response) => {
          let body = ''
          response.on('data', (chunk) => {
            body += chunk
          })
          response.on('end', () => resolve({ status: response.statusCode!, body }))
        },
      )
      req.on('error', reject)
      req.end(body)
    })
  return {
    config,
    settings,
    rules,
    seen,
    host,
    project,
    open,
    release,
    close,
    wire,
    dispose: async () => {
      await close()
      upstream.closeAllConnections()
      await new Promise<void>((resolve) => upstream.close(() => resolve()))
      await rm(userHome, { recursive: true, force: true })
    },
  }
}

test('existing direct HTTP, streaming, core admission and lifecycle remain functional', async () => {
  const f = await fixture()
  try {
    await f.open()
    assert.deepEqual(requestedBind, [4751, '10.20.30.1'])
    assert.equal((gateway.address() as AddressInfo).address, '127.0.0.1')
    assert.deepEqual(
      await f.wire(
        {
          method: 'POST',
          path: '/api/action?q=1',
          headers: { origin: 'http://10.20.30.1:4751', 'sec-fetch-site': 'same-origin' },
        },
        Buffer.from([0, 255, 13, 10]),
      ),
      { status: 201, body: 'POST:/api/action?q=1:00ff0d0a' },
    )
    for (const address of ['10.20.31.2', '::1', '::ffff:10.20.30.2']) {
      peer = address
      assert.equal((await f.wire()).status, 403)
    }
    peer = '10.20.30.2'
    assert.equal((await f.wire({ headers: { host: 'localhost:4750' } })).status, 403)
    assert.equal((await f.wire({ headers: { connection: 'origin' } })).status, 400)
    for (const path of [
      '/',
      '/assets/app.js',
      '/api/models',
      '/api/events',
      '/api/extensions/x/actions/y',
    ]) {
      assert.equal((await f.wire({ path, headers: { origin: 'http://evil.invalid' } })).status, 403)
      assert.equal(
        (await f.wire({ path, headers: { 'sec-fetch-site': 'cross-site' } })).status,
        403,
      )
    }
    assert.equal(
      (
        await f.wire({
          path: '/?conversation=1',
          headers: {
            'sec-fetch-site': 'cross-site',
            'sec-fetch-mode': 'navigate',
            'sec-fetch-dest': 'document',
          },
        })
      ).status,
      201,
    )
    const stream = await new Promise<http.IncomingMessage>((resolve, reject) => {
      const req = http.get(
        {
          hostname: '127.0.0.1',
          port: (gateway.address() as AddressInfo).port,
          path: '/events',
          headers: { host: '10.20.30.1:4751' },
          agent: false,
        },
        resolve,
      )
      req.on('error', reject)
    })
    assert.equal(
      await new Promise<string>((resolve) =>
        stream.once('data', (value) => resolve(value.toString())),
      ),
      'data: first\n\n',
    )
    const raw = []
    for (const partial of [false, true]) {
      const accepted = once(gateway, 'connection')
      const socket = connect((gateway.address() as AddressInfo).port, '127.0.0.1')
      const [acceptedSocket] = await accepted
      // Forced release may reset an incomplete request; both sockets must still close.
      socket.on('error', (error: NodeJS.ErrnoException) => assert.equal(error.code, 'ECONNRESET'))
      raw.push(new Promise<void>((resolve) => socket.once('close', () => resolve())))
      if (partial) {
        const received = once(acceptedSocket, 'data')
        socket.write('GET /events HTTP/1.1\r\n')
        await received
      }
    }
    const ended = new Promise<void>((resolve) => stream.once('close', resolve))
    stream.on('error', () => {
      /* Expected: release terminates the open SSE response. */
    })
    await f.release()
    await ended
    await Promise.all(raw)
    assert.equal(f.rules.size, 0)
    assert.equal(gateway.listening, false)
    await f.release()
    await f.close()
    await f.open()
    assert.equal((await f.wire()).status, 201)
    f.host.system = () => ({ process: { url: 'http://127.0.0.1:1' } })
    await f.release()
    await f.open()
    assert.equal((await f.wire()).status, 502)
  } finally {
    await f.dispose()
  }
})

test('HTTPS ingress requires the real proxy peer and exact public authority; no direct HTTP for other projects', async () => {
  const f = await fixture(true)
  try {
    await f.open()
    assert.deepEqual(requestedBind, [4752, '10.20.30.1'])
    assert.deepEqual(
      [...f.rules].map((rule) => rule.origin),
      ['https://lan.example.org:8444'],
    )
    assert.equal((await f.wire({ headers: { 'x-forwarded-for': '10.20.30.4' } })).status, 403)
    peer = '10.20.30.4'
    for (const host of ['lan.example.org:8443', '10.20.30.1:4752', 'localhost:4750'])
      assert.equal((await f.wire({ headers: { host } })).status, 403)
    assert.equal(
      (await f.wire({ headers: { origin: 'https://lan.example.org:8443' } })).status,
      403,
    )
    assert.equal(
      (
        await f.wire({
          headers: {
            origin: 'https://lan.example.org:8444',
            'sec-fetch-site': 'same-origin',
            'tailscale-user-login': 'forged',
            tailscale_user_login: 'forged',
            forwarded: 'for=127.0.0.1',
            'x-forwarded-host': 'localhost',
            'x-ultimate-lan-token': 'forged',
          },
        })
      ).status,
      201,
    )
    const headers = f.seen.at(-1)!
    assert.equal(headers['tailscale-user-login'], undefined)
    assert.equal(headers.tailscale_user_login, undefined)
    assert.equal(headers.forwarded, undefined)
    assert.equal(headers['x-forwarded-host'], undefined)
    assert.equal(headers['x-forwarded-for'], '10.20.30.4')
    assert.notEqual(headers['x-ultimate-lan-token'], 'forged')
    assert.equal(
      [...f.rules][0].verify({ headers: { 'x-ultimate-lan-token': 'forged' } }),
      undefined,
    )
  } finally {
    await f.dispose()
  }
})

test('owner retains HTTP while also admitting its exact proxy HTTPS origin', async () => {
  const f = await fixture()
  try {
    f.config.proxy = {
      address: '10.20.30.4',
      hostname: 'lan.example.org',
      projects: [{ home: f.host.home, gatewayPort: 4751, httpsPort: 8443 }],
    }
    await f.settings(f.config)
    await f.open()
    assert.equal(f.rules.size, 2)
    assert.equal((await f.wire()).status, 201)
    peer = '10.20.30.4'
    assert.equal(
      (
        await f.wire({
          headers: { host: 'lan.example.org:8443', origin: 'https://lan.example.org:8443' },
        })
      ).status,
      201,
    )
  } finally {
    await f.dispose()
  }
})

test('settings/mapping errors, preview homes and occupied binds fail closed', async () => {
  const f = await fixture(true)
  try {
    for (const address of ['0.0.0.0', '127.0.0.1', '::', '198.51.100.2']) {
      await f.settings({ ...f.config, address })
      await assert.rejects(f.open(), /specific private IPv4/)
    }
    await f.settings({
      ...f.config,
      proxy: {
        ...f.config.proxy,
        projects: [f.config.proxy!.projects[0], f.config.proxy!.projects[0]],
      },
    })
    await assert.rejects(f.open(), /must be unique/)
    await f.settings(f.config)
    const ordinaryHome = f.host.home
    f.host.home += '/preview'
    f.config.proxy!.projects[0]!.home = f.host.home
    await f.settings(f.config)
    await f.open()
    assert.equal(f.rules.size, 0)
    f.host.home = ordinaryHome
    f.config.proxy!.projects[0]!.home = ordinaryHome
    await f.settings(f.config)
    failListen = true
    await assert.rejects(f.open(), /Cannot open LAN gateway/)
    assert.equal(f.rules.size, 0)
    assert.equal(gateway.listening, false)
    const worktreeRoot = '/workspace/.ultimate/projects/main-12345678/worktrees/42'
    assert.equal(
      ordinary(
        {
          root: worktreeRoot,
          home: join(
            f.host.userHome,
            '.ultimate/projects',
            '42-' + createHash('sha256').update(worktreeRoot).digest('hex').slice(0, 8),
          ),
        },
        f.host.userHome,
      ),
      false,
    )
  } finally {
    await f.dispose()
  }
})

test('release and unload cancel an opener awaiting settings', async () => {
  const f = await fixture()
  try {
    for (const stop of [f.release, f.close]) {
      let reading!: () => void
      let resume!: () => void
      const started = new Promise<void>((resolve) => {
        reading = resolve
      })
      const held = new Promise<void>((resolve) => {
        resume = resolve
      })
      beforeRead = async () => {
        reading()
        await held
      }
      const previous = created
      const opening = f.open()
      await started
      const stopping = stop()
      resume()
      await Promise.all([opening, stopping])
      assert.equal(created, previous)
      assert.equal(f.rules.size, 0)
      beforeRead = undefined
    }
    await f.open()
    assert.equal((await f.wire()).status, 201)
  } finally {
    beforeRead = undefined
    await f.dispose()
  }
})
