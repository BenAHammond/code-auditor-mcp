/**
 * raw-elements.tsx — `raw-element` (rule 65) at production scale.
 *
 * The rule detects raw intrinsic-element usage when a project-defined wrapper
 * exists. The wrapper is *auto-detected*: an exported component whose JSX
 * contains exactly one watch-list intrinsic element (`button`, `input`,
 * `select`, `textarea`, `table`). `Button` below is that wrapper — a single
 * `<button>` in its render tree, exported.
 *
 * A raw `<button>` is then a violation when it appears in a component that is
 * *not* the wrapper itself, and the total number of such components reaches
 * `wrapperMinUsages` (5). The finding anchors to the raw element's own line —
 * the first `<button>` in each offending component. `wrapperMinUsages` counts
 * *components* that use the raw element (one per unique tag per component),
 * not raw element occurrences, so five distinct button-using components are the
 * threshold.
 *
 * ── Expected verdicts (human, not the tool) ────────────────────────────────
 *   @fires raw-element 31 — first raw `<button>` (SubmitButton)
 *   @fires raw-element 33 — second raw `<button>` (CancelButton)
 *   @fires raw-element 35 — third raw `<button>` (DeleteButton)
 *   @fires raw-element 37 — fourth raw `<button>` (SaveButton)
 *   @fires raw-element 39 — fifth raw `<button>` (EditButton)
 */

/** The auto-detected wrapper: exported, exactly one `<button>` intrinsic. */
export function Button({ children, onClick }: { children: any; onClick?: () => void }) {
  return <button onClick={onClick}>{children}</button>;
}

function SubmitButton() { return <button type="submit">Submit</button>; }

function CancelButton() { return <button type="button">Cancel</button>; }

function DeleteButton() { return <button type="button">Delete</button>; }

function SaveButton() { return <button type="button">Save</button>; }

function EditButton() { return <button type="button">Edit</button>; }
