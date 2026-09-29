/**
 * component-smells.tsx — the react family (rules 59–64) at production scale.
 *
 * Five signals, one per purpose-built component. Every react rule reads the
 * `react-component` fact (`scanParsedFile`), so the classification (component
 * detection, hook extraction, complexity, JSX element details) is the same
 * tree-sitter walk the legacy visitor used. Anchors are per-element where the
 * signal is an element (inline `onClick`, `<img>` without alt, `<div onClick>`),
 * per-call for a hook naming violation, and the declaration line for complexity.
 *
 *   - `hooks-naming` (59) — `loadProfile()` calls `useState` but is named
 *     without the `use` prefix; calling it inside a component is the violation,
 *     anchored at the call site.
 *   - `complexity` (60) — `CheckoutForm` has eight `if` branches; the corpus
 *     config lowers `maxComponentComplexity` 20 → 8, so a 9-complexity component
 *     fires (the default 20 would keep it quiet).
 *   - `performance` (63) — an inline arrow `onClick={() => …}` re-renders every
 *     pass; the finding anchors to the `onClick` attribute's own line.
 *   - `accessibility` (64, severe) — an `<img>` without `alt`, and a
 *     non-interactive `<div>` carrying `onClick`. Both anchor to their element.
 *
 * Two react rules are intentionally absent from this corpus, each documented in
 * REPORT.md rather than faked:
 *   - `missing-props` (61) is gated off by default (`requirePropTypes: false`).
 *   - `no-error-boundary` (62) is app-level (synthetic `app-level` file, only
 *     when > 10 components and no boundary exists) — this corpus stays at ten
 *     components, one under the threshold.
 *
 * ── Expected verdicts (human, not the tool) ────────────────────────────────
 *   @fires hooks-naming 47 — `loadProfile()` called inside `ProfileCard`, at the call site
 *   @fires complexity 52 — `CheckoutForm` complexity 9, one past the corpus threshold of 8
 *   @fires performance 83 — inline arrow `onClick` on `SaveLink`
 *   @fires accessibility 89 — `<div onClick>` on a non-interactive element
 *   @fires accessibility 90 — `<img>` without an `alt` attribute
 */

import { useState } from 'react';

/** A hook in everything but name — `useState` under a non-`use` identifier. */
function loadProfile() {
  const [profile] = useState(null);
  return profile;
}

/** Calling the misnamed hook is the `hooks-naming` violation, at the call site. */
export function ProfileCard() {
  const profile = loadProfile();
  return <div>{profile?.name}</div>;
}

/** Eight `if` branches → complexity 9, one past the corpus threshold of 8. */
export function CheckoutForm({ order }: { order: any }) {
  let total = 0;
  if (order.subtotal > 0) {
    total = order.subtotal;
  }
  if (order.discount) {
    total -= order.discount;
  }
  if (order.taxRate) {
    total += order.taxRate * total;
  }
  if (order.shipping) {
    total += order.shipping;
  }
  if (order.currency === 'USD') {
    total = Math.round(total);
  }
  if (order.isGift) {
    total += order.giftWrap;
  }
  if (order.requiresSignature) {
    total += order.signatureFee;
  }
  if (total < 0) {
    total = 0;
  }
  return <div>Total: {total}</div>;
}

/** An inline arrow `onClick` — a fresh function every render. */
export function SaveLink({ onSave }: { onSave?: () => void }) {
  return <a href="#" onClick={() => onSave?.()}>Save</a>;
}

/** Both accessibility sub-signals: an `<img>` without `alt`, a clickable `<div>`. */
export function MediaCard({ src, onSelect }: { src: string; onSelect?: () => void }) {
  return (
    <div onClick={onSelect}>
      <img src={src} />
    </div>
  );
}
