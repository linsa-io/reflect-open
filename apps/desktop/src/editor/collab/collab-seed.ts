import { markdownToDoc } from '@meowdown/core'
import { EditorState } from '@prosekit/pm/state'
import type { Schema } from '@prosekit/pm/model'
import { updateLoroToPmState, type LoroDocType } from 'loro-prosemirror'
import { newCollabDoc } from './collab-doc'

/**
 * Build a candidate Loro seed for a note body: markdown → ProseMirror tree →
 * snapshot. Every pane offers one on join; the registry keeps the first and
 * everyone imports the canonical bytes. `LoroSyncPlugin` treats the doc as
 * authoritative at attach (an empty doc *empties* the editor), so seeding
 * must precede mounting.
 */
export function buildCollabSeed(body: string): Uint8Array {
  const node = markdownToDoc(body)
  const doc = newCollabDoc()
  configureTextStyles(doc, node.type.schema)
  updateLoroToPmState(doc, new Map(), EditorState.create({ doc: node }))
  return doc.export({ mode: 'snapshot' })
}

/**
 * Mirror of loro-prosemirror's internal `configLoroTextStyle` (not exported):
 * every schema mark becomes a configured text style. Replicated **verbatim**
 * (an explicitly-truthy `inclusive` expands, anything else — including PM's
 * implicit default — does not): the seeding `mark()` calls must behave
 * identically to what the plugin configures at attach, or seeded and live
 * marks would grow differently at their boundaries.
 */
export function configureTextStyles(doc: LoroDocType, schema: Schema): void {
  doc.configTextStyle(
    Object.fromEntries(
      Object.entries(schema.marks).map(([markName, markType]) => [
        markName,
        { expand: markType.spec.inclusive ? 'after' : 'none' },
      ]),
    ),
  )
}
