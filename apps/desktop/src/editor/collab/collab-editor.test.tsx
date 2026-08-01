import { createRef } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { userEvent } from 'vitest/browser'
import { render } from 'vitest-browser-react'
import { NoteEditor, type NoteEditorHandle } from '@/editor/note-editor'
import { buildCollabSeed } from './collab-seed'
import { CollabPlugin } from './collab-plugin'
import { createCollabSession, type CollabSession, type CollabSnapshot } from './collab-session'
import { createMemoryCollabHub, type MemoryCollabHub } from './memory-collab-hub'

/**
 * End-to-end collab through the real editor: two `NoteEditor`s, each
 * bound to its own session over the shared in-memory hub — exactly the shape
 * two windows have over the shell, minus the IPC. What only this suite can
 * pin: the ProseMirror↔Loro binding through meowdown (typed edits arriving in
 * the peer editor), the pause/resume divergence cycle at the editor level,
 * and undo staying local (Mod-z after a peer's edit reverts the local edit,
 * never the peer's).
 */

const KEY = 'graph\nnotes/collab.md'

interface Pane {
  session: CollabSession
  snapshots: CollabSnapshot[]
  handle: NoteEditorHandle
  screen: Awaited<ReturnType<typeof render>>
}

async function openPane(hub: MemoryCollabHub, body: string): Promise<Pane> {
  const snapshots: CollabSnapshot[] = []
  const session = createCollabSession({
    buildSeed: () => buildCollabSeed(body),
    transport: hub.transportFor(KEY),
    onSnapshot: (snapshot) => snapshots.push(snapshot),
  })
  await session.start()
  const { doc, presence, memberId } = session
  if (doc === null || presence === null) {
    throw new Error(`collab session not ready: ${JSON.stringify(session.snapshot())}`)
  }
  const ref = createRef<NoteEditorHandle>()
  const screen = await render(
    <NoteEditor initialContent={body} handleRef={ref}>
      <CollabPlugin doc={doc} presence={presence} memberId={memberId} />
    </NoteEditor>,
  )
  if (ref.current === null) {
    throw new Error('editor handle did not mount')
  }
  return { session, snapshots, handle: ref.current, screen }
}

/** The sync plugin attaches on a zero-delay timeout; give both sides a beat. */
async function converged(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 50))
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('collaborative editing through the editor', () => {
  it('carries typed edits to the peer editor and back', async () => {
    const hub = createMemoryCollabHub()
    const alpha = await openPane(hub, 'shared note')
    const beta = await openPane(hub, 'shared note')
    await converged()

    alpha.handle.setSelection('end')
    alpha.handle.insertMarkdown('plus-alpha')
    await converged()
    expect(beta.handle.getMarkdown()).toContain('plus-alpha')

    beta.handle.setSelection('start')
    beta.handle.insertMarkdown('beta-says')
    await converged()
    expect(alpha.handle.getMarkdown()).toContain('beta-says')
    expect(alpha.handle.getMarkdown()).toBe(beta.handle.getMarkdown())

    alpha.session.dispose()
    beta.session.dispose()
  })

  it('diverges while paused and merges both sides on resume', async () => {
    const hub = createMemoryCollabHub()
    const alpha = await openPane(hub, 'base')
    const beta = await openPane(hub, 'base')
    await converged()

    beta.session.setMode('paused')
    alpha.handle.setSelection('end')
    alpha.handle.insertMarkdown('alpha-live')
    beta.handle.setSelection('start')
    beta.handle.insertMarkdown('beta-offline')
    await converged()
    expect(beta.handle.getMarkdown()).not.toContain('alpha-live') // paused
    expect(alpha.handle.getMarkdown()).not.toContain('beta-offline')

    beta.session.setMode('live')
    await converged()
    const alphaText = alpha.handle.getMarkdown()
    expect(alphaText).toContain('alpha-live')
    expect(alphaText).toContain('beta-offline')
    expect(alphaText).toBe(beta.handle.getMarkdown())

    alpha.session.dispose()
    beta.session.dispose()
  })

  it('keeps undo local: Mod-z reverts my edit, never the peer’s', async () => {
    const hub = createMemoryCollabHub()
    const alpha = await openPane(hub, 'origin')
    const beta = await openPane(hub, 'origin')
    await converged()

    beta.handle.setSelection('end')
    beta.handle.insertMarkdown('beta-part')
    await converged()
    alpha.handle.setSelection('start')
    alpha.handle.insertMarkdown('alpha-part')
    await converged()
    expect(alpha.handle.getMarkdown()).toContain('alpha-part')
    expect(alpha.handle.getMarkdown()).toContain('beta-part')

    alpha.handle.focus()
    await userEvent.keyboard('{ControlOrMeta>}z{/ControlOrMeta}')
    await converged()
    const undone = alpha.handle.getMarkdown()
    expect(undone).not.toContain('alpha-part') // my edit reverted
    expect(undone).toContain('beta-part') // the peer's edit survives
    expect(undone).toBe(beta.handle.getMarkdown()) // and the undo propagated

    alpha.session.dispose()
    beta.session.dispose()
  })

  it('late joiner arrives on the evolved document, not the original seed', async () => {
    const hub = createMemoryCollabHub()
    const alpha = await openPane(hub, 'v1')
    await converged()
    alpha.handle.setSelection('end')
    alpha.handle.insertMarkdown('v2-addition')
    await converged()
    expect(alpha.handle.getMarkdown()).toContain('v2-addition') // sanity: the edit landed locally
    expect(JSON.stringify(alpha.session.doc?.toJSON())).toContain('v2-addition') // …and in Loro

    const late = await openPane(hub, 'v1') // its stale candidate must lose
    await converged()
    expect(late.handle.getMarkdown()).toContain('v2-addition')
    expect(late.handle.getMarkdown()).toBe(alpha.handle.getMarkdown())
    // The join must not have reverted the epoch: the joiner's stale initial
    // editor state stays out of the shared doc (the pre-attach export guard).
    expect(alpha.handle.getMarkdown()).toContain('v2-addition')

    alpha.session.dispose()
    late.session.dispose()
  })
})
