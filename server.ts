import { defineExtension } from '@earendil-works/pi-durable'
import { installLan } from './lan.ts'
import type { Host } from './lan.ts'
import { listProjects } from './projects.ts'

export const reloadOnSettings = true
export const pollActions = ['projects']

export const actions = {
  projects: (_args: unknown, { host, signal }: { host: Host; signal: AbortSignal }) =>
    listProjects(host, signal),
}

export default function lan(host: Host) {
  installLan(host)
  return defineExtension({ name: 'ultimate-lan' })
}
