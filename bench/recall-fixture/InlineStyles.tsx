// Helper for dynamic style case (style4)
declare function cssVar(name: string): string;

export function TestComponent({ isDark }: { isDark: boolean }) {
  return (
    <>
      {/* 1. Static single-quoted: tokenRef SHOULD be set → guard should skip */}
      <div style={{ color: 'var(--ink)' }} />

      {/* 2. Template literal: parseStyleObjectExpression regex does NOT capture backticks */}
      <div style={{ color: `var(--ink)` }} />

      {/* 3. var() with fallback: extractTokenRef should still capture --ink */}
      <div style={{ color: 'var(--ink, #0ff)' }} />

      {/* 4. Dynamic via helper call: no string literal to match */}
      <div style={{ color: cssVar('--ink') }} />

      {/* 5. Ternary/dynamic: dynamic marker path (tokenRef: null on marker) */}
      <div style={{ color: isDark ? 'var(--ink)' : '#fff' }} />

      {/* 6. MUST FIRE — raw hex on color property where color token exists (Item 3 positive) */}
      <div style={{ color: '#eef4f9' }} />

      {/* 7. MUST NOT FIRE — length value coinciding with non-color token (Item 3 negative) */}
      <div style={{ padding: '6px' }} />
    </>
  );
}
