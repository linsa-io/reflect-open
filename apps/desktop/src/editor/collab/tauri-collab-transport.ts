import {
  collabJoin,
  collabLeave,
  collabPublish,
  subscribeCollabMembers,
  subscribeCollabMessages,
  type CollabMembers,
  type CollabMessage,
} from '@reflect/core'
import { base64OfBytes, bytesOfBase64 } from '@/lib/base64'
import type { CollabTransport } from './collab-transport'

/**
 * The shell-backed {@link CollabTransport}: one instance per (pane, note
 * key), relaying through the Rust registry over base64-in-JSON IPC.
 */
export function createTauriCollabTransport(key: string): CollabTransport {
  return {
    async join(memberId, candidateSeed) {
      const result = await collabJoin(key, memberId, base64OfBytes(candidateSeed))
      return {
        epochId: result.epochId,
        seed: bytesOfBase64(result.seed),
        created: result.created,
        members: result.members,
      }
    },
    leave(memberId) {
      return collabLeave(key, memberId)
    },
    publish(message) {
      return collabPublish({
        key,
        epochId: message.epochId,
        sender: message.sender,
        kind: message.kind,
        data: base64OfBytes(message.data),
        to: message.to,
      })
    },
    onMessage(handler) {
      return subscribeCollabMessages((message: CollabMessage) => {
        if (message.key !== key) {
          return
        }
        handler({
          epochId: message.epochId,
          sender: message.sender,
          kind: message.kind,
          data: bytesOfBase64(message.data),
          to: message.to,
        })
      })
    },
    onMembers(handler) {
      return subscribeCollabMembers((members: CollabMembers) => {
        if (members.key === key) {
          handler(members.epochId, members.members)
        }
      })
    },
  }
}
