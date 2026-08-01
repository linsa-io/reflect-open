import { describe, expect, it } from 'vitest'
import { LoroDoc } from 'loro-crdt'
import { createCollabSession, type CollabSession, type CollabSnapshot } from './collab-session'
import { createMemoryCollabHub, type MemoryCollabHub } from './memory-collab-hub'

/**
 * The collab state machine over the in-memory hub, no editor and no
 * ProseMirror: convergence, the pause/resume divergence cycle, late joins,
 * and membership. The tests drive the shared doc through a plain root text
 * container — the session relays bytes and never inspects the doc's shape,
 * so the editor-tree structure is irrelevant here (the browser suite covers
 * it end to end).
 */

const KEY = 'graph\nnotes/a.md'

function seedWith(text: string): Uint8Array {
  const doc = new LoroDoc()
  doc.getText('body').insert(0, text)
  doc.commit()
  return doc.export({ mode: 'snapshot' })
}

function textOf(session: CollabSession): string {
  return session.doc?.getText('body').toString() ?? ''
}

function edit(session: CollabSession, at: number, insert: string): void {
  const doc = session.doc
  if (doc === null) {
    throw new Error('session has no doc')
  }
  doc.getText('body').insert(at, insert)
  doc.commit()
}

interface Member {
  session: CollabSession
  snapshots: CollabSnapshot[]
}

async function join(hub: MemoryCollabHub, seed = 'hello'): Promise<Member> {
  const snapshots: CollabSnapshot[] = []
  const session = createCollabSession({
    buildSeed: () => seedWith(seed),
    transport: hub.transportFor(KEY),
    onSnapshot: (snapshot) => snapshots.push(snapshot),
  })
  await session.start()
  return { session, snapshots }
}

/** Local-update subscriptions flush on commit, synchronously in loro-crdt; a
 * microtask beat still keeps the tests honest about promise-based relays. */
async function tick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 15))
}

describe('createCollabSession', () => {
  it('converges live edits both ways', async () => {
    const hub = createMemoryCollabHub()
    const alpha = await join(hub)
    const beta = await join(hub)

    edit(alpha.session, 5, ' from alpha')
    await tick()
    expect(textOf(beta.session)).toBe('hello from alpha')

    edit(beta.session, 0, 'well, ')
    await tick()
    expect(textOf(alpha.session)).toBe('well, hello from alpha')
    expect(textOf(alpha.session)).toBe(textOf(beta.session))

    alpha.session.dispose()
    beta.session.dispose()
  })

  it('gives every member identical lineage regardless of who seeded', async () => {
    const hub = createMemoryCollabHub()
    // Different candidate seeds: only the first may win; the second must
    // adopt the canonical bytes, not merge its own candidate in.
    const alpha = await join(hub, 'alpha version')
    const beta = await join(hub, 'beta version')

    expect(textOf(alpha.session)).toBe('alpha version')
    expect(textOf(beta.session)).toBe('alpha version')

    alpha.session.dispose()
    beta.session.dispose()
  })

  it('pauses into deliberate divergence and merges on resume', async () => {
    const hub = createMemoryCollabHub()
    const alpha = await join(hub)
    const beta = await join(hub)

    beta.session.setMode('paused')
    edit(alpha.session, 5, ' alpha-only')
    edit(beta.session, 0, 'beta-only ')
    await tick()
    expect(textOf(alpha.session)).toBe('hello alpha-only') // beta muted
    expect(textOf(beta.session)).toBe('beta-only hello') // alpha not imported

    beta.session.setMode('live')
    await tick()
    expect(textOf(alpha.session)).toBe(textOf(beta.session))
    expect(textOf(alpha.session)).toContain('alpha-only')
    expect(textOf(alpha.session)).toContain('beta-only')

    alpha.session.dispose()
    beta.session.dispose()
  })

  it('catches a late joiner up from a surviving peer after the seeder left', async () => {
    const hub = createMemoryCollabHub()
    const alpha = await join(hub)
    const beta = await join(hub)
    edit(alpha.session, 5, ' final state')
    await tick()
    alpha.session.dispose() // the seeder (and author) is gone

    const late = await join(hub)
    await tick()
    // The epoch's canonical seed is frozen at creation; only beta's state
    // response can carry alpha's edit to the joiner.
    expect(textOf(late.session)).toBe('hello final state')

    beta.session.dispose()
    late.session.dispose()
  })

  it('pause leaves the epoch and resume rejoins it', async () => {
    const hub = createMemoryCollabHub()
    const alpha = await join(hub)
    const beta = await join(hub)
    await tick()
    expect(alpha.snapshots.at(-1)?.peers).toBe(1)

    beta.session.setMode('paused')
    await tick()
    // A paused pane can neither serve catch-up nor accept updates, so it
    // must not count as (or freeze the state visible to) a member.
    expect(alpha.snapshots.at(-1)?.peers).toBe(0)

    beta.session.setMode('live')
    await tick()
    expect(alpha.snapshots.at(-1)?.peers).toBe(1)
    expect(beta.snapshots.at(-1)?.peers).toBe(1)

    alpha.session.dispose()
    beta.session.dispose()
  })

  it('refuses to resume into a stranger epoch, keeping the local doc intact', async () => {
    const hub = createMemoryCollabHub()
    const alpha = await join(hub)
    const beta = await join(hub)
    beta.session.setMode('paused')
    edit(beta.session, 5, ' beta-kept')
    alpha.session.dispose() // last member out — the epoch dies
    await tick()

    const stranger = await join(hub, 'unrelated lineage') // fresh epoch, fresh history
    beta.session.setMode('live')
    await tick()

    // Importing unrelated lineage would duplicate content in both docs;
    // the resume must refuse and fall back to paused instead.
    expect(beta.session.snapshot().mode).toBe('paused')
    expect(beta.session.snapshot().unavailableReason).toContain('reopened elsewhere')
    expect(textOf(beta.session)).toBe('hello beta-kept')
    expect(textOf(stranger.session)).toBe('unrelated lineage')

    beta.session.dispose()
    stranger.session.dispose()
  })

  it('hands a closing paused pane’s ops to the survivors', async () => {
    const hub = createMemoryCollabHub()
    const alpha = await join(hub)
    const beta = await join(hub)

    beta.session.setMode('paused')
    edit(beta.session, 0, 'parting gift: ')
    beta.session.publishPending()
    beta.session.dispose()
    await tick()

    expect(textOf(alpha.session)).toBe('parting gift: hello')
    alpha.session.dispose()
  })

  it('never leaks a paused pane’s ops through state responses', async () => {
    const hub = createMemoryCollabHub()
    const alpha = await join(hub)
    const beta = await join(hub)
    beta.session.setMode('paused')
    edit(beta.session, 0, 'secret ')

    const late = await join(hub)
    await tick()
    expect(textOf(late.session)).toBe('hello') // beta answered nothing

    alpha.session.dispose()
    beta.session.dispose()
    late.session.dispose()
  })
})
