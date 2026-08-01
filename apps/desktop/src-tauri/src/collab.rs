//! Collaborative-editing session registry: atomic first-wins seeding of a
//! note's shared document lineage ("epoch"), plus an opaque message relay and
//! membership announcements between windows. In-memory by design — collab
//! sessions are ephemeral, the markdown file stays the durable artifact. See
//! docs/collaborative-editing.md.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, Runtime, State};

use crate::error::{AppError, AppResult};

/// Event carrying an opaque collab message to every window.
pub const COLLAB_MESSAGE_EVENT: &str = "collab:message";
/// Event announcing an epoch's current member ids after a change.
pub const COLLAB_MEMBERS_EVENT: &str = "collab:members";

static EPOCH_COUNTER: AtomicU64 = AtomicU64::new(1);

struct Member {
    member_id: String,
    window_label: String,
}

struct Epoch {
    epoch_id: String,
    /// The canonical seed handed to joiners — the first join's candidate,
    /// frozen for the epoch's lifetime. Members ahead of it catch joiners up
    /// over the message relay (state requests); when the last member leaves
    /// the epoch dies and the next open re-seeds from the file.
    seed: Vec<u8>,
    members: Vec<Member>,
}

#[derive(Default)]
pub struct CollabState(Mutex<HashMap<String, Epoch>>);

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CollabJoinResult {
    pub epoch_id: String,
    /// Canonical seed snapshot (base64). Equals the offered candidate exactly
    /// when this join created the epoch.
    pub seed: String,
    pub created: bool,
    pub members: Vec<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct MembersPayload {
    key: String,
    epoch_id: String,
    members: Vec<String>,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CollabMessage {
    pub key: String,
    pub epoch_id: String,
    pub sender: String,
    pub kind: String,
    pub data: String,
    /// Target member id for a directed reply; `None` broadcasts.
    pub to: Option<String>,
}

fn next_epoch_id() -> String {
    // Uniqueness within the process is all lineage needs; the counter never
    // repeats and survives epoch drop/recreate for the same key.
    format!("epoch-{}", EPOCH_COUNTER.fetch_add(1, Ordering::Relaxed))
}

fn members_payload(key: &str, epoch: &Epoch) -> MembersPayload {
    MembersPayload {
        key: key.to_string(),
        epoch_id: epoch.epoch_id.clone(),
        members: epoch.members.iter().map(|m| m.member_id.clone()).collect(),
    }
}

fn lock_state<'a>(
    state: &'a State<'_, CollabState>,
) -> AppResult<std::sync::MutexGuard<'a, HashMap<String, Epoch>>> {
    state
        .0
        .lock()
        .map_err(|_| AppError::io("collab registry lock poisoned"))
}

/// Join (or create) the collab epoch for `key`. First join wins the seed;
/// later joins get the canonical seed back and must discard their candidate.
#[tauri::command]
pub fn collab_join<R: Runtime>(
    app: AppHandle<R>,
    window: tauri::Window<R>,
    state: State<'_, CollabState>,
    key: String,
    member_id: String,
    candidate_seed: String,
) -> AppResult<CollabJoinResult> {
    let candidate = BASE64
        .decode(candidate_seed.as_bytes())
        .map_err(|err| AppError::parse(format!("invalid candidate seed: {err}")))?;
    let mut epochs = lock_state(&state)?;
    let (result, payload) = match epochs.get_mut(&key) {
        Some(epoch) => {
            // Re-joining with a known member id (e.g. a retried invoke) must
            // not double-count the member.
            if !epoch.members.iter().any(|m| m.member_id == member_id) {
                epoch.members.push(Member {
                    member_id: member_id.clone(),
                    window_label: window.label().to_string(),
                });
            }
            (
                CollabJoinResult {
                    epoch_id: epoch.epoch_id.clone(),
                    seed: BASE64.encode(&epoch.seed),
                    created: false,
                    members: epoch.members.iter().map(|m| m.member_id.clone()).collect(),
                },
                members_payload(&key, epoch),
            )
        }
        None => {
            let epoch = Epoch {
                epoch_id: next_epoch_id(),
                seed: candidate,
                members: vec![Member {
                    member_id: member_id.clone(),
                    window_label: window.label().to_string(),
                }],
            };
            let result = CollabJoinResult {
                epoch_id: epoch.epoch_id.clone(),
                seed: BASE64.encode(&epoch.seed),
                created: true,
                members: vec![member_id.clone()],
            };
            let payload = members_payload(&key, &epoch);
            epochs.insert(key.clone(), epoch);
            (result, payload)
        }
    };
    // Emitted while the lock is held: announcement order must match state
    // order, or a session can settle on a stale member list forever. `emit`
    // never re-enters this state, so there is no deadlock path.
    let _ = app.emit(COLLAB_MEMBERS_EVENT, payload);
    drop(epochs);
    Ok(result)
}

/// Leave the epoch; the last member out drops it, so a later reopen re-seeds
/// from the file (which may have changed while nobody held the note).
#[tauri::command]
pub fn collab_leave<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, CollabState>,
    key: String,
    member_id: String,
) -> AppResult<()> {
    let mut epochs = lock_state(&state)?;
    let Some(epoch) = epochs.get_mut(&key) else {
        return Ok(());
    };
    epoch.members.retain(|m| m.member_id != member_id);
    if epoch.members.is_empty() {
        epochs.remove(&key);
        return Ok(());
    }
    // Under the lock, same ordering rationale as `collab_join`.
    let _ = app.emit(COLLAB_MEMBERS_EVENT, members_payload(&key, epoch));
    Ok(())
}

/// Relay an opaque collab message to every window. Messages for a dead or
/// superseded epoch are dropped — receivers additionally filter by epoch.
#[tauri::command]
pub fn collab_publish<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, CollabState>,
    message: CollabMessage,
) -> AppResult<()> {
    {
        let epochs = lock_state(&state)?;
        match epochs.get(&message.key) {
            Some(epoch) if epoch.epoch_id == message.epoch_id => {}
            _ => return Ok(()),
        }
    }
    let _ = app.emit(COLLAB_MESSAGE_EVENT, message);
    Ok(())
}

/// Drop every membership held by a destroyed window (close paths where the
/// webview's unmount effects never ran), announcing survivors per epoch.
pub fn window_destroyed<R: Runtime>(app: &AppHandle<R>, label: &str) {
    let state = app.state::<CollabState>();
    let Ok(mut epochs) = state.0.lock() else {
        return;
    };
    let mut touched: Vec<MembersPayload> = Vec::new();
    epochs.retain(|key, epoch| {
        let before = epoch.members.len();
        epoch.members.retain(|m| m.window_label != label);
        if epoch.members.len() != before && !epoch.members.is_empty() {
            touched.push(members_payload(key, epoch));
        }
        !epoch.members.is_empty()
    });
    // Under the lock, same ordering rationale as `collab_join`.
    for payload in touched {
        let _ = app.emit(COLLAB_MEMBERS_EVENT, payload);
    }
}
