import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { vi } from 'vitest'
import {
  createNoteSession,
  type NoteSessionCollabState,
  type NoteSessionSnapshot,
} from './note-session'

/**
 * The session-level collab contracts, no React and no CRDT: how the
 * save pipeline and external-change reconciliation behave when the pane
 * reports a paused or shared collab state. The solo paths stay pinned by
 * `note-session.test.ts` — everything here is behavior that only exists with
 * a `collabState` probe installed.
 */

interface Harness {
  snapshots: NoteSessionSnapshot[]
  writes: string[]
  applied: string[]
  setDisk: (contents: string) => void
  setCollab: (state: NoteSessionCollabState) => void
  session: ReturnType<typeof createNoteSession>
}

function harness(options?: {
  initialDisk?: string
  onBeforeFinalFlush?: () => void
  onWrite?: () => void
}): Harness {
  const snapshots: NoteSessionSnapshot[] = []
  const writes: string[] = []
  const applied: string[] = []
  let disk = options?.initialDisk ?? '# Hello\n'
  let collab: NoteSessionCollabState = { paused: false, sharedFile: false }
  const session = createNoteSession({
    path: 'notes/a.md',
    io: {
      read: async () => disk,
      write: async (_path, contents) => {
        options?.onWrite?.()
        writes.push(contents)
        disk = contents
      },
    },
    classify: () => 'exact',
    onSnapshot: (snapshot) => snapshots.push(snapshot),
    applyContent: (markdown) => applied.push(markdown),
    collabState: () => collab,
    onBeforeFinalFlush: options?.onBeforeFinalFlush,
    saveDebounceMs: 10,
  })
  return {
    snapshots,
    writes,
    applied,
    setDisk: (contents) => {
      disk = contents
    },
    setCollab: (state) => {
      collab = state
    },
    session,
  }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

async function settled(): Promise<void> {
  await vi.advanceTimersByTimeAsync(1000)
}

describe('collab equality adoption', () => {
  it('adopts an external change equal to the buffer without touching the editor', async () => {
    const { session, setDisk, applied, snapshots, writes } = harness()
    session.load()
    await settled()

    session.editorChanged('# Converged\n')
    // Another pane's save lands the same converged content before ours does.
    setDisk('# Converged\n')
    session.externalChanged()
    await vi.advanceTimersByTimeAsync(1)

    const last = snapshots.at(-1)
    expect(last?.dirty).toBe(false)
    expect(last?.conflict).toBeNull()
    expect(applied).toEqual([]) // identical content never re-enters the editor
    // Adopted as clean: the debounced save has nothing left to write.
    await settled()
    expect(writes).toEqual([])
  })

  it('clears a parked conflict whose content has converged', async () => {
    const { session, setDisk, snapshots } = harness()
    session.load()
    await settled()

    session.editorChanged('# Mine\n')
    setDisk('# Theirs\n')
    session.externalChanged()
    await vi.advanceTimersByTimeAsync(1)
    expect(snapshots.at(-1)?.conflict).toBe('# Theirs\n')

    // The divergence resolves out-of-band (e.g. the other side adopted ours).
    setDisk('# Mine\n')
    session.externalChanged()
    await vi.advanceTimersByTimeAsync(1)
    expect(snapshots.at(-1)?.conflict).toBeNull()
    expect(snapshots.at(-1)?.dirty).toBe(false)
  })
})

describe('paused collab', () => {
  it('suspends saves while paused — including plain flushes — and resumes after', async () => {
    const { session, setCollab, writes } = harness()
    session.load()
    await settled()

    setCollab({ paused: true, sharedFile: false })
    session.editorChanged('# Paused edit\n')
    await session.flush() // a blur flush must not write a paused buffer either
    await settled()
    expect(writes).toEqual([]) // disk belongs to the live peers

    setCollab({ paused: false, sharedFile: false })
    void session.flush() // the pane's resume nudge
    await settled()
    expect(writes).toEqual(['# Paused edit\n'])
  })

  it('neither applies nor parks external changes while paused', async () => {
    const { session, setCollab, setDisk, applied, snapshots } = harness()
    session.load()
    await settled()

    setCollab({ paused: true, sharedFile: false })
    session.editorChanged('# Diverged locally\n')
    setDisk('# Peers converged elsewhere\n')
    session.externalChanged()
    await settled()

    expect(applied).toEqual([]) // peers' content must not smuggle in as local ops
    expect(snapshots.at(-1)?.conflict).toBeNull() // the divergence is deliberate
  })

  it('still lands the buffer on the teardown flush', async () => {
    const { session, setCollab, writes } = harness()
    session.load()
    await settled()

    setCollab({ paused: true, sharedFile: false })
    session.editorChanged('# Closing while paused\n')
    session.dispose()
    await settled()

    expect(writes).toEqual(['# Closing while paused\n'])
  })

  it('lands a paused buffer on a quit-style final flush, after the publish hook', async () => {
    const order: string[] = []
    const { session, setCollab, writes } = harness({
      onBeforeFinalFlush: () => order.push('publish'),
      onWrite: () => order.push('write'),
    })
    session.load()
    await settled()

    setCollab({ paused: true, sharedFile: false })
    session.editorChanged('# Typed while paused\n')
    // The quit path never disposes (unmount effects don't run there) — the
    // registry's final flush is the only write this buffer will ever get,
    // and the collab publish hook must fire before the write dispatches.
    await session.flush({ final: true })
    expect(writes).toEqual(['# Typed while paused\n'])
    expect(order).toEqual(['publish', 'write'])
  })

  it('parks external content seen while paused instead of overwriting it', async () => {
    const { session, setCollab, setDisk, writes, snapshots } = harness()
    session.load()
    await settled()

    setCollab({ paused: true, sharedFile: false })
    session.editorChanged('# Paused divergence\n')
    setDisk('# Precious external edit\n')
    session.externalChanged()
    await settled()
    expect(writes).toEqual([]) // remembered, not clobbered

    // Un-pause and try to persist: the remembered external content must be
    // settled first — a dirty buffer parks it rather than writing over it.
    setCollab({ paused: false, sharedFile: false })
    await session.flush()
    expect(writes).toEqual([])
    expect(snapshots.at(-1)?.conflict).toBe('# Precious external edit\n')
  })

  it('even a closing paused pane cannot overwrite unseen external content', async () => {
    const { session, setCollab, setDisk, writes } = harness()
    session.load()
    await settled()

    setCollab({ paused: true, sharedFile: false })
    session.editorChanged('# Paused divergence\n')
    setDisk('# Precious external edit\n')
    session.externalChanged()
    await settled()

    session.dispose() // final flush — but the external side wins at teardown
    await settled()
    expect(writes).toEqual([])
  })

  it('refuses frontmatter commits while saves are held', async () => {
    const { session, setCollab } = harness()
    session.load()
    await settled()

    setCollab({ paused: true, sharedFile: false })
    await expect(session.commitFrontmatter({ pinned: true })).resolves.toBe(false)
  })
})

describe('shared-file reconciliation', () => {
  it('defers a mismatch and adopts once the peer save converges', async () => {
    const { session, setCollab, setDisk, snapshots } = harness()
    session.load()
    await settled()

    setCollab({ paused: false, sharedFile: true })
    session.editorChanged('# Converging\n')
    // The peer's save of a *previous* state lands first — a legitimate lag.
    setDisk('# Stale intermediate\n')
    session.externalChanged()
    await vi.advanceTimersByTimeAsync(1)
    expect(snapshots.at(-1)?.conflict).toBeNull() // no premature park

    // By the re-check, the peer has written the converged content.
    setDisk('# Converging\n')
    await vi.advanceTimersByTimeAsync(500)
    expect(snapshots.at(-1)?.conflict).toBeNull()
    expect(snapshots.at(-1)?.dirty).toBe(false)
  })

  it('parks a mismatch that survives the re-check against an unchanged buffer', async () => {
    const { session, setCollab, setDisk, snapshots } = harness()
    session.load()
    await settled()

    setCollab({ paused: false, sharedFile: true })
    session.editorChanged('# Mine\n')
    setDisk('# A true external edit\n')
    session.externalChanged()
    await vi.advanceTimersByTimeAsync(1)
    expect(snapshots.at(-1)?.conflict).toBeNull()

    await vi.advanceTimersByTimeAsync(500)
    expect(snapshots.at(-1)?.conflict).toBe('# A true external edit\n')
  })

  it('a moving buffer cannot postpone the verdict forever', async () => {
    const { session, setCollab, setDisk, snapshots, writes } = harness()
    session.load()
    await settled()

    setCollab({ paused: false, sharedFile: true })
    session.editorChanged('# Mine v0\n')
    setDisk('# External\n')
    session.externalChanged()
    // Keep the buffer moving through every recheck window: without the
    // defer bound, autosave would stay suspended and no conflict would ever
    // surface for as long as typing continues.
    for (let round = 1; round <= 6; round += 1) {
      await vi.advanceTimersByTimeAsync(200)
      session.editorChanged(`# Mine v${round}\n`)
      await vi.advanceTimersByTimeAsync(250)
    }
    expect(snapshots.at(-1)?.conflict).toBe('# External\n') // bounded → parked
    expect(writes).toEqual([]) // and the held saves never clobbered it
  })

  it('holds even a final flush while a mismatch is under investigation', async () => {
    const { session, setCollab, setDisk, writes } = harness()
    session.load()
    await settled()

    setCollab({ paused: false, sharedFile: true })
    session.editorChanged('# Mine\n')
    setDisk('# External, possibly precious\n')
    session.externalChanged()
    await vi.advanceTimersByTimeAsync(1)
    // Quit lands inside the recheck window: the external side wins, exactly
    // like a parked conflict — the write must NOT go through.
    await session.flush({ final: true })
    expect(writes).toEqual([])
  })

  it('keepMine during a re-check wins and stays resolved', async () => {
    const { session, setCollab, setDisk, snapshots, writes } = harness()
    session.load()
    await settled()

    setCollab({ paused: false, sharedFile: true })
    session.editorChanged('# Mine\n')
    setDisk('# External\n')
    session.externalChanged()
    await vi.advanceTimersByTimeAsync(500)
    expect(snapshots.at(-1)?.conflict).toBe('# External\n') // parked

    // A second external event re-opens the investigation while parked…
    setDisk('# External v2\n')
    session.externalChanged()
    await vi.advanceTimersByTimeAsync(1)
    // …and the user resolves it mid-window. The verdict must stick: the
    // buffer is written, and the stale re-check must not re-park.
    session.keepMine()
    await settled()
    expect(writes).toEqual(['# Mine\n'])
    expect(snapshots.at(-1)?.conflict).toBeNull()
    expect(snapshots.at(-1)?.dirty).toBe(false)
  })
})
