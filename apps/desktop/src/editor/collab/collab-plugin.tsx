import { useMemo, type ReactElement } from 'react'
import { defineLoro } from '@prosekit/extensions/loro'
import type { CursorEphemeralStore, LoroDocType } from 'loro-prosemirror'
import { useExtension } from '@meowdown/react'
import { isMainWindow } from '@/lib/windows/window-role'
import '@prosekit/extensions/loro/style.css'

/**
 * Mounts the Loro collaboration extension into the surrounding editor, as a
 * `<NoteEditor>` child inside meowdown's ProseKit context. `defineLoro`
 * composes the sync plugin, collab-aware undo (never reverts a peer's edit),
 * and the remote-caret plugin. The doc must already hold the canonical seed
 * when this mounts — the sync plugin treats it as authoritative at attach.
 */

interface CollabPluginProps {
  doc: LoroDocType
  presence: CursorEphemeralStore
  /** This pane's session member id — the caret identity peers see. */
  memberId: string
}

export interface CollabCursorUser {
  name: string
  color: string
}

export function CollabPlugin({ doc, presence, memberId }: CollabPluginProps): ReactElement | null {
  const extension = useMemo(
    () => defineLoro({ doc, presence, cursor: { user: cursorUserFor(memberId) } }),
    [doc, presence, memberId],
  )
  useExtension(extension)
  return null
}

/**
 * Caret identity for a member id: the window role as the display name and a
 * stable color hashed from the id. A networked adopter replaces this with
 * real user identity through the same shape.
 */
export function cursorUserFor(memberId: string): CollabCursorUser {
  let hash = 0
  for (let index = 0; index < memberId.length; index += 1) {
    hash = (hash * 31 + memberId.charCodeAt(index)) | 0
  }
  const hue = ((hash % 360) + 360) % 360
  return {
    name: isMainWindow() ? 'Main window' : 'Note window',
    color: `hsl(${hue} 70% 45%)`,
  }
}
