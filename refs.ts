/** Browser-safe, structurally typed Ultimate action reference; no host implementation imports. */
export interface ProjectChoice {
  id: string
  name: string
  current: boolean
  state: 'ready' | 'offline' | 'not-ready' | 'unpublished'
  href?: string
}

export const ProjectsAction: {
  extension: string
  name: string
  args?: null
  result?: ProjectChoice[]
} = { extension: 'ultimate-lan', name: 'projects' }
