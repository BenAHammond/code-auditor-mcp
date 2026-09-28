/**
 * File accounting accumulator (Spec 44).
 *
 * Makes file handling *total*: every file the discovery walk touches lands in
 * exactly one terminal state — `analyzed` (reached >= 1 stage-2 visitor),
 * `partially analyzed` (dropped at stage 2 as `no adapter` / `no visitor
 * matched` yet still consumed/read by a later layer — the style indexer or a
 * stage-3 `readSource`), or `dropped` (with one of eight named reasons) — and
 * the accounting must balance
 * (`analyzed + partiallyAnalyzed + dropped === touched`), asserted at the end
 * of the run.
 *
 * The accumulator is owned by the run and threaded discovery -> stage 1 ->
 * stage 2. Files inside infrastructure directories (node_modules, .git, …) are
 * NOT in the universe — they are recorded as an aggregate `infraPruned` line,
 * never per-file. Reason 8 (`unsupported dialect`) is a sub-layer: style-level
 * unread sources that do NOT affect the file-level balance, reported under the
 * reason in metadata but excluded from `dropped`.
 */

import type { FileDropReason, FileAccountingSummary, FileAccountingFileEntry } from '../types.js';

/** Detail attached to a drop (everything except the filePath, which is the key). */
export type FileDropDetail = Omit<FileAccountingFileEntry, 'filePath'>;

const PARTIALLY_ANALYZED = 'partially analyzed';

type EntryState = 'touched' | 'analyzed' | typeof PARTIALLY_ANALYZED | 'dropped';

interface Entry {
  state: EntryState;
  reason?: FileDropReason;
  detail?: FileDropDetail;
}

/**
 * Thrown when the accounting does not balance: a file was touched but never
 * classified (a silent-drop leak), or classified more than once. Surfaced by
 * `assertBalanced()` at the end of the run and converted to a non-zero exit.
 */
export class AccountingBalanceError extends Error {
  override readonly name = 'AccountingBalanceError';
  /**
   * Creates an accounting balance error.
   *
   * @param message - The balance failure description.
   */
  constructor(message: string) {
    super(message);
  }
}

/**
 * Accumulates per-file terminal states across a discovery run and asserts the
 * `analyzed + partiallyAnalyzed + dropped === touched` balance at the end.
 */
export class FileAccounting {
  private readonly entries = new Map<string, Entry>();
  private readonly infraPrunedMap = new Map<string, { directory: string; rule: string; directories: number }>();
  private readonly unsupportedDialects: Array<{ filePath: string; reason?: string }> = [];
  private readonly conflicts: string[] = [];

  /**
   * Mark a candidate file as part of the touched universe.
   *
   * @param filePath - The file to record as touched.
   */
  recordTouched(filePath: string): void {
    if (!this.entries.has(filePath)) {
      this.entries.set(filePath, { state: 'touched' });
    }
  }

  /**
   * Mark a file as analyzed (its tuple reached >= 1 stage-2 visitor).
   *
   * @param filePath - The file to record as analyzed.
   */
  recordAnalyzed(filePath: string): void {
    const entry = this.entries.get(filePath);
    if (!entry) {
      this.entries.set(filePath, { state: 'analyzed' });
      return;
    }
    if (entry.state === 'analyzed') return; // idempotent — a file can reach several visitors
    if (entry.state === 'dropped') {
      this.conflicts.push(`${filePath}: analyzed after dropped(${entry.reason})`);
      return;
    }
    entry.state = 'analyzed';
  }

  /**
   * Mark a file as dropped with exactly one of the eight reasons.
   *
   * @param reason - The drop reason to record.
   * @param filePath - The file being dropped.
   * @param detail - Optional additional drop detail.
   */
  recordDropped(reason: FileDropReason, filePath: string, detail?: FileDropDetail): void {
    const entry = this.entries.get(filePath);
    if (!entry) {
      this.entries.set(filePath, { state: 'dropped', reason, detail });
      return;
    }
    if (entry.state === 'dropped') {
      if (entry.reason !== reason) {
        this.conflicts.push(`${filePath}: dropped(${reason}) after dropped(${entry.reason})`);
      }
      return;
    }
    if (entry.state === 'analyzed') {
      this.conflicts.push(`${filePath}: dropped(${reason}) after analyzed`);
      return;
    }
    entry.state = 'dropped';
    entry.reason = reason;
    entry.detail = detail;
  }

  /**
   * Sanctioned transition used only for the size-threshold path: an oversized
   * `.sql` orphan reaches the schema-sql visitor (and is therefore first
   * recorded `analyzed`) before being skipped. Reclassify it as dropped.
   *
   * @param reason - The drop reason to record.
   * @param filePath - The file being reclassified.
   * @param detail - Optional additional drop detail.
   */
  reclassifyAnalyzedToDropped(reason: FileDropReason, filePath: string, detail?: FileDropDetail): void {
    const entry = this.entries.get(filePath);
    if (!entry || entry.state !== 'analyzed') {
      this.conflicts.push(`${filePath}: reclassify(${reason}) when state=${entry?.state ?? 'absent'}`);
      return;
    }
    entry.state = 'dropped';
    entry.reason = reason;
    entry.detail = detail;
  }

  /**
   * Reclassify a file dropped at stage 2 as "partially analyzed": it reached
   * zero stage-2 visitors (hence `no adapter` / `no visitor matched`) yet was
   * still *consumed* (read) by a later layer — the style indexer readFileSyncs
   * every discovered file, stage-3 reducers pull source via `readSource`. The
   * trigger is consumption, not output: a clean file the indexer read is just as
   * "partially analyzed" as one that happened to produce findings. The original
   * reason is retained — it still explains why the file wasn't *fully* analyzed.
   *
   * Only `no adapter` and `no visitor matched` are reclassifiable: the other
   * drop reasons mean the file never reached (directory pruned, extension not
   * known, parse failed) or was deliberately removed from (size threshold, path
   * profile excluded) every analysis layer, so a read from one of them would be
   * a genuine accounting bug, not a partial analysis. No-ops otherwise, so the
   * pipeline can call it blindly over every consumed file path.
   *
   * @param filePath - The file being reclassified as partially analyzed.
   */
  reclassifyDroppedToPartiallyAnalyzed(filePath: string): void {
    const entry = this.entries.get(filePath);
    if (!entry || entry.state !== 'dropped') return;
    if (entry.reason !== 'no adapter' && entry.reason !== 'no visitor matched') return;
    entry.state = PARTIALLY_ANALYZED;
  }

  /**
   * Record an infrastructure directory prune (aggregate, not per-file).
   *
   * @param directory - The pruned directory.
   * @param rule - The pruning rule that matched.
   */
  recordInfraPruned(directory: string, rule: string): void {
    const key = `${directory}::${rule}`;
    const existing = this.infraPrunedMap.get(key);
    if (existing) existing.directories++;
    else this.infraPrunedMap.set(key, { directory, rule, directories: 1 });
  }

  /**
   * Reason 8 sub-layer: a style-level unread source (Spec 42 R2). Recorded in
   * the summary under `unsupported dialect` but does NOT touch the file-level
   * `analyzed + dropped === touched` balance.
   */
  recordUnsupportedDialect(filePath: string, reason?: string): void {
    this.unsupportedDialects.push({ filePath, reason });
  }

  /**
   * Verify the balance. Throws `AccountingBalanceError` if any file was touched
   * but never classified (a leak) or classified more than once. Called at the
   * end of the run before metadata assembly.
   */
  assertBalanced(): void {
    const leaked: string[] = [];
    for (const [filePath, entry] of this.entries) {
      if (entry.state === 'touched') leaked.push(filePath);
    }

    if (leaked.length === 0 && this.conflicts.length === 0) return;

    const lines: string[] = [];
    if (leaked.length > 0) {
      lines.push(`${leaked.length} file(s) touched but never classified (silent-drop leak):`);
      leaked.sort();
      for (const f of leaked.slice(0, 20)) lines.push(`  - ${f}`);
      if (leaked.length > 20) lines.push(`  … and ${leaked.length - 20} more`);
    }
    if (this.conflicts.length > 0) {
      lines.push(`${this.conflicts.length} file(s) classified more than once:`);
      for (const c of this.conflicts.slice(0, 20)) lines.push(`  - ${c}`);
      if (this.conflicts.length > 20) lines.push(`  … and ${this.conflicts.length - 20} more`);
    }
    throw new AccountingBalanceError(lines.join('\n'));
  }

  /**
   * Produce the summary (touched/analyzed/partiallyAnalyzed/dropped counts + per-reason lists).
   *
   * @returns The file accounting summary.
   */
  summary(): FileAccountingSummary {
    let analyzed = 0;
    let partiallyAnalyzed = 0;
    let dropped = 0;
    const reasons = new Map<FileDropReason, FileAccountingFileEntry[]>();

    for (const [filePath, entry] of this.entries) {
      if (entry.state === 'analyzed') {
        analyzed++;
      } else if (
        (entry.state === 'dropped' || entry.state === PARTIALLY_ANALYZED) &&
        entry.reason
      ) {
        if (entry.state === PARTIALLY_ANALYZED) partiallyAnalyzed++;
        else dropped++;
        let list = reasons.get(entry.reason);
        if (!list) {
          list = [];
          reasons.set(entry.reason, list);
        }
        const detail = entry.detail ?? {};
        list.push({
          filePath,
          ...detail,
          ...(entry.state === PARTIALLY_ANALYZED ? { partial: true } : {}),
        });
      }
    }

    const reasonsOut: FileAccountingSummary['reasons'] = {};
    for (const [reason, list] of reasons) {
      list.sort((a, b) => a.filePath.localeCompare(b.filePath));
      reasonsOut[reason] = { count: list.length, files: list };
    }
    if (this.unsupportedDialects.length > 0) {
      const list = this.unsupportedDialects
        .map(({ filePath, reason }) => ({ filePath, ...(reason !== undefined ? { reason } : {}) }))
        .sort((a, b) => a.filePath.localeCompare(b.filePath));
      reasonsOut['unsupported dialect'] = { count: list.length, files: list };
    }

    return {
      touched: this.entries.size,
      analyzed,
      partiallyAnalyzed,
      dropped,
      infraPruned: [...this.infraPrunedMap.values()].sort(
        (a, b) => b.directories - a.directories || a.directory.localeCompare(b.directory)
      ),
      reasons: reasonsOut,
    };
  }
}
