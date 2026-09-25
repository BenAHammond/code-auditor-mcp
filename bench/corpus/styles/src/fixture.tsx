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

// Color drift (Spec 67): `background-color` carries two near-identical slate
// values. #4e5568 is ΔE76 = 1.51 from #4a5568 (under the 2.5 threshold) → one
// value-drift finding naming #4a5568 (the most-used value) as the canonical.
const D0 = () => <span style={{ backgroundColor: "#4a5568" }}>d</span>;
const D1 = () => <span style={{ backgroundColor: "#4a5568" }}>d</span>;
const D2 = () => <span style={{ backgroundColor: "#4a5568" }}>d</span>;
const D3 = () => <span style={{ backgroundColor: "#4a5568" }}>d</span>;
const D4 = () => <span style={{ backgroundColor: "#4a5568" }}>d</span>;
const DDrift = () => <span style={{ backgroundColor: "#4e5568" }}>d</span>;

// Negative guard: #535568 is ΔE76 = 3.45 from #4a5568 (over the 2.5 threshold)
// — must NOT fire value-drift. It lives in `color` (not `background-color`) so
// single-linkage cannot chain it to #4e5568 (#4e5568 ↔ #535568 = 1.94 would
// otherwise bridge the two near-pairs into one cluster).
const N0 = () => <span style={{ color: "#4a5568" }}>n</span>;
const N1 = () => <span style={{ color: "#4a5568" }}>n</span>;
const N2 = () => <span style={{ color: "#4a5568" }}>n</span>;
const NNear = () => <span style={{ color: "#535568" }}>n</span>;

// Length drift (border-radius 20x 4px + 1x 7px) is a NEGATIVE guard: value-drift
// is color-only (Spec 66 follow-up #253), so this length sprawl must NOT fire
// value-drift (nor off-scale — border-radius is not a scale-family property).
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

export { Save, Layout, TokenBypass, DDrift, NNear, ROutlier, Z7 };
