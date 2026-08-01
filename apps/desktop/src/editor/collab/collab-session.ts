import { VersionVector } from 'loro-crdt'
import { CursorEphemeralStore, type LoroDocType } from 'loro-prosemirror'
import { newCollabDoc } from './collab-doc'
import type { CollabTransport, CollabWireMessage } from './collab-transport'

/**
 * One pane's collaborative session for one note: the shared `LoroDoc` the
 * editor binds to, the presence store behind remote carets, and the
 * Live/Paused state machine. Framework-free — transport and seed are
 * injected; `use-collab-session.ts` binds it to React. Protocol semantics:
 * docs/collaborative-editing.md.
 */

export type CollabStatus = 'starting' | 'ready' | 'unavailable' | 'disposed'
export type CollabMode = 'live' | 'paused'

export interface CollabSnapshot {
  status: CollabStatus
  mode: CollabMode
  /** Other members in the epoch (this session excluded). */
  peers: number
  /**
   * Why the session is `unavailable` (or a resume was refused). Environments
   * without the shell registry land here by design, so this is diagnostic
   * state, not an error channel — nothing is logged.
   */
  unavailableReason?: string
}

export interface CollabSessionOptions {
  /** Builds the candidate seed snapshot; called once, at `start()`. */
  buildSeed: () => Uint8Array
  transport: CollabTransport
  onSnapshot: (snapshot: CollabSnapshot) => void
  /** Overrides the join timeout (tests). */
  joinTimeoutMs?: number
}

export interface CollabSession {
  /** The shared doc, for the editor binding. Null until `ready`. */
  readonly doc: LoroDocType | null
  /** The presence store behind remote carets. Null until `ready`. */
  readonly presence: CursorEphemeralStore | null
  readonly memberId: string
  snapshot(): CollabSnapshot
  start(): Promise<void>
  setMode(mode: CollabMode): void
  /**
   * Hand paused-mode ops to the epoch before the pane's final file write, so
   * survivors merge them instead of adopting a divergent file. Idempotent.
   */
  publishPending(): void
  dispose(): void
}

/** A wedged registry must degrade to solo editing, not a hung pane. */
const DEFAULT_JOIN_TIMEOUT_MS = 3000
/** Remote cursors outlive a keystroke gap but not a closed pane. */
const PRESENCE_TIMEOUT_MS = 30_000

let nextMemberOrdinal = 1

/** Unique within the process; readable in logs and the shell's member lists. */
function mintMemberId(): string {
  const entropy = Math.random().toString(36).slice(2, 8)
  return `member-${nextMemberOrdinal++}-${entropy}`
}

export function createCollabSession(options: CollabSessionOptions): CollabSession {
  const { transport, buildSeed, onSnapshot } = options
  const joinTimeoutMs = options.joinTimeoutMs ?? DEFAULT_JOIN_TIMEOUT_MS
  const memberId = mintMemberId()

  let status: CollabStatus = 'starting'
  let mode: CollabMode = 'live'
  let peers = 0
  let unavailableReason: string | undefined
  let doc: LoroDocType | null = null
  let presence: CursorEphemeralStore | null = null
  let epochId: string | null = null
  /** The doc's version when the session paused — resume exports from here. */
  let pausedFrom: VersionVector | null = null
  /** True while a resume's rejoin is in flight (mode stays `paused` until it settles). */
  let resuming = false
  const teardowns: Array<() => void> = []
  /** Latest membership announced while the join was in flight (snapshots — only the last matters). */
  let pendingMembers: { epochId: string; members: readonly string[] } | null = null

  function emit(): void {
    if (status === 'disposed') {
      return
    }
    onSnapshot(snapshot())
  }

  function snapshot(): CollabSnapshot {
    return {
      status,
      mode,
      peers,
      ...(unavailableReason !== undefined ? { unavailableReason } : {}),
    }
  }

  function publish(kind: CollabWireMessage['kind'], data: Uint8Array, to: string | null): void {
    if (epochId === null) {
      return
    }
    void transport.publish({ epochId, sender: memberId, kind, data, to }).catch((cause) => {
      console.error('collab publish failed:', cause) // the next catch-up repairs the gap
    })
  }

  function applyMembers(incomingEpoch: string, members: readonly string[]): void {
    if (incomingEpoch !== epochId) {
      return
    }
    peers = Math.max(0, members.filter((member) => member !== memberId).length)
    emit()
  }

  function handleMessage(message: CollabWireMessage): void {
    // Pre-ready messages are simply dropped: the post-ready catch-up pulls
    // everything missed via the version-vector export.
    if (
      status !== 'ready' ||
      doc === null ||
      presence === null ||
      message.epochId !== epochId ||
      message.sender === memberId ||
      (message.to !== null && message.to !== memberId)
    ) {
      return
    }
    switch (message.kind) {
      case 'update':
      case 'state-response': {
        if (mode === 'live') {
          try {
            doc.import(message.data)
          } catch (cause) {
            // Malformed peer bytes must not kill the delivery listener.
            console.error('collab update import failed:', cause)
          }
        }
        break
      }
      case 'presence': {
        if (mode === 'live') {
          try {
            presence.apply(message.data)
          } catch (cause) {
            console.error('collab presence apply failed:', cause)
          }
        }
        break
      }
      case 'state-request': {
        // Only while live: a paused doc holds unshared ops that must not leak.
        if (mode === 'live') {
          try {
            const from = VersionVector.decode(message.data)
            publish('state-response', doc.export({ mode: 'update', from }), message.sender)
            // Directed presence push so the joiner sees cursors immediately.
            publish('presence', presence.encodeAll(), message.sender)
          } catch (cause) {
            console.error('collab state request failed:', cause)
          }
        }
        break
      }
    }
  }

  /** Ask peers for everything beyond this doc's version. */
  function requestCatchUp(): void {
    if (doc === null || status !== 'ready' || mode !== 'live') {
      return
    }
    publish('state-request', doc.version().encode(), null)
  }

  function joinWithTimeout(
    candidate: Uint8Array,
  ): Promise<Awaited<ReturnType<CollabTransport['join']>>> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`collab join timed out after ${joinTimeoutMs}ms`))
      }, joinTimeoutMs)
      transport.join(memberId, candidate).then(
        (answer) => {
          clearTimeout(timer)
          resolve(answer)
        },
        (cause: unknown) => {
          clearTimeout(timer)
          reject(cause instanceof Error ? cause : new Error(String(cause)))
        },
      )
    })
  }

  async function start(): Promise<void> {
    try {
      const offMessages = await transport.onMessage(handleMessage)
      if (isDisposed()) {
        offMessages()
        return
      }
      teardowns.push(offMessages)
      const offMembers = await transport.onMembers((incomingEpoch, members) => {
        // An announcement racing the join is remembered (snapshots — only the
        // latest matters), or `peers` could stick at its join-time value.
        if (epochId === null) {
          pendingMembers = { epochId: incomingEpoch, members }
          return
        }
        applyMembers(incomingEpoch, members)
      })
      if (isDisposed()) {
        offMembers()
        return
      }
      teardowns.push(offMembers)
      const joined = await joinWithTimeout(buildSeed())
      if (isDisposed()) {
        void transport.leave(memberId).catch(() => {})
        return
      }
      epochId = joined.epochId
      // Import the canonical seed into a fresh doc even when our candidate
      // won, so every member's lineage is byte-identical.
      const freshDoc = newCollabDoc()
      freshDoc.import(joined.seed)
      doc = freshDoc
      presence = new CursorEphemeralStore(freshDoc.peerIdStr, PRESENCE_TIMEOUT_MS)
      teardowns.push(
        freshDoc.subscribeLocalUpdates((bytes) => {
          if (status === 'ready' && mode === 'live') {
            publish('update', bytes, null)
          }
        }),
      )
      teardowns.push(
        presence.subscribeLocalUpdates((bytes) => {
          if (status === 'ready' && mode === 'live') {
            publish('presence', bytes, null)
          }
        }),
      )
      peers = Math.max(0, joined.members.filter((member) => member !== memberId).length)
      status = 'ready'
      if (pendingMembers !== null) {
        applyMembers(pendingMembers.epochId, pendingMembers.members)
        pendingMembers = null
      }
      // Live peers may be ahead of the epoch's frozen seed.
      requestCatchUp()
      emit()
    } catch (cause) {
      // Expected without a shell registry (browser dev, test fakes) or on a
      // join timeout: the pane edits solo. Not logged — routine, not an error.
      if (!isDisposed()) {
        status = 'unavailable'
        unavailableReason = cause instanceof Error ? cause.message : String(cause)
        pendingMembers = null
        // A timed-out join may still have registered the membership.
        void transport.leave(memberId).catch(() => {})
        emit()
      }
    }
  }

  function isDisposed(): boolean {
    return status === 'disposed'
  }

  function setMode(next: CollabMode): void {
    if (status !== 'ready' || next === mode) {
      return
    }
    if (next === 'paused') {
      mode = 'paused'
      pausedFrom = doc?.version() ?? null
      // Membership implies serving catch-up, which a paused pane refuses.
      // `epochId` stays cached for `publishPending`.
      peers = 0
      void transport.leave(memberId).catch(() => {})
      emit()
      return
    }
    // Mode flips to `live` only once the rejoin settles: reporting live
    // during the join would open the save gate while the outcome (merge or
    // refusal) is still unknown.
    if (!resuming) {
      resuming = true
      void resumeRejoin()
    }
  }

  async function resumeRejoin(): Promise<void> {
    const current = doc
    if (current === null) {
      resuming = false
      return
    }
    const previousEpoch = epochId
    try {
      const joined = await joinWithTimeout(current.export({ mode: 'snapshot' }))
      if (isDisposed()) {
        void transport.leave(memberId).catch(() => {})
        return
      }
      if (!joined.created && joined.epochId !== previousEpoch) {
        // The epoch died and was re-seeded from disk while we were paused:
        // unrelated lineage, whose import would duplicate content. Refuse and
        // stay paused; the file-level conflict flow arbitrates.
        unavailableReason = 'resume refused: the note was reopened elsewhere while sync was off'
        void transport.leave(memberId).catch(() => {})
        emit()
        return
      }
      epochId = joined.epochId
      if (!joined.created) {
        // Shared lineage: this import is a merge, not a replacement.
        try {
          current.import(joined.seed)
        } catch (cause) {
          console.error('collab resume import failed:', cause)
        }
      }
      peers = Math.max(0, joined.members.filter((member) => member !== memberId).length)
      mode = 'live'
      unavailableReason = undefined
      // Replay our divergence first, then ask for theirs.
      if (pausedFrom !== null) {
        publish('update', current.export({ mode: 'update', from: pausedFrom }), null)
      }
      pausedFrom = null
      requestCatchUp()
      emit()
    } catch (cause) {
      if (!isDisposed()) {
        // Registry unreachable — stay paused so the toggle is honest. A
        // timed-out join may still have registered the membership.
        unavailableReason = cause instanceof Error ? cause.message : String(cause)
        void transport.leave(memberId).catch(() => {})
        emit()
      }
    } finally {
      resuming = false
    }
  }

  function publishPending(): void {
    if (status !== 'ready' || mode !== 'paused' || doc === null || pausedFrom === null) {
      return
    }
    publish('update', doc.export({ mode: 'update', from: pausedFrom }), null)
  }

  function dispose(): void {
    if (status === 'disposed') {
      return
    }
    const joinedOrJoining = epochId !== null || status === 'starting'
    status = 'disposed'
    for (const teardown of teardowns.splice(0)) {
      teardown()
    }
    presence?.destroy()
    if (joinedOrJoining) {
      void transport.leave(memberId).catch(() => {})
    }
  }

  return {
    get doc() {
      return doc
    },
    get presence() {
      return presence
    },
    memberId,
    snapshot,
    start,
    setMode,
    publishPending,
    dispose,
  }
}
