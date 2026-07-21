/**
 * Spec-17 R8 Fixture 17: twenty-methods-vs-complex
 * Report section: R5.1/R5.2 — method-complexity vs class-size
 *
 * A class with 20 small methods (≤5 complexity each) should trigger
 * `solid/class-size` (suggestion) because 20 > classMethodsThreshold (15).
 *
 * A standalone function with cyclomatic complexity > 50 should trigger
 * `solid/method-complexity` (warning) at the shipped default of 50.
 *
 * The method-complexity warning must OUTRANK the class-size suggestion,
 * and the class must appear ONLY under class-size (not method-complexity).
 */

export class DataProcessor {
  m1(n: number): number { return n + 1; }
  m2(n: number): number { return n + 2; }
  m3(n: number): number { return n + 3; }
  m4(n: number): number { return n + 4; }
  m5(n: number): number { return n + 5; }
  m6(n: number): number { return n + 6; }
  m7(n: number): number { return n + 7; }
  m8(n: number): number { return n + 8; }
  m9(n: number): number { return n + 9; }
  m10(n: number): number { return n + 10; }
  m11(n: number): number { return n + 11; }
  m12(n: number): number { return n + 12; }
  m13(n: number): number { return n + 13; }
  m14(n: number): number { return n + 14; }
  m15(n: number): number { return n + 15; }
  m16(n: number): number { return n + 16; }
  m17(n: number): number { return n + 17; }
  m18(n: number): number { return n + 18; }
  m19(n: number): number { return n + 19; }
  m20(n: number): number { return n + 20; }
}

/**
 * Cyclomatic complexity target: > 50 (shipped default for maxMethodComplexity).
 *
 * Strategy: a switch with many case arms (each case is +1) plus ternary
 * expressions and short-circuit || operators to push the count past 50.
 *
 * Switch arms: cases 100-145 = 46 cases → 46 decision points
 * Plus the outer if/else if checks (4 branches) and ternaries (3) and
 * || operators (2) → total > 50.
 */
export function classifyValue(value: number): string {
  // +1: outer if
  if (value < 0) {
    // +1: nested if/else
    if (value < -500) {
      return "critically-low";
    } else {
      return "negative";
    }
  }

  // +1: else-if
  if (value === 0) {
    return "zero";
  }

  // +1: else-if
  if (value > 0 && value <= 145) {
    switch (value) {
      case 1: return "one";
      case 2: return "two";
      case 3: return "three";
      case 4: return "four";
      case 5: return "five";
      case 6: return "six";
      case 7: return "seven";
      case 8: return "eight";
      case 9: return "nine";
      case 10: return "ten";
      case 11: return "eleven";
      case 12: return "twelve";
      case 13: return "thirteen";
      case 14: return "fourteen";
      case 15: return "fifteen";
      case 16: return "sixteen";
      case 17: return "seventeen";
      case 18: return "eighteen";
      case 19: return "nineteen";
      case 20: return "twenty";
      case 21: return "twenty-one";
      case 22: return "twenty-two";
      case 23: return "twenty-three";
      case 24: return "twenty-four";
      case 25: return "twenty-five";
      case 26: return "twenty-six";
      case 27: return "twenty-seven";
      case 28: return "twenty-eight";
      case 29: return "twenty-nine";
      case 30: return "thirty";
      case 31: return "thirty-one";
      case 32: return "thirty-two";
      case 33: return "thirty-three";
      case 34: return "thirty-four";
      case 35: return "thirty-five";
      case 36: return "thirty-six";
      case 37: return "thirty-seven";
      case 38: return "thirty-eight";
      case 39: return "thirty-nine";
      case 40: return "forty";
      case 41: return "forty-one";
      case 42: return "forty-two";
      case 43: return "forty-three";
      case 44: return "forty-four";
      case 45: return "forty-five";
      default: return "range-default";
    }
  }

  // +1: else-if with +1 && (binary_expression with &&)
  if (value > 145 && value < 1000) {
    // +1: ternary, +1: ternary (nested)
    return value % 2 === 0
      ? (value % 10 === 0 ? "large-even-round" : "large-even")
      : "large-odd";
  }

  // +1: else-if with +1 || (binary_expression with ||)
  if (value >= 1000 || value === 999) {
    // +1: nested if
    if (value > 10000) {
      return "huge";
    }
    return "big";
  }

  return "unknown";
}
