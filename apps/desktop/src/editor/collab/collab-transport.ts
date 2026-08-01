import type { CollabMessage } from '@reflect/core'

/**
 * The collab transport port. `collab-session.ts` is written against this
 * interface only; implementations: `tauri-collab-transport.ts` (the shell
 * registry), `memory-collab-hub.ts` (tests). Bytes stay `Uint8Array`.
 * Delivery contract: messages may arrive asynchronously and in any order
 * relative to `join()` resolving — never assume same-tick request/response.
 */

/** What a message's `data` bytes mean. */
export type CollabMessageKind = CollabMessage['kind']

/** One transport message, decoded. */
export interface CollabWireMessage {
  epochId: string
  sender: string
  kind: CollabMessageKind
  data: Uint8Array
  /** Target member id for a directed reply; null broadcasts. */
  to: string | null
}

/** The shell's (or hub's) answer to a join. */
export interface CollabJoinAnswer {
  epochId: string
  /** Canonical seed snapshot — the offered candidate iff `created`. */
  seed: Uint8Array
  created: boolean
  members: readonly string[]
}

export interface CollabTransport {
  /** Join (or create) the epoch for this transport's key, offering a candidate seed. */
  join(memberId: string, candidateSeed: Uint8Array): Promise<CollabJoinAnswer>
  /** Leave the epoch; the last member out drops it. */
  leave(memberId: string): Promise<void>
  /** Relay a message to every member (including other panes of this window). */
  publish(message: CollabWireMessage): Promise<void>
  /** Subscribe to relayed messages for this key (own messages included). */
  onMessage(handler: (message: CollabWireMessage) => void): Promise<() => void>
  /** Subscribe to membership announcements for this key. */
  onMembers(handler: (epochId: string, members: readonly string[]) => void): Promise<() => void>
}
