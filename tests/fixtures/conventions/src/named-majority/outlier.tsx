/**
 * OUTLIER — uses `export default` function in a directory where the
 * convention is named exports (20 named exports from utils.ts).
 *
 * This should trigger: conventions/export-shape
 */

export default function OutlierComponent(): string {
  return 'I use default export — I violate the named-export convention';
}
