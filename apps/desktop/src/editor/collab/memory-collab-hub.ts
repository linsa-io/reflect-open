import type { CollabTransport, CollabWireMessage } from './collab-transport'

/**
 * In-memory stand-in for the shell registry + event relay (tests).
 * Semantics mirror `collab.rs`: first join wins the seed, the last leave
 * drops the epoch, broadcast delivery including the sender — and delivery is
 * deliberately asynchronous (a microtask hop), matching the Tauri event bus.
 * No window-destroyed analogue; tests dispose sessions explicitly.
 */
export interface MemoryCollabHub {
  transportFor(key: string): CollabTransport
}

interface MemoryEpoch {
  epochId: string
  seed: Uint8Array
  members: Set<string>
}

export function createMemoryCollabHub(): MemoryCollabHub {
  const epochs = new Map<string, MemoryEpoch>()
  const messageHandlers = new Map<string, Set<(message: CollabWireMessage) => void>>()
  const memberHandlers = new Map<
    string,
    Set<(epochId: string, members: readonly string[]) => void>
  >()
  let nextEpoch = 1

  function announce(key: string, epoch: MemoryEpoch): void {
    const members = [...epoch.members]
    const epochId = epoch.epochId
    queueMicrotask(() => {
      for (const handler of [...(memberHandlers.get(key) ?? [])]) {
        handler(epochId, members)
      }
    })
  }

  return {
    transportFor(key) {
      return {
        join(memberId, candidateSeed) {
          let epoch = epochs.get(key)
          const created = epoch === undefined
          if (epoch === undefined) {
            epoch = { epochId: `epoch-${nextEpoch++}`, seed: candidateSeed, members: new Set() }
            epochs.set(key, epoch)
          }
          epoch.members.add(memberId)
          announce(key, epoch)
          return Promise.resolve({
            epochId: epoch.epochId,
            seed: epoch.seed,
            created,
            members: [...epoch.members],
          })
        },
        leave(memberId) {
          const epoch = epochs.get(key)
          if (epoch !== undefined) {
            epoch.members.delete(memberId)
            if (epoch.members.size === 0) {
              epochs.delete(key)
            } else {
              announce(key, epoch)
            }
          }
          return Promise.resolve()
        },
        publish(message) {
          const epoch = epochs.get(key)
          if (epoch === undefined || epoch.epochId !== message.epochId) {
            return Promise.resolve()
          }
          queueMicrotask(() => {
            for (const handler of [...(messageHandlers.get(key) ?? [])]) {
              handler(message)
            }
          })
          return Promise.resolve()
        },
        onMessage(handler) {
          let handlers = messageHandlers.get(key)
          if (handlers === undefined) {
            handlers = new Set()
            messageHandlers.set(key, handlers)
          }
          handlers.add(handler)
          return Promise.resolve(() => {
            messageHandlers.get(key)?.delete(handler)
          })
        },
        onMembers(handler) {
          let handlers = memberHandlers.get(key)
          if (handlers === undefined) {
            handlers = new Set()
            memberHandlers.set(key, handlers)
          }
          handlers.add(handler)
          return Promise.resolve(() => {
            memberHandlers.get(key)?.delete(handler)
          })
        },
      }
    },
  }
}
