import { CheckIcon } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { defineWebExtension, prettyName, ProjectChip, useAction, useSystem } from '@/sdk'
import { ProjectsAction } from './refs.ts'
import type { ProjectChoice } from './refs.ts'

const captions: Record<ProjectChoice['state'], string> = {
  ready: '',
  offline: 'Offline',
  'not-ready': 'Not ready',
  unpublished: 'Not published',
}

function ProjectMenu() {
  const system = useSystem()
  const remote = !/^(127\.0\.0\.1|localhost|\[::1\])$|\.localhost$/.test(location.hostname)
  const { data, refetch } = useAction(ProjectsAction, null, {
    enabled: remote,
    // A failed optional menu read leaves the shell's normal project chip intact.
    onError: () => {},
  })
  if (!remote || !data?.length) return <ProjectChip />
  const own = system?.project.name.toLowerCase() === 'ultimate'
  return (
    <DropdownMenu
      onOpenChange={(open) => {
        // useAction handles errors and resolves undefined, rather than rejecting.
        if (open) void refetch()
      }}
    >
      <DropdownMenuTrigger asChild>
        <ProjectChip aria-label="Switch project" menu>
          {own ? 'Ultimate' : null}
        </ProjectChip>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64 max-w-[calc(100vw-24px)]">
        <DropdownMenuLabel className="font-mono text-[10px] font-normal uppercase tracking-wider text-muted-foreground">
          Projects
        </DropdownMenuLabel>
        {data.map((project) => {
          const row = (
            <>
              <span className="w-3 shrink-0">
                {project.current && <CheckIcon className="size-3 text-brand" />}
              </span>
              <span className="min-w-0 flex-1 truncate">{prettyName(project.name)}</span>
              <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                {project.href ? `:${new URL(project.href).port}` : captions[project.state]}
              </span>
            </>
          )
          return project.href ? (
            <DropdownMenuItem asChild key={project.id}>
              <a
                aria-current={project.current ? 'page' : undefined}
                className="text-[12px]"
                href={project.href}
              >
                {row}
              </a>
            </DropdownMenuItem>
          ) : (
            <DropdownMenuItem className="text-[12px]" disabled key={project.id}>
              {row}
            </DropdownMenuItem>
          )
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export default defineWebExtension({ slots: { 'titlebar.project': ProjectMenu } })
