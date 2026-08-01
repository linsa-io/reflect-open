import {
  appendBlock,
  editTaskLine,
  errorMessage,
  isAppError,
  removeTaskLine,
  taskLineToBullet,
  toggleTaskMarker,
  upsertFrontmatter,
  type TaskMarker,
} from '@reflect/core'
import { splitDoc } from './note-session-doc'
import { frontmatterPatchToYaml, type FrontmatterPatch } from './note-session-frontmatter'
import type {
  NoteSession,
  NoteSessionCollabState,
  NoteSessionOptions,
  NoteSessionSnapshot,
  NoteSessionStatus,
} from './note-session-types'

const DEFAULT_SAVE_DEBOUNCE_MS = 800
/** How long a collab-shared mismatch may lag before it counts as external. */
const COLLAB_RECHECK_MS = 400
/** A moving buffer earns extra beats, but the verdict can't defer forever. */
const MAX_RECHECK_DEFERS = 3

const SOLO_COLLAB: NoteSessionCollabState = { paused: false, sharedFile: false }

/** Create the document session for one note. See note-session.ts for semantics. */
export function createNoteSession(options: NoteSessionOptions): NoteSession {
  const { io, classify, onSnapshot, applyContent, onContent, reconcilePendingEditorInput } = options
  const collab = options.collabState ?? ((): NoteSessionCollabState => SOLO_COLLAB)
  const onBeforeFinalFlush = options.onBeforeFinalFlush
  /** Mutable: a rename retargets the session in place (Plan 17). */
  let path = options.path
  const createIfMissing = options.createIfMissing ?? false
  const missingSeed = options.missingSeed
  const saveDebounceMs = options.saveDebounceMs ?? DEFAULT_SAVE_DEBOUNCE_MS

  // Snapshot state (surfaces via onSnapshot).
  let status: NoteSessionStatus = 'loading'
  let initialContent = ''
  let isProtected = false
  let dirty = false
  let missing = false
  let conflict: string | null = null
  let error: string | null = null

  // Pipeline state (never surfaces).
  /** The **body** as of the last editor change (the editor never sees frontmatter). */
  let buffer = ''
  /** The exact frontmatter bytes (with delimiters), `''` when none. */
  let header = ''
  /** The full content most recently read from or written to disk. */
  let disk = ''
  let saveTimer: ReturnType<typeof setTimeout> | null = null
  /** Pending collab-shared reconcile re-check timer (see `scheduleCollabRecheck`). */
  let recheckTimer: ReturnType<typeof setTimeout> | null = null
  /**
   * True from mismatch-under-investigation until its verdict — spanning the
   * async re-read, not just the timer, so no save can slip into the gap.
   * Conflict-like: blocks even final flushes.
   */
  let recheckPending = false
  /** Invalidates in-flight re-checks when the user resolves the mismatch. */
  let recheckGeneration = 0
  /** Consecutive re-defers; a moving buffer can't postpone the verdict forever. */
  let recheckAttempts = 0
  /** External content seen while paused — settled before the next write. */
  let pausedExternal: string | null = null
  /** Serializes writes so a flush can't interleave with a debounced save. */
  let saveChain: Promise<void> = Promise.resolve()
  /**
   * Content of the write currently in flight (set when dispatched, before the
   * write resolves). The watcher event for our own save can arrive before the
   * write settles and `disk` updates — matching against this prevents a false
   * conflict when the user kept typing during the save.
   */
  let inFlightWrite: string | null = null
  /** True while we push external content into the editor via `applyContent`. */
  let applyingContent = false
  /** True while the initial `load()` read is in flight. */
  let loading = false
  /** A watcher event arrived during the load; replay reconciliation after it. */
  let missedChange = false
  let disposed = false
  // Set by `discard` — tells `dispose` to skip its flush (the file is being
  // deleted, so rewriting it would recreate it).
  let discarded = false

  let lastEmitted: NoteSessionSnapshot | null = null

  function emit(): void {
    if (disposed) {
      return
    }
    const next: NoteSessionSnapshot = {
      status,
      initialContent,
      protected: isProtected,
      dirty,
      missing,
      conflict,
      error,
    }
    if (
      lastEmitted !== null &&
      lastEmitted.status === next.status &&
      lastEmitted.initialContent === next.initialContent &&
      lastEmitted.protected === next.protected &&
      lastEmitted.dirty === next.dirty &&
      lastEmitted.missing === next.missing &&
      lastEmitted.conflict === next.conflict &&
      lastEmitted.error === next.error
    ) {
      return
    }
    lastEmitted = next
    onSnapshot(next)
  }

  /**
   * Discarded sessions never write (the file is being deleted); a parked
   * conflict and a pending re-check hold saves (writing would clobber the
   * external side before the user/verdict decides); a collab-paused pane
   * holds them too (disk belongs to the live peers). A **final** flush
   * (teardown, quit, note move) overrides the pause gate only.
   */
  function saveBlocked(final: boolean): boolean {
    return (
      discarded ||
      !dirty ||
      isProtected ||
      conflict !== null ||
      recheckPending ||
      (collab().paused && !final)
    )
  }

  function save(final = false): void {
    if (pausedExternal !== null && (final || !collab().paused)) {
      settlePausedExternal()
    }
    if (io.write === null || saveBlocked(final)) {
      return
    }
    const write = io.write
    saveChain = saveChain
      .then(async () => {
        // Re-check at execution time and take the freshest buffer — a queued
        // step can run behind a slow prior write, during which the user may
        // have reverted or kept typing, paused sync, or the session may have
        // been discarded for a delete. (After dispose the buffer is frozen,
        // so this same step doubles as the final flush.)
        if (saveBlocked(final)) {
          return
        }
        const content = header + buffer
        inFlightWrite = content
        try {
          await write(path, content)
          disk = content
          dirty = header + buffer !== content
          missing = false // the landed write created the file if it was missing
          error = null // a previous save failure is resolved by this success
          emit()
          onContent?.(content, 'saved')
        } finally {
          inFlightWrite = null
        }
      })
      .catch((cause) => {
        console.error('failed to save note:', cause)
        error = errorMessage(cause)
        emit()
      })
  }

  function scheduleSave(): void {
    if (collab().paused) {
      return // resuming (or the teardown flush) restarts persistence
    }
    if (saveTimer !== null) {
      clearTimeout(saveTimer)
    }
    saveTimer = setTimeout(() => {
      saveTimer = null
      save()
    }, saveDebounceMs)
  }

  function cancelScheduledSave(): void {
    if (saveTimer !== null) {
      clearTimeout(saveTimer)
      saveTimer = null
    }
  }

  function flush(options?: { final?: boolean }): Promise<void> {
    const final = options?.final ?? false
    reconcilePendingEditorInput?.()
    cancelScheduledSave()
    if (final) {
      // Unshared collab ops must reach the epoch before the buffer reaches
      // disk, so peers merge instead of adopting a divergent file.
      onBeforeFinalFlush?.()
    }
    save(final)
    // save() extended the chain synchronously (or left it settled when there
    // was nothing to do) — the chain as of now is exactly this flush's write.
    return saveChain
  }

  function editorChanged(markdown: string): void {
    if (applyingContent) {
      // This change is our own applyContent pushing disk content, not a user
      // edit. The editor's serialization may normalize (trailing newline, loose
      // lists) and differ from the disk bytes — that must not dirty the buffer
      // or schedule a save, or a reload would rewrite a file the user never
      // touched. Track the serialized form; dirtiness resumes with the next
      // real edit.
      buffer = markdown
      return
    }
    buffer = markdown
    dirty = header + markdown !== disk
    if (missing && markdown.trim() === '') {
      // A still-unwritten note cleared back to nothing (e.g. the seeded
      // empty-title template deleted wholesale) stays unwritten: creating an
      // empty file would break the lazy no-litter contract. Dirtiness — and
      // the file's birth — resume with the next real content.
      dirty = false
    }
    emit()
    if (dirty) {
      scheduleSave()
    }
  }

  /** Apply external content to the live editor without entering the save path. */
  function applyToEditor(content: string): void {
    applyingContent = true
    try {
      // The editor dispatches synchronously, so its change handler runs (and is
      // suppressed) within this call.
      applyContent(content)
    } finally {
      applyingContent = false
    }
  }

  /** Adopt `content` as the new clean document state, re-gating protection. */
  function adoptCleanContent(content: string): void {
    pausedExternal = null
    const doc = splitDoc(content)
    header = doc.header
    buffer = doc.body
    disk = content
    dirty = false
    missing = false // external content means the file exists on disk now
    // Re-gate: the content may have introduced (or removed) syntax the editor
    // can't round-trip. When protection flips the pane remounts via
    // initialContent; otherwise reload the live editor in place.
    const lossy = classify(doc.body) === 'lossy'
    const flipped = lossy !== isProtected
    isProtected = lossy
    initialContent = lossy ? content : doc.body
    emit()
    // While protected there is no live editor mounted (the pane shows the
    // read-only view), and lossy content must never enter one regardless.
    if (!flipped && !lossy) {
      applyToEditor(doc.body)
    }
    onContent?.(content, 'external')
  }

  /**
   * External content equal to the live document byte-for-byte (typically a
   * peer's save of converged content): adopt the bookkeeping silently —
   * applying identical content would re-enter the collab doc as a spurious
   * whole-document op — and clear a park whose disagreement no longer exists.
   */
  function adoptEqualContent(content: string): void {
    cancelScheduledSave()
    cancelRecheck()
    pausedExternal = null
    disk = content
    dirty = false
    missing = false
    conflict = null
    emit()
    onContent?.(content, 'external')
  }

  /** Resolve any pending re-check: verdict delivered or superseded. */
  function cancelRecheck(): void {
    recheckGeneration += 1
    recheckPending = false
    recheckAttempts = 0
    if (recheckTimer !== null) {
      clearTimeout(recheckTimer)
      recheckTimer = null
    }
  }

  /**
   * Re-read the note and reconcile the buffer with what's on disk (the
   * external-change path).
   */
  async function reconcileFromDisk(): Promise<void> {
    let content: string
    try {
      content = await io.read(path)
    } catch {
      return // deleted/unreadable between event and read; nothing to reconcile
    }
    if (disposed) {
      return
    }
    if (content === disk || content === inFlightWrite) {
      // Nothing to reconcile (stale, or an echo of our own possibly
      // still-settling save) — but a successful read of a previously-missing
      // note means the file exists now (e.g. another device wrote the seed
      // verbatim), so record that transition before skipping.
      if (missing) {
        missing = false
        emit()
      }
      return
    }
    if (content === header + buffer) {
      adoptEqualContent(content)
      return
    }
    const collabState = collab()
    if (collabState.paused) {
      // The divergence is deliberate: applying disk would smuggle peers'
      // edits in as local ops, and parking would cry wolf. Remember the
      // content instead — it must be settled before this pane writes again,
      // or a genuinely-external change dies under the stale buffer.
      pausedExternal = content
      return
    }
    pausedExternal = null
    if (dirty) {
      if (collabState.sharedFile) {
        // Live collab: disk legitimately lags the converged buffer by a save
        // debounce, so give convergence one beat before treating the
        // mismatch as a real external edit.
        scheduleCollabRecheck()
        return
      }
      // Never clobber unsaved edits — park the external content and pause the
      // save pipeline (cancel any pending debounce) until the user chooses; a
      // save landing now would overwrite "theirs" first.
      cancelScheduledSave()
      conflict = content
      emit()
      return
    }
    adoptCleanContent(content)
  }

  /**
   * The deferred second look for a collab-shared mismatch. Equality adopts;
   * a moving buffer re-defers a bounded number of times; a mismatch that
   * survives parks like the solo path. A user resolution bumps the
   * generation so the stale continuation drops itself; one timer collapses
   * repeated watcher events.
   */
  function scheduleCollabRecheck(): void {
    // Before the collapse guard: an armed timer already implies an
    // investigation, and the save gate must hold for its whole span.
    recheckPending = true
    if (recheckTimer !== null) {
      return
    }
    const bufferAtDefer = buffer
    const generation = recheckGeneration
    // The debounce timer would only fire into the held gate and get lost.
    cancelScheduledSave()
    recheckTimer = setTimeout(() => {
      recheckTimer = null
      void (async () => {
        let content: string | null
        try {
          content = await io.read(path)
        } catch {
          content = null
        }
        if (disposed || generation !== recheckGeneration) {
          return
        }
        if (content === null || content === disk || content === inFlightWrite) {
          resolveRecheckClean()
          return
        }
        if (content === header + buffer) {
          adoptEqualContent(content)
          return
        }
        if (collab().paused) {
          pausedExternal = content // settled before the next write
          resolveRecheckClean()
          return
        }
        if (!dirty) {
          cancelRecheck()
          adoptCleanContent(content)
          return
        }
        if (buffer !== bufferAtDefer && recheckAttempts < MAX_RECHECK_DEFERS) {
          recheckAttempts += 1
          recheckPending = false
          scheduleCollabRecheck()
          return
        }
        cancelRecheck()
        cancelScheduledSave()
        conflict = content
        emit()
      })()
    }, COLLAB_RECHECK_MS)
  }

  /** The investigated mismatch evaporated — release held saves. */
  function resolveRecheckClean(): void {
    cancelRecheck()
    if (dirty && conflict === null && !collab().paused) {
      scheduleSave()
    }
  }

  /**
   * Settle external content that arrived while paused, before any write:
   * equal content adopts, a clean buffer reloads, a dirty one parks — never
   * a silent overwrite.
   */
  function settlePausedExternal(): void {
    const external = pausedExternal
    pausedExternal = null
    if (external === null || external === disk) {
      return
    }
    if (external === header + buffer) {
      adoptEqualContent(external)
      return
    }
    if (!dirty) {
      adoptCleanContent(external)
      return
    }
    cancelScheduledSave()
    conflict = external
    emit()
  }

  /** The initial read; with `createIfMissing`, a missing file is an empty note. */
  async function readInitial(): Promise<{ content: string; fileMissing: boolean }> {
    try {
      return { content: await io.read(path), fileMissing: false }
    } catch (cause) {
      if (createIfMissing && isAppError(cause) && cause.kind === 'notFound') {
        return { content: '', fileMissing: true } // lazy note: created by the first save
      }
      throw cause
    }
  }

  function load(): void {
    loading = true
    missedChange = false
    status = 'loading'
    conflict = null
    error = null
    emit()
    void (async () => {
      try {
        const { content, fileMissing } = await readInitial()
        if (disposed) {
          return
        }
        // A missing note adopts the seed as its clean baseline: the editor
        // shows the template, but disk-comparison sees no difference, so
        // nothing is written until a real edit (the lazy no-litter contract).
        const adopted = fileMissing && missingSeed !== undefined ? missingSeed : content
        const doc = splitDoc(adopted)
        header = doc.header
        buffer = doc.body
        disk = adopted
        dirty = false
        missing = fileMissing
        // The data-loss gate: a note the editor can't reproduce opens read-only.
        isProtected = classify(doc.body) === 'lossy'
        initialContent = isProtected ? adopted : doc.body
        status = 'ready'
        emit()
        // The real disk content, not the seed: the rename tracker must
        // baseline untitled so the first authored title is a birth.
        onContent?.(content, 'load')
      } catch (cause) {
        if (!disposed) {
          error = errorMessage(cause)
          status = 'error'
          emit()
        }
      } finally {
        if (!disposed) {
          loading = false
          // A change event during the load was deferred (reconciling mid-load
          // could be overwritten by this load's older read committing later);
          // replay it now against the committed state.
          if (missedChange) {
            missedChange = false
            void reconcileFromDisk()
          }
        }
      }
    })()
  }

  function externalChanged(): void {
    if (disposed) {
      return
    }
    if (loading) {
      missedChange = true // deferred; replayed when the load commits
      return
    }
    void reconcileFromDisk()
  }

  function keepMine(): void {
    // The user's verdict supersedes any in-flight re-check, which would
    // otherwise re-park the conflict and swallow this write.
    cancelRecheck()
    conflict = null
    dirty = true // force the rewrite even if content drifted equal
    emit()
    save(true)
  }

  function loadTheirs(): void {
    if (conflict === null) {
      return
    }
    cancelRecheck() // same verdict-supersedes-investigation rule as keepMine
    const content = conflict
    conflict = null
    // Same re-gating as the clean-reload path: never load lossy content into a
    // live editor whose next save would drop what it can't model.
    adoptCleanContent(content)
  }

  function updateFrontmatter(patch: FrontmatterPatch): boolean {
    if (disposed || isProtected || status !== 'ready') {
      return false
    }
    header = splitDoc(upsertFrontmatter(header + buffer, frontmatterPatchToYaml(patch))).header
    dirty = header + buffer !== disk
    emit()
    if (dirty) {
      scheduleSave()
    }
    return true
  }

  async function commitFrontmatter(patch: FrontmatterPatch): Promise<boolean> {
    // No write channel (no graph generation yet) means the patch can't land —
    // say so, rather than riding `updateFrontmatter`'s in-memory success while
    // `save()` silently no-ops. A `true` here would let publish/pin/private
    // skip their disk fallback and treat an unwritten flag as persisted.
    // Held saves (collab pause, pending re-check) refuse for the same reason.
    if (io.write === null || collab().paused || recheckPending) {
      return false
    }
    if (!updateFrontmatter(patch)) {
      return false
    }
    if (conflict === null) {
      await flush()
      return true
    }
    // Saves are paused: the patch above rides the in-memory header (landing
    // with "keep mine"), so make the other half land too — patch the parked
    // content and write it through. The park refreshes in place, so "load
    // theirs" adopts the patched bytes, and recording the write in `disk`
    // makes the watcher's echo a recognized no-op.
    const patched = upsertFrontmatter(conflict, frontmatterPatchToYaml(patch))
    if (patched !== conflict) {
      await io.write(path, patched)
      conflict = patched
      disk = patched
      emit()
    }
    return true
  }

  /**
   * Apply an out-of-editor body edit (the Tasks view's toggle / edit / delete,
   * the suggested-contact card's append) transactionally:
   * `transform` rewrites the live document — header plus the unsaved buffer, so
   * concurrent editor edits survive — then we land it now so the Tasks view
   * refreshes promptly. Returns false when the session can't safely take a body
   * edit (no write channel, disposed, protected/read-only, still loading, or a
   * parked conflict) so the caller refuses rather than clobber the buffer via disk.
   * `transform` runs before any mutation, so a `TaskStaleError` (the marker can't
   * be located) propagates with nothing changed. And the write is all-or-nothing:
   * a failed flush reverts the in-memory edit so the editor and the Tasks list
   * can't diverge, then re-throws the failure.
   */
  async function commitBodyEdit(transform: (full: string) => string): Promise<boolean> {
    if (
      io.write === null ||
      disposed ||
      isProtected ||
      status !== 'ready' ||
      conflict !== null ||
      collab().paused ||
      recheckPending
    ) {
      return false
    }
    const previousHeader = header
    const previousBuffer = buffer
    const doc = splitDoc(transform(header + buffer))
    header = doc.header
    buffer = doc.body
    applyToEditor(doc.body) // the open editor shows the edited line
    dirty = header + buffer !== disk
    // A no-op edit (transform changed nothing) writes nothing, so a *prior*
    // surfaced save error must not be mistaken for this edit's failure.
    const shouldPersist = dirty
    emit()
    await flush()
    // `flush()` resolves even when the write failed (captured in `error`, not
    // thrown). Revert and surface the failure: it persists, or nothing changes.
    if (shouldPersist && error !== null) {
      const message = error
      header = previousHeader
      buffer = previousBuffer
      applyToEditor(previousBuffer)
      dirty = header + buffer !== disk
      error = null
      emit()
      throw new Error(message)
    }
    return true
  }

  function commitTaskToggle(task: TaskMarker): Promise<boolean> {
    return commitBodyEdit((full) => toggleTaskMarker(full, task).source)
  }

  function commitTaskEdit(task: TaskMarker, content: string): Promise<boolean> {
    return commitBodyEdit((full) => editTaskLine(full, task, content))
  }

  function commitTaskRemove(task: TaskMarker): Promise<boolean> {
    return commitBodyEdit((full) => removeTaskLine(full, task))
  }

  function commitTaskToBullet(task: TaskMarker): Promise<boolean> {
    return commitBodyEdit((full) => taskLineToBullet(full, task))
  }

  function commitBodyAppend(block: string): Promise<boolean> {
    if (block.trim() === '') {
      return Promise.resolve(false)
    }
    return commitBodyEdit((full) => appendBlock(full, block))
  }

  function dispose(): void {
    // A discarded session must not write: its file is being deleted, and a
    // flush would recreate it. Otherwise flush first — the queued save step
    // reads the (now frozen) buffer, so pending edits persist even after the
    // UI moves on. Final: lifts the pause gate, while an unresolved re-check
    // keeps blocking (the external side wins at teardown, like a parked
    // conflict) — only the timer is cleared, `recheckPending` stays set.
    if (recheckTimer !== null) {
      clearTimeout(recheckTimer)
      recheckTimer = null
    }
    if (!discarded) {
      void flush({ final: true })
    }
    disposed = true
  }

  function discard(): void {
    cancelScheduledSave()
    cancelRecheck()
    discarded = true
    disposed = true
  }

  return {
    get path() {
      return path
    },
    retarget: (to: string) => {
      path = to
    },
    load,
    editorChanged,
    externalChanged,
    flush,
    keepMine,
    loadTheirs,
    content: () => header + buffer,
    liveContent: () => (status === 'ready' ? header + buffer : null),
    isDirty: () => dirty,
    updateFrontmatter,
    commitFrontmatter,
    commitTaskToggle,
    commitTaskEdit,
    commitTaskRemove,
    commitTaskToBullet,
    commitBodyAppend,
    dispose,
    discard,
  }
}
