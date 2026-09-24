import { css } from "@emotion/react";

// Typo near .btn-primary (defined in app.css) — undefined-class (severe).
const Save = () => <button className="btn-primry">Save</button>;

// Mechanism-mixing: inline + tailwind + css-in-js in one file.
const Layout = () => (
  <div className="flex" style={{ display: "flex" }}>
    {css`display: flex;`}
  </div>
);

// Token bypass: raw #1e2328 matches --color-primary token (app.css :root).
const TokenBypass = () => <span style={{ color: "#1e2328" }}>x</span>;

// Color drift: background-color, 20x dominant #111111 + 1 outlier #ff0000.
const C0 = () => <span style={{ backgroundColor: "#111111" }}>a</span>;
const C1 = () => <span style={{ backgroundColor: "#111111" }}>a</span>;
const C2 = () => <span style={{ backgroundColor: "#111111" }}>a</span>;
const C3 = () => <span style={{ backgroundColor: "#111111" }}>a</span>;
const C4 = () => <span style={{ backgroundColor: "#111111" }}>a</span>;
const C5 = () => <span style={{ backgroundColor: "#111111" }}>a</span>;
const C6 = () => <span style={{ backgroundColor: "#111111" }}>a</span>;
const C7 = () => <span style={{ backgroundColor: "#111111" }}>a</span>;
const C8 = () => <span style={{ backgroundColor: "#111111" }}>a</span>;
const C9 = () => <span style={{ backgroundColor: "#111111" }}>a</span>;
const C10 = () => <span style={{ backgroundColor: "#111111" }}>a</span>;
const C11 = () => <span style={{ backgroundColor: "#111111" }}>a</span>;
const C12 = () => <span style={{ backgroundColor: "#111111" }}>a</span>;
const C13 = () => <span style={{ backgroundColor: "#111111" }}>a</span>;
const C14 = () => <span style={{ backgroundColor: "#111111" }}>a</span>;
const C15 = () => <span style={{ backgroundColor: "#111111" }}>a</span>;
const C16 = () => <span style={{ backgroundColor: "#111111" }}>a</span>;
const C17 = () => <span style={{ backgroundColor: "#111111" }}>a</span>;
const C18 = () => <span style={{ backgroundColor: "#111111" }}>a</span>;
const C19 = () => <span style={{ backgroundColor: "#111111" }}>a</span>;
const COutlier = () => <span style={{ backgroundColor: "#ff0000" }}>b</span>;

// Exact-value drift: border-radius, 20x dominant 4px + 1 outlier 7px.
const R0 = () => <span style={{ borderRadius: 4 }}>c</span>;
const R1 = () => <span style={{ borderRadius: 4 }}>c</span>;
const R2 = () => <span style={{ borderRadius: 4 }}>c</span>;
const R3 = () => <span style={{ borderRadius: 4 }}>c</span>;
const R4 = () => <span style={{ borderRadius: 4 }}>c</span>;
const R5 = () => <span style={{ borderRadius: 4 }}>c</span>;
const R6 = () => <span style={{ borderRadius: 4 }}>c</span>;
const R7 = () => <span style={{ borderRadius: 4 }}>c</span>;
const R8 = () => <span style={{ borderRadius: 4 }}>c</span>;
const R9 = () => <span style={{ borderRadius: 4 }}>c</span>;
const R10 = () => <span style={{ borderRadius: 4 }}>c</span>;
const R11 = () => <span style={{ borderRadius: 4 }}>c</span>;
const R12 = () => <span style={{ borderRadius: 4 }}>c</span>;
const R13 = () => <span style={{ borderRadius: 4 }}>c</span>;
const R14 = () => <span style={{ borderRadius: 4 }}>c</span>;
const R15 = () => <span style={{ borderRadius: 4 }}>c</span>;
const R16 = () => <span style={{ borderRadius: 4 }}>c</span>;
const R17 = () => <span style={{ borderRadius: 4 }}>c</span>;
const R18 = () => <span style={{ borderRadius: 4 }}>c</span>;
const R19 = () => <span style={{ borderRadius: 4 }}>c</span>;
const ROutlier = () => <span style={{ borderRadius: 7 }}>d</span>;

// Z-index: 7 distinct values — 1..6 used twice, 7 used once (sprawl + singleton).
const Z1a = () => <span style={{ zIndex: 1 }}>z</span>;
const Z1b = () => <span style={{ zIndex: 1 }}>z</span>;
const Z2a = () => <span style={{ zIndex: 2 }}>z</span>;
const Z2b = () => <span style={{ zIndex: 2 }}>z</span>;
const Z3a = () => <span style={{ zIndex: 3 }}>z</span>;
const Z3b = () => <span style={{ zIndex: 3 }}>z</span>;
const Z4a = () => <span style={{ zIndex: 4 }}>z</span>;
const Z4b = () => <span style={{ zIndex: 4 }}>z</span>;
const Z5a = () => <span style={{ zIndex: 5 }}>z</span>;
const Z5b = () => <span style={{ zIndex: 5 }}>z</span>;
const Z6a = () => <span style={{ zIndex: 6 }}>z</span>;
const Z6b = () => <span style={{ zIndex: 6 }}>z</span>;
const Z7 = () => <span style={{ zIndex: 7 }}>z</span>;

export { Save, Layout, TokenBypass, COutlier, ROutlier, Z7 };
