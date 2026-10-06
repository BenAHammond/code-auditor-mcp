/**
 * Shared SQL-literal dequoting: turn the raw source text of a string/template
 * literal node into the literal's *value* — the SQL text a parser expects —
 * not the raw source slice.
 *
 * The raw source still carries the host language's escape sequences (`\'` for
 * an embedded single quote, `\\` for a literal backslash, `\n` for a newline).
 * Feeding that raw slice to the SQL parser corrupts the statement: the parser
 * reads `\'` where the author meant `'` and mis-parses the string. `stripSqlQuotes`
 * therefore both strips the surrounding delimiters *and* un-escapes the inner
 * body to its runtime value.
 *
 * This was once a two-line `slice(1, -1)` duplicated verbatim in `provenance.ts`
 * and `UniversalDataAccessAnalyzer.ts`; it lives here once so the two cannot
 * drift. The `raw` flag preserves the one place the two languages disagree on
 * backticks: a Go `raw_string_literal` is literal (no escapes), while a TS
 * `template_string` is escape-bearing.
 */

/**
 * Strip the surrounding quote delimiters of a string/template literal and
 * un-escape the inner escape sequences to the literal's runtime value.
 *
 * @param text - the raw source text of the literal node, delimiters included.
 * @param opts.raw - true when the literal is a Go `raw_string_literal`
 *   (backtick, no escape sequences); the body is then returned verbatim.
 */
export function stripSqlQuotes(text: string, opts?: { raw?: boolean }): string {
  if (text.length >= 2 && (text[0] === '"' || text[0] === "'" || text[0] === '`')) {
    const body = text.slice(1, -1);
    return opts?.raw ? body : unescapeLiteralBody(body);
  }
  return text;
}

/**
 * Un-escape the body of an *interpreted* string/template literal — the inner
 * text between the delimiters — to its runtime value. Covers the escapes JS/TS
 * and Go share for SQL-relevant content: the quote/backtick/backslash escapes,
 * the C-style control escapes, and the hex/unicode escapes. An unrecognized
 * escape (`\d`) is preserved verbatim rather than dropped: dropping the
 * backslash would silently rewrite a literal backslash the author meant.
 */
function unescapeLiteralBody(body: string): string {
  if (body.indexOf('\\') === -1) return body;
  let out = '';
  let i = 0;
  const n = body.length;
  while (i < n) {
    const ch = body[i];
    if (ch !== '\\' || i + 1 >= n) {
      out += ch;
      i += 1;
      continue;
    }
    const next = body[i + 1];
    switch (next) {
      case 'n': out += '\n'; i += 2; break;
      case 't': out += '\t'; i += 2; break;
      case 'r': out += '\r'; i += 2; break;
      case 'b': out += '\b'; i += 2; break;
      case 'f': out += '\f'; i += 2; break;
      case 'v': out += '\v'; i += 2; break;
      case '0': out += '\0'; i += 2; break;
      case 'a': out += '\x07'; i += 2; break; // \a (bell) — Go only, harmless in JS
      case '\\': out += '\\'; i += 2; break;
      case "'": out += "'"; i += 2; break;
      case '"': out += '"'; i += 2; break;
      case '`': out += '`'; i += 2; break;
      case '\n': i += 2; break; // line continuation — drop `\` + newline
      case '\r': // `\` + `\r` (or `\r\n`) line continuation
        i += 2;
        if (i < n && body[i] === '\n') i += 1;
        break;
      case 'x': {
        const hex = body.slice(i + 2, i + 4);
        if (i + 4 <= n && /^[0-9a-fA-F]{2}$/.test(hex)) {
          out += String.fromCharCode(parseInt(hex, 16));
          i += 4;
        } else {
          out += '\\x';
          i += 2;
        }
        break;
      }
      case 'u': {
        if (body[i + 2] === '{') {
          const close = body.indexOf('}', i + 2);
          const hex = close === -1 ? '' : body.slice(i + 3, close);
          if (close !== -1 && /^[0-9a-fA-F]{1,6}$/.test(hex)) {
            const cp = parseInt(hex, 16);
            if (cp <= 0x10ffff) {
              out += String.fromCodePoint(cp);
              i = close + 1;
              break;
            }
          }
          out += '\\u';
          i += 2;
        } else {
          const hex = body.slice(i + 2, i + 6);
          if (i + 6 <= n && /^[0-9a-fA-F]{4}$/.test(hex)) {
            out += String.fromCharCode(parseInt(hex, 16));
            i += 6;
          } else {
            out += '\\u';
            i += 2;
          }
        }
        break;
      }
      default:
        out += '\\' + next;
        i += 2;
        break;
    }
  }
  return out;
}
