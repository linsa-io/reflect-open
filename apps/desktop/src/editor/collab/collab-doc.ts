import { LoroDoc } from 'loro-crdt'
import type { LoroDocType } from 'loro-prosemirror'

/**
 * A fresh doc typed as loro-prosemirror expects. `LoroDoc`'s constructor
 * cannot be parameterized with the binding's container shape, so this is the
 * one sanctioned assertion — the shape is established by the seeding/attach
 * code, not by the constructor. Lives apart from `collab-seed.ts` so the
 * session layer can create docs without transitively importing meowdown.
 *
 * Text styles are deliberately NOT configured here: the seed builder
 * configures them from the schema before writing marks, and `LoroSyncPlugin`
 * re-configures them at attach. Any future code that writes marks into a doc
 * from this factory before an editor attaches must configure styles first
 * (see `configureTextStyles` in collab-seed.ts).
 */
export function newCollabDoc(): LoroDocType {
  return new LoroDoc() as LoroDocType
}
