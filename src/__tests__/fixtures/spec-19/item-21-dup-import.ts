/**
 * Spec-19 item 21 — duplicate-import useless positive.
 * Same import line from 2 sibling components (react imported twice).
 * Verdict: USELESS — cross-file import sharing is how ES modules work.
 * duplicate-import is retired (checkImports: false). Produces 0 violations.
 */

import { useState } from 'react';

import { useEffect } from 'react';

import { z } from 'zod';

export function FormInput({ label }: { label: string }) {
  const [value, setValue] = useState('');
  useEffect(() => { setValue(''); }, [label]);
  const schema = z.string().min(1);
  return { value, schema };
}
