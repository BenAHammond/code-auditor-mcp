import { readFileSync, writeFileSync } from 'fs';

const fp = 'src/analyzers/crossDomain/CrossDomainAnalyzer.ts';
let src = readFileSync(fp, 'utf8');

// 1. Replace import
src = src.replace(
  "import { CodeIndexDB } from '../../codeIndexDB.js';",
  "import type { IndexHandle } from '../../types.js';"
);

// 2. Remove private projectRoot field and its comment
src = src.replace(
  "  /** Project root for DB scoping (Bug #4 / Item 1). */\n  private projectRoot: string | undefined;\n\n",
  ""
);

// 3. Remove this.projectRoot = ... line
src = src.replace(
  "    // Store projectRoot for scoped DB access in private methods (Bug #4 / Item 1)\n    this.projectRoot = config.projectRoot as string | undefined;\n\n",
  ""
);

// 4. Replace CodeIndexDB.getInstance block with config.indexHandle
src = src.replace(
  /    let rawDb: any = null;\n    try \{\n      const db = CodeIndexDB\.getInstance\(undefined, this\.projectRoot\);\n      await db\.initialize\(\);\n      rawDb = \(db as any\)\.rawDb;\n    \} catch \{/,
  "    const rawDb: IndexHandle | undefined = config.indexHandle;\n    if (!rawDb) {"
);

// 5. Rename rawDb to indexHandle (all standalone references)
// First in method parameter types
src = src.replace(/rawDb: any/g, 'indexHandle: IndexHandle');

// 6. Convert .prepare(sql).all(params) to .query(sql, params)
// This is the trickiest part - needs to handle multi-line patterns.
// Simple case: rawDb\n      .prepare('...')\n      .all() -> indexHandle.query('...')
// Complex case: rawDb\n        .prepare(\n          '...'\n        )\n        .all(param) -> indexHandle.query('...', [param])

// Strategy: replace all .prepare( + content + ).all( + params + ) with .query( + content + , + wrappedParams + )
// Do this in a multi-line aware way

// First, let's handle the .prepare().all() calls.
// We'll use a different approach: replace rawDb with indexHandle first,
// then convert .prepare().all() patterns by capturing the SQL and params.

// Replace rawDb → indexHandle (only as standalone word, not in strings)
src = src.replace(/\brawDb\b/g, 'indexHandle');

// Now convert indexHandle.prepare(sql).all(params) to indexHandle.query(sql, params)
// This regex handles multi-line by using [\s\S]*? (non-greedy match any char including newline)

// Pattern: indexHandle\n  .prepare(\n    'SQL',\n  )\n  .all(...params) as Type[]
// or: indexHandle\n  .prepare(\n    `SQL`,\n  )\n  .all(...params) as Type[]

// Replace: .prepare( → (temporarily) just capture SQL and params
// .all(params) → .query(sql, params)

// Approach: use a regex to match .prepare(...) followed by .all(...) and replace with .query(...)
// The pattern is: .prepare( + CONTENT + ).all( + PARAMS + )
// Where CONTENT may span multiple lines and PARAMS may be empty

// Match: .prepare(  <sql-content>  )  .all(  <params>  )  as Type
const prepareAllRegex = /\.prepare\(\s*([\s\S]*?)\s*\)\s*\.all\(([\s\S]*?)\)(\s+as\s+[\s\S]*?;)/g;

src = src.replace(prepareAllRegex, (match, sql, params, rest) => {
  // Trim trailing commas/semicolons from SQL
  let cleanSql = sql.trim();

  // Process params: if empty/spread, handle differently
  let cleanParams = params.trim();
  if (cleanParams === '') {
    return `.query(${cleanSql})${rest}`;
  } else if (cleanParams.startsWith('...')) {
    // Spread operator: .all(...params) → .query(sql, params) — but .query takes array, not spread
    const spreadContent = cleanParams.slice(3); // remove '...'
    return `.query(${cleanSql}, ${spreadContent})${rest}`;
  } else {
    // Individual params: .all(p1, p2) → .query(sql, [p1, p2])
    return `.query(${cleanSql}, [${cleanParams}])${rest}`;
  }
});

// Convert .prepare(sql).get() to .query(sql)[0]
// Pattern: .prepare(  <sql-content>  )  .get(  <params>  )
const prepareGetRegex = /\.prepare\(\s*([\s\S]*?)\s*\)\s*\.get\(([\s\S]*?)\)/g;

src = src.replace(prepareGetRegex, (match, sql, params) => {
  let cleanSql = sql.trim();
  let cleanParams = params.trim();
  if (cleanParams === '') {
    return `.query(${cleanSql})[0]`;
  } else {
    return `.query(${cleanSql}, [${cleanParams}])[0]`;
  }
});

// 7. In detectUncoveredRisk: replace db = CodeIndexDB.getInstance(...) with using indexHandle
src = src.replace(
  "    const db = CodeIndexDB.getInstance(undefined, this.projectRoot);\n",
  ""
);
src = src.replace(/\bdb\.getUntestedTopDecile\b/g, 'indexHandle.getUntestedTopDecile');
src = src.replace(/\bdb\.getMeta\b/g, 'indexHandle.getMeta');

writeFileSync(fp, src, 'utf8');
console.log('CrossDomainAnalyzer transformation complete');
