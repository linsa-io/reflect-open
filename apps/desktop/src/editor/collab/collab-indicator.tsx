import type { ReactElement } from 'react'
import { Pause, Play, Users } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { CollabMode } from './collab-session'

/**
 * The pane's collaboration status line: peer count and the Live/Paused
 * toggle. A solo live pane renders nothing.
 */

interface CollabIndicatorProps {
  peers: number
  mode: CollabMode
  onModeChange: (mode: CollabMode) => void
  /** Why the last resume was refused, surfaced beside the paused state. */
  note?: string | undefined
  className?: string
}

export function CollabIndicator({
  peers,
  mode,
  onModeChange,
  note,
  className,
}: CollabIndicatorProps): ReactElement | null {
  if (peers === 0 && mode === 'live') {
    return null
  }
  const paused = mode === 'paused'
  return (
    <div
      className={cn('flex items-center gap-2 text-xs text-text-muted', className)}
      role="status"
      aria-label={paused ? 'Collaboration paused' : 'Collaborating live'}
    >
      <Users aria-hidden className="size-3.5" />
      <span>
        {peers === 0
          ? 'No other panes'
          : peers === 1
            ? 'Editing with 1 other pane'
            : `Editing with ${peers} other panes`}
        {paused ? ' — paused' : ''}
        {paused && note !== undefined ? ` (${note})` : ''}
      </span>
      <Button
        variant="ghost"
        size="sm"
        className="h-6 gap-1 px-2 text-xs"
        onClick={() => onModeChange(paused ? 'live' : 'paused')}
      >
        {paused ? (
          <>
            <Play aria-hidden className="size-3" /> Resume sync
          </>
        ) : (
          <>
            <Pause aria-hidden className="size-3" /> Pause sync
          </>
        )}
      </Button>
    </div>
  )
}
