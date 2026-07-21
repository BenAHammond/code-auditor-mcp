/**
 * Spec-17 R8 Fixture 2: jsx-event-handler
 * Report section: R1.1 — Skip anonymous/inline callables
 *
 * JSX event-handler arrow functions should produce ZERO documentation findings.
 */

import React from "react";

export function Button({ label, onAction }: { label: string; onAction: () => void }) {
  return (
    <button
      onClick={() => onAction()}
      onFocus={(e) => e.currentTarget.classList.add("focused")}
    >
      {label}
    </button>
  );
}

export function List({ items }: { items: string[] }) {
  return (
    <ul>
      {items.map((item) => (
        <li key={item}>{item}</li>
      ))}
    </ul>
  );
}
