import { useCallback, useEffect, useRef, useState } from 'react'
import { hasBridge } from '@reflect/core'
import type { CursorEphemeralStore, LoroDocType } from 'loro-prosemirror'
import { buildCollabSeed } from './collab-seed'
import {
  createCollabSession,
  type CollabMode,
  type CollabSession,
  type CollabSnapshot,
} from './collab-session'
import { createTauriCollabTransport } from './tauri-collab-transport'

/**
 * React adapter over {@link createCollabSession}: one session per open
 * `(key, body-at-open)`, started against the shell transport, disposed on
 * unmount. All state-machine semantics live in `collab-session.ts`.
 */

export interface CollabDocument extends CollabSnapshot {
  /** The shared doc + presence to mount `<CollabPlugin>` with; null until ready. */
  doc: LoroDocType | null
  presence: CursorEphemeralStore | null
  memberId: string | null
  /** Flip this pane between live and paused (the sync toggle). */
  setMode: (mode: CollabMode) => void
  /** Hand paused-mode ops to the epoch (the session's final-flush hook). */
  publishPending: () => void
}

interface CollabHookState extends CollabSnapshot {
  doc: LoroDocType | null
  presence: CursorEphemeralStore | null
  memberId: string | null
}

const UNAVAILABLE: CollabHookState = {
  status: 'unavailable',
  mode: 'live',
  peers: 0,
  doc: null,
  presence: null,
  memberId: null,
}

const STARTING: CollabHookState = {
  status: 'starting',
  mode: 'live',
  peers: 0,
  doc: null,
  presence: null,
  memberId: null,
}

/**
 * @param key stable identity of the note across windows (graph root + path);
 *   null disables collaboration for this pane (loading, protected, errored,
 *   browser dev without a shell).
 * @param seedBody the note body used to seed a new epoch. Read once per
 *   session start; later changes flow through the editor, not the seed.
 */
export function useCollabSession(key: string | null, seedBody: string | null): CollabDocument {
  const enabled = key !== null && seedBody !== null && hasBridge()
  const effectiveKey = enabled ? key : null

  // Keyed reset during render (not in the effect — a synchronous effect
  // setState would cascade renders): a key change flips the state back to its
  // baseline in the same render, and the effect below only *creates* the
  // session, whose snapshots then arrive asynchronously.
  const [tracked, setTracked] = useState<{ key: string | null; state: CollabHookState }>(() => ({
    key: effectiveKey,
    state: effectiveKey === null ? UNAVAILABLE : STARTING,
  }))
  if (tracked.key !== effectiveKey) {
    setTracked({ key: effectiveKey, state: effectiveKey === null ? UNAVAILABLE : STARTING })
  }

  const sessionRef = useRef<CollabSession | null>(null)
  // The seed is deliberately captured per-session, not reactive: the epoch's
  // canonical seed is decided at first join, and this pane's own copy only
  // matters until then.
  const seedRef = useRef(seedBody)
  // eslint-disable-next-line react-hooks/refs
  seedRef.current = seedBody

  useEffect(() => {
    if (effectiveKey === null) {
      return
    }
    const session: CollabSession = createCollabSession({
      buildSeed: () => buildCollabSeed(seedRef.current ?? ''),
      transport: createTauriCollabTransport(effectiveKey),
      onSnapshot: (snapshot) => {
        const state: CollabHookState = {
          ...snapshot,
          doc: session.doc,
          presence: session.presence,
          memberId: session.memberId,
        }
        // A late emit from a superseded session must not clobber the new key's
        // state — the keyed shape makes the guard a value comparison.
        setTracked((previous) =>
          previous.key === effectiveKey ? { key: effectiveKey, state } : previous,
        )
      },
    })
    sessionRef.current = session
    void session.start()
    return () => {
      // Backstop for teardown orders that skip the note session's final
      // flush; publishPending is idempotent.
      session.publishPending()
      session.dispose()
      sessionRef.current = null
    }
  }, [effectiveKey])

  const setMode = useCallback((mode: CollabMode) => {
    sessionRef.current?.setMode(mode)
  }, [])

  const publishPending = useCallback(() => {
    sessionRef.current?.publishPending()
  }, [])

  return { ...tracked.state, setMode, publishPending }
}
