/**
 * Safe pattern — placeholder list via `.map(() => '?').join()`.
 *
 * A zero-parameter callback produces a constant list of `?` placeholders
 * regardless of the source array's contents; the values are bound out-of-band
 * via `.all(...filePaths)`, so the interpolated text is only placeholders,
 * never raw data.
 */
import Database from 'better-sqlite3';

export function getHashesForFiles(filePaths: string[]): void {
  const db = new Database(':memory:');
  const placeholders = filePaths.map(() => '?').join(', ');
  db.prepare(
    `SELECT file_path, name FROM functions WHERE file_path IN (${placeholders})`
  ).all(...filePaths);
}
