/** @jsxImportSource @solidjs/web */
import { CheckIcon, ChevronDownIcon } from '@lucide/solid'
import { For, Show } from 'solid-js'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu.solid.tsx'
import { defineWebExtension, prettyName, useAction, useSystem } from '@/sdk/solid'
import { ProjectsAction } from './refs.ts'
import type { ProjectChoice } from './refs.ts'

const captions: Record<ProjectChoice['state'], string> = {
  ready: '',
  offline: 'Offline',
  'not-ready': 'Not ready',
  unpublished: 'Not published',
  'https-only': 'HTTPS only',
}

const chip =
  'flex h-7 min-w-0 shrink items-center gap-1.5 rounded-md px-2 font-sans text-[13px] font-medium text-foreground/90 font-normal transition-colors outline-none hover:bg-accent focus-visible:ring-1 focus-visible:ring-ring data-open:bg-accent'

function ProjectMenu() {
  const system = useSystem()
  // The action links projects on the page's own scheme and host, so it needs to know which base it was asked from.
  const projects = useAction(ProjectsAction, { origin: location.origin }, { onError: () => {} })
  const name = () => {
    const project = system()?.project
    if (!project) return ''
    // The core chip leaves the Ultimate project unnamed; this menu names it, as the sidebar's mark does.
    return project.name.toLowerCase() === 'ultimate' ? 'Ultimate' : prettyName(project.name)
  }
  const choices = () => projects.data() ?? []
  return (
    <Show
      when={choices().length > 0}
      fallback={
        <span class={chip} title={system()?.project.root}>
          <span class="truncate">{name()}</span>
        </span>
      }
    >
      <DropdownMenu
        modal={false}
        onAction={(id) => {
          const href = choices().find((project) => project.id === id)?.href
          if (href) location.assign(href)
        }}
        onOpenChange={(open) => {
          if (open) void projects.refetch()
        }}
      >
        <DropdownMenuTrigger aria-label="Switch project" class={chip} title={system()?.project.root}>
          <span class="truncate">{name()}</span>
          <ChevronDownIcon aria-hidden="true" class="size-3.5 shrink-0 opacity-60" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" class="w-64 max-w-[calc(100vw-24px)]">
          <DropdownMenuGroup>
            <DropdownMenuLabel class="font-mono text-[10px] font-normal uppercase tracking-wider text-muted-foreground">
              Projects
            </DropdownMenuLabel>
            <For each={choices()} keyed={(project) => project.id}>
              {(project) => (
                <DropdownMenuItem
                  class="text-[12px]"
                  disabled={!project().href && !project().current}
                  value={project().id}
                >
                  <span class="w-3 shrink-0">
                    <Show when={project().current}>
                      <CheckIcon aria-hidden="true" class="size-3 text-brand" />
                    </Show>
                  </span>
                  <span class="min-w-0 flex-1 truncate">{prettyName(project().name)}</span>
                  <span class="shrink-0 font-mono text-[10px] text-muted-foreground">
                    {project().href
                      ? `:${new URL(project().href!).port}`
                      : captions[project().state]}
                  </span>
                </DropdownMenuItem>
              )}
            </For>
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </Show>
  )
}

// A loopback page keeps the core project chip: contributing nothing leaves it in place.
const remote = !/^(127\.0\.0\.1|localhost|\[::1\])$|\.localhost$/.test(location.hostname)

export default defineWebExtension({
  slots: { 'titlebar.project': remote ? [ProjectMenu] : [] },
})
