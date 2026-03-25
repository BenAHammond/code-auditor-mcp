/**
 * Parse --data-dir before any module loads CodeIndexDB.getInstance().
 * Sets CODE_AUDITOR_DATA_DIR to an absolute path (resolved from cwd if relative).
 */
import path from 'node:path';

const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--data-dir' || a === '--dataDir') {
    const val = argv[i + 1];
    if (val && !val.startsWith('-')) {
      process.env.CODE_AUDITOR_DATA_DIR = path.resolve(val);
    } else {
      // stderr only; avoids silent failure when e.g. `--data-dir --ui` skips the path
      console.error(
        '[code-auditor] --data-dir requires a directory path (next argv). Using CODE_AUDITOR_DATA_DIR env or default .code-index/.'
      );
    }
    break;
  }
}
