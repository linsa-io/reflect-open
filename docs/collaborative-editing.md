# Collaborative editing

Panes showing the same note edit it together in real time: remote carets,
character-level convergence, and a per-pane Live/Paused toggle whose offline
edits merge losslessly on resume. Built on Loro CRDT sessions bound to the
meowdown editor (`loro-prosemirror` via ProseKit's `defineLoro`); the first
transport is this app's own windows. Markdown files remain the source of
truth — the shared document is ephemeral session state, never persisted.

## Sessions and lineage

Loro merges only documents that share history, so the shell arbitrates
lineage (`src-tauri/src/collab.rs`): the first pane to open a note offers a
candidate seed (markdown → ProseMirror tree → snapshot) and wins atomically;
every later pane imports the canonical bytes instead of its own candidate.
One such "epoch" exists per note key (graph root + path); the last leave
drops it, and a destroyed window's memberships are dropped by the shell.
Beyond seeding, the shell only relays opaque update/presence bytes
(`collab:message`) and announces membership (`collab:members`).

The seed is frozen for the epoch's lifetime. Joiners catch up past it by
asking live members (a state request answered with a version-vector export),
with one delayed re-ask covering a dropped event.

The client layer lives in `src/editor/collab/`: `collab-session.ts` (the
state machine, framework-free), the `CollabTransport` port with a Tauri
implementation and an in-memory test hub, the seed builder, and the React
hook/plugin/indicator. The transport port is the adapter seam for a future
row-store backend (e.g. a Jazz `note_updates` table): the session, seeding
protocol, and editor binding transfer; the arbiter and relay swap.

## Live and Paused

- **Live** — local commits stream out, remote updates import, presence flows
  both ways.
- **Paused** — the session leaves the epoch (a paused pane can neither serve
  catch-up nor accept updates, so membership would freeze the epoch's
  visible state and inflate peer counts). The doc stays local; divergence is
  deliberate.
- **Resume** — rejoin, offering the current doc as candidate; the mode
  reports `paused` until the rejoin settles. A surviving epoch's seed shares
  this doc's lineage and imports as a merge; the session then replays its
  divergence and requests peers' side. If the epoch died and a *new* one was
  seeded from disk meanwhile, its lineage is unrelated — importing it would
  duplicate content — so the resume is refused and the pane stays paused
  with its doc intact.

## Files under collab

Disk becomes a projection of the shared state, with these session-level
rules (`note-session-state.ts`):

- **Equality adopts.** External content equal to the buffer is another
  pane's save of converged content: adopt silently, clear a converged park.
- **Live defers.** A mismatching external change while shared gets a short
  re-check (saves held for its whole span) before parking — disk
  legitimately lags the converged buffer by a save debounce. A moving buffer
  re-defers a bounded number of times.
- **Paused holds.** Saves stop; external content is remembered and settled
  before this pane's next write (adopt or park — never silently overwritten).
- **Final flushes are one seam.** Quit, window close, and note moves land
  through `flush({ final: true })`, which publishes a paused pane's unshared
  ops to the epoch before the write. An unresolved re-check blocks even a
  final flush — the external side wins at teardown, like a parked conflict.
  While saves are held, `commitFrontmatter`/`commitBodyEdit` refuse so their
  callers use their disk fallbacks.

Protected (lossy) notes never enter a session, and a note that turns lossy
mid-session leaves its epoch. Auto-renames defer while a note is actively
shared (two dirty writers would race the same title move). Frontmatter stays
outside the shared document; concurrent frontmatter edits across panes
surface as a deferred conflict rather than merging.

## Vendored patch

`patches/loro-prosemirror@0.4.3.patch` carries two upstream fixes: absent-key
attribute deletes emitted an op per transaction for schemas with null-default
attrs (an infinite idle update loop between two panes), and the sync plugin's
deferred `init` let a pre-attach editor transaction export stale state over
an already-caught-up doc. `loro-crdt` is pinned to its self-loading `browser`
build and excluded from `optimizeDeps` (see `vite.config.ts`);
`loro-prosemirror` must stay *in* the prebundle or ProseKit's
`instanceof Plugin` checks fail across two prosemirror-state copies.
