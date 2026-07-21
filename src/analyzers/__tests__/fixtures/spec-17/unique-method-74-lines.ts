/**
 * Spec-17 R8 Fixture 11: unique-method-74-lines
 * Report section: R3.1 — Self-reference fix
 *
 * A single 74-line unique method should produce ZERO duplicate findings.
 * The self-reference fix (span-overlap check, R3.1) ensures a block
 * never cites itself as the "first occurrence."
 */

export class ReportGenerator {
  public generateReport(title: string, data: number[]): string {
    // Line 1 of method body
    const header = `=== ${title} ===`;
    // Line 2
    const separator = "=".repeat(header.length);
    // Line 3
    let total = 0;
    // Line 4
    let min = Number.MAX_VALUE;
    // Line 5
    let max = Number.MIN_VALUE;
    // Line 6
    const processed: number[] = [];
    // Line 7
    for (const value of data) {
      // Line 8
      if (value > 0) {
        // Line 9
        processed.push(value);
        // Line 10
        total += value;
        // Line 11
        if (value < min) min = value;
        // Line 12
        if (value > max) max = value;
        // Line 13
      }
      // Line 14
    }
    // Line 15
    const average = processed.length > 0 ? total / processed.length : 0;
    // Line 16
    const lines: string[] = [];
    // Line 17
    lines.push(header);
    // Line 18
    lines.push(separator);
    // Line 19
    lines.push(`Count: ${processed.length}`);
    // Line 20
    lines.push(`Total: ${total}`);
    // Line 21
    lines.push(`Average: ${average.toFixed(2)}`);
    // Line 22
    lines.push(`Min: ${min}`);
    // Line 23
    lines.push(`Max: ${max}`);
    // Line 24
    lines.push(`Range: ${max - min}`);
    // Line 25
    if (processed.length > 0) {
      // Line 26
      lines.push("---");
      // Line 27
      lines.push("Details:");
      // Line 28
      for (let i = 0; i < processed.length; i++) {
        // Line 29
        lines.push(`  ${i + 1}. ${processed[i]}`);
        // Line 30
      }
      // Line 31
    }
    // Line 32
    lines.push(separator);
    // Line 33
    return lines.join("\n");
    // Line 34
  }
}
