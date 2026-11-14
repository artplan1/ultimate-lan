import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer } from 'node:https'
import { getCACertificates, setDefaultCACertificates } from 'node:tls'
import type { AddressInfo } from 'node:net'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { listProjects, probeProject } from '../projects.ts'
import type { Host } from '../lan.ts'
import type { Project, Proxy, Target } from '../config.ts'

test('readiness verifies real TLS trust, authority and bounded SSE identity; menu distinguishes offline/unpublished', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'ultimate-lan-tls-test-'))
  const roots = getCACertificates()
  const certPath = join(temp, 'fixture.crt')
  const keyPath = join(temp, 'fixture.key')
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
  let mode:
    | 'valid'
    | 'wrong-home'
    | 'wrong-root'
    | 'wrong-upstream'
    | 'missing-origin'
    | 'oversized'
    | 'invalid-json'
    | 'wrong-content' = 'valid'
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
  const server = createServer({ cert, key }, (request, response) => {
    assert.equal(request.url, '/api/events')
    assert.equal(request.headers.host, `lan.example.org:${(server.address() as AddressInfo).port}`)
    response.writeHead(200, {
      'content-type': mode === 'wrong-content' ? 'text/plain' : 'text/event-stream',
    })
    response.write('retry: 500\n\n')
    const system = {
      project: { root: mode === 'wrong-root' ? '/workspace/other' : project.root },
      process: { url: mode === 'wrong-upstream' ? 'http://127.0.0.1:9999' : project.running!.url },
      persistence: {
        path:
          (mode === 'wrong-home' ? '/other-home' : project.home) + '/chapters/example/state.sqlite',
      },
      access: {
        origins:
          mode === 'missing-origin'
            ? []
            : [`https://lan.example.org:${(server.address() as AddressInfo).port}`],
      },
    }
    if (mode === 'oversized') response.write('x'.repeat(512 * 1024 + 1))
    else
      response.write(
        'event: system\ndata: ' + (mode === 'invalid-json' ? '{' : JSON.stringify(system)) + '\n\n',
      )
    // Keep the response open: a successful probe must close it rather than waiting for SSE to end.
  })
  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const target: Target = {
      home: project.home,
      gatewayPort: 4751,
      httpsPort: (server.address() as AddressInfo).port,
    }
    const proxy: Proxy = { address: '127.0.0.1', hostname: 'lan.example.org', projects: [target] }
    const signal = new AbortController().signal
    assert.equal(
      await probeProject(proxy, target, project, signal),
      false,
      'an untrusted certificate must not become ready',
    )
    // Trust is changed only in this isolated test process, not the OS, browser or production host.
    setDefaultCACertificates([...roots, cert])
    assert.equal(await probeProject(proxy, target, project, signal), true)
    assert.equal(
      await probeProject({ ...proxy, hostname: 'wrong.example.org' }, target, project, signal),
      false,
      'a wrong certificate hostname must fail',
    )
    for (const failure of [
      'wrong-home',
      'wrong-root',
      'wrong-upstream',
      'missing-origin',
      'oversized',
      'invalid-json',
      'wrong-content',
    ] as const) {
      mode = failure
      assert.equal(await probeProject(proxy, target, project, signal), false, failure)
    }
    mode = 'valid'
    const cancelled = new AbortController()
    cancelled.abort()
    assert.equal(await probeProject(proxy, target, project, cancelled.signal), false)

    const offline: Project = {
      name: 'project-b',
      root: '/workspace/project-b',
      home: homeFor('/workspace/project-b'),
      current: false,
    }
    const unpublished: Project = {
      name: 'project-c',
      root: '/workspace/project-c',
      home: homeFor('/workspace/project-c'),
      current: false,
      running: { pid: process.pid, url: 'http://127.0.0.1:4792' },
    }
    const preview = { ...project, name: 'preview', home: project.home + '/preview', current: false }
    await mkdir(join(temp, '.ultimate'), { recursive: true })
    // An already-aborted list read proves that a live mapped process is Not ready, without a real network wait.
    await writeFile(
      join(temp, '.ultimate/settings.json'),
      JSON.stringify({
        lan: {
          home: project.home,
          address: '10.20.30.1',
          port: 4751,
          proxy: { ...proxy, address: '10.20.30.4' },
        },
      }),
    )
    const host = {
      userHome: temp,
      home: project.home,
      projects: async () => [project, offline, unpublished, preview],
    } as Host
    const choices = await listProjects(host, cancelled.signal)
    assert.deepEqual(
      choices.map((p) => [p.name, p.state, p.href]),
      [
        ['project-a', 'not-ready', undefined],
        ['project-b', 'offline', undefined],
        ['project-c', 'unpublished', undefined],
      ],
    )
  } finally {
    setDefaultCACertificates(roots)
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await rm(temp, { recursive: true, force: true })
  }
})
