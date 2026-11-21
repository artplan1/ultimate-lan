/** Browser-safe, structurally typed Ultimate action reference; no host implementation imports. */
export interface ProjectChoice {
  id: string
  name: string
  current: boolean
  /** `https-only`: running and published through the proxy, which the page's plaintext base cannot reach. */
  state: 'ready' | 'offline' | 'not-ready' | 'unpublished' | 'https-only'
  href?: string
}

export const ProjectsAction: {
  extension: string
  name: string
  args?: { origin: string }
  result?: ProjectChoice[]
} = { extension: 'ultimate-lan', name: 'projects' }
