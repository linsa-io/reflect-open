import { z } from 'zod'
import { getBridge, type Unlisten } from '../ipc/bridge'
import { call, voidResponseSchema } from '../ipc/invoke'

/**
 * IPC bindings for the shell's collaborative-editing registry: atomic
 * first-wins lineage seeding plus an opaque byte relay between windows.
 * Payloads are bytes-as-base64 with routing metadata; what the bytes mean
 * lives in the desktop app's collab session.
 */

/** Event the shell rebroadcasts collab messages on (every window receives it). */
export const COLLAB_MESSAGE_EVENT = 'collab:message'
/** Event announcing an epoch's member ids after a join/leave/window close. */
export const COLLAB_MEMBERS_EVENT = 'collab:members'

const collabMessageSchema = z.object({
  key: z.string(),
  epochId: z.string(),
  sender: z.string(),
  kind: z.enum(['update', 'presence', 'state-request', 'state-response']),
  /** Payload bytes, base64. For `state-request`: the requester's version vector. */
  data: z.string(),
  /** Target member id for a directed reply; null broadcasts. */
  to: z.string().nullable(),
})

/** One relayed collab message. `data` semantics depend on `kind`. */
export type CollabMessage = z.infer<typeof collabMessageSchema>

const collabMembersSchema = z.object({
  key: z.string(),
  epochId: z.string(),
  members: z.array(z.string()),
})

/** Membership announcement for one epoch. */
export type CollabMembers = z.infer<typeof collabMembersSchema>

const collabJoinResultSchema = z.object({
  epochId: z.string(),
  /** Canonical seed snapshot (base64) — the offered candidate iff `created`. */
  seed: z.string(),
  created: z.boolean(),
  members: z.array(z.string()),
})

/** The shell's answer to a join: the epoch identity and canonical seed. */
export type CollabJoinResult = z.infer<typeof collabJoinResultSchema>

/**
 * Join (or create) the collab epoch for `key`, offering `candidateSeed`
 * (base64 Loro snapshot). The first join for a key wins the seed atomically;
 * later joiners receive the canonical seed and must discard their candidate.
 */
export async function collabJoin(
  key: string,
  memberId: string,
  candidateSeed: string,
): Promise<CollabJoinResult> {
  return call('collab_join', { key, memberId, candidateSeed }, collabJoinResultSchema)
}

/** Leave the epoch; the last member out drops it. */
export async function collabLeave(key: string, memberId: string): Promise<void> {
  await call('collab_leave', { key, memberId }, voidResponseSchema)
}

/** Relay a message to every window (the shell drops dead-epoch messages). */
export async function collabPublish(message: CollabMessage): Promise<void> {
  await call('collab_publish', { message }, voidResponseSchema)
}

/**
 * Subscribe to relayed collab messages. Delivery is app-wide: handlers filter
 * by `key`/`epochId`/`to` themselves (the session owns that logic).
 */
export function subscribeCollabMessages(
  handler: (message: CollabMessage) => void,
): Promise<Unlisten> {
  return getBridge().listen(COLLAB_MESSAGE_EVENT, (payload) => {
    const parsed = collabMessageSchema.safeParse(payload)
    if (parsed.success) {
      handler(parsed.data)
    } else {
      // Contract drift between the shell and this binding — loud beats a
      // silently non-converging session.
      console.error('invalid collab:message payload:', parsed.error)
    }
  })
}

/** Subscribe to epoch membership announcements (same app-wide delivery). */
export function subscribeCollabMembers(
  handler: (members: CollabMembers) => void,
): Promise<Unlisten> {
  return getBridge().listen(COLLAB_MEMBERS_EVENT, (payload) => {
    const parsed = collabMembersSchema.safeParse(payload)
    if (parsed.success) {
      handler(parsed.data)
    } else {
      console.error('invalid collab:members payload:', parsed.error)
    }
  })
}
