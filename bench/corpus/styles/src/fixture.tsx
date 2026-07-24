// Minimal placeholder file for bench/corpus/styles/ fixture.
// The styles analyzer reads from the SQLite style index (seeded by the
// bench runner), not from this file's AST. This file exists solely so
// collectFiles() finds at least one file and passes it to the analyzer.

export const Placeholder = () => {
  return <div className="obscure-custom-class-xyz">placeholder</div>;
};
