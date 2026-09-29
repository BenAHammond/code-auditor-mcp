/**
 * Spec 69 R4 — the CIELAB color conversion, re-homed out of the
 * `styles/value-drift` rule body into a shared module.
 *
 * The move is the one placement correction R4 named: `value-drift` was the only
 * migrated rule whose body still *computed* a derived value — parsing a raw
 * color string to sRGB and converting it to CIELAB Lab. That conversion is a
 * pure, threshold-independent derivation from the raw declaration value, exactly
 * the "one level up from raw source text" computation a processor should own.
 *
 * These three functions are the conversion (`parseColorToRGB`, `rgbToLab`) plus
 * the ΔE76 distance over Lab (`labDistance`). The `color-values` corpus producer
 * (`producers.ts`) imports the conversion and stores the Lab triple in the fact;
 * the rule imports only `labDistance` — the comparison metric its clustering and
 * flagging decisions use — so it reads pre-computed Lab and never re-parses a
 * color. The rule decides; the processor computes.
 */

/** A CIELAB Lab triple (L, a, b), D65 reference white. */
export type Lab = [number, number, number];

/** A sRGB triple, each channel in [0, 255]. */
export type RGB = [number, number, number];

const COLOR_KEYWORDS = new Set([
  'transparent', 'currentcolor', 'inherit', 'initial', 'unset', 'none',
]);

/** sRGB → CIELAB Lab (D65), the same transform `value-drift` ran in its body.
 *
 * @param rgb The sRGB triple, each channel in [0, 255].
 * @returns The CIELAB Lab triple (L, a, b).
 */
export function rgbToLab([r, g, b]: RGB): Lab {
  const linear = (c: number): number => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  const lr = linear(r);
  const lg = linear(g);
  const lb = linear(b);

  const x = lr * 0.4124564 + lg * 0.3575761 + lb * 0.1804375;
  const y = lr * 0.2126729 + lg * 0.7151522 + lb * 0.0721750;
  const z = lr * 0.0193339 + lg * 0.1191920 + lb * 0.9503041;

  const XN = 0.95047;
  const YN = 1.0;
  const ZN = 1.08883;
  const EPSILON = 0.008856;
  const KAPPA = 903.3;
  const f = (t: number): number =>
    t > EPSILON ? Math.cbrt(t) : (KAPPA * t + 16) / 116;
  const fx = f(x / XN);
  const fy = f(y / YN);
  const fz = f(z / ZN);

  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/** Raw color string → sRGB, or null when it is not a parseable color.
 *
 * @param raw The raw color string (hex, `rgb()`, or a keyword).
 * @returns The sRGB triple, or null when the string is not a parseable color.
 */
export function parseColorToRGB(raw: string): RGB | null {
  try {
    let v = raw.toLowerCase().trim();

    if (COLOR_KEYWORDS.has(v)) return null;

    if (v.startsWith('#')) {
      if (v.length === 4) {
        v = '#' + v[1] + v[1] + v[2] + v[2] + v[3] + v[3];
      }
      if (v.length === 7) {
        return [
          parseInt(v.slice(1, 3), 16),
          parseInt(v.slice(3, 5), 16),
          parseInt(v.slice(5, 7), 16),
        ];
      }
      if (v.length === 9) {
        return [
          parseInt(v.slice(1, 3), 16),
          parseInt(v.slice(3, 5), 16),
          parseInt(v.slice(5, 7), 16),
        ];
      }
    }

    const rgbMatch = v.match(/rgb\(\s*(\d+)\s*,?\s*(\d+)\s*,?\s*(\d+)\s*\)/);
    if (rgbMatch) {
      return [
        parseInt(rgbMatch[1]),
        parseInt(rgbMatch[2]),
        parseInt(rgbMatch[3]),
      ];
    }

    const named: Record<string, RGB> = {
      'white': [255, 255, 255], 'black': [0, 0, 0],
      'red': [255, 0, 0], 'blue': [0, 0, 255], 'green': [0, 128, 0],
    };
    if (named[v]) return named[v];

    return null;
  } catch {
    return null;
  }
}

/** ΔE76 — the Euclidean distance between two Lab triples.
 *
 * @param a The first Lab triple.
 * @param b The second Lab triple.
 * @returns The ΔE76 color distance.
 */
export function labDistance(a: Lab, b: Lab): number {
  const dl = a[0] - b[0];
  const da = a[1] - b[1];
  const db = a[2] - b[2];
  return Math.sqrt(dl * dl + da * da + db * db);
}
