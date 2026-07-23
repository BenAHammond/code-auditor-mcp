/**
 * This file contains intentionally duplicated code blocks large enough
 * to trigger the DRY analyzer (minLineThreshold: 15).
 *
 * Each function contains an identical 17-line if_statement block.
 * The DRY analyzer's dedup logic replaces the outer function_declaration
 * with the inner if_statement (nesting rule). Since the if_statement text
 * is identical in both functions, the hashes match and dry/duplicate fires.
 */

export function validateEmail(email: string): boolean {
  const trimmed = email.trim().toLowerCase();
  const parts = trimmed.split('@');

  if (parts.length !== 2) {
    return false;
  }

  // Large identical block — 17 non-empty lines after normalization
  if (trimmed.length > 0 && parts[0].length > 0) {
    const step1 = parts[0].replace(/\./g, '');
    const step2 = step1.replace(/\+/g, '');
    const step3 = step2.toLowerCase();
    const step4 = parts[1].split('.');
    const step5 = step4.length > 1;
    const step6 = step4.map(s => s.length);
    const step7 = step6.filter(n => n > 0);
    const step8 = step7.length >= 2;
    const step9 = step4[step4.length - 1];
    const step10 = step9.length >= 2;
    const step11 = step3.length <= 64;
    const step12 = parts[1].length <= 255;
    const step13 = step5 && step8;
    const step14 = step10 && step11;
    const step15 = step12 && step14;
    const step16 = step13 && step15;
    return step16;
  }

  return false;
}

export function validateUsername(username: string): boolean {
  const trimmed = username.trim().toLowerCase();
  const parts = trimmed.split('-');

  if (parts.length > 3) {
    return false;
  }

  // Large identical block — 17 non-empty lines after normalization
  if (trimmed.length > 0 && parts[0].length > 0) {
    const step1 = parts[0].replace(/\./g, '');
    const step2 = step1.replace(/\+/g, '');
    const step3 = step2.toLowerCase();
    const step4 = parts[1].split('.');
    const step5 = step4.length > 1;
    const step6 = step4.map(s => s.length);
    const step7 = step6.filter(n => n > 0);
    const step8 = step7.length >= 2;
    const step9 = step4[step4.length - 1];
    const step10 = step9.length >= 2;
    const step11 = step3.length <= 64;
    const step12 = parts[1].length <= 255;
    const step13 = step5 && step8;
    const step14 = step10 && step11;
    const step15 = step12 && step14;
    const step16 = step13 && step15;
    return step16;
  }

  return false;
}
