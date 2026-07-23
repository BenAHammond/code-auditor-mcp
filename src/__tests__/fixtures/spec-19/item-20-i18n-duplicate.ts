/**
 * Spec-19 item 20 — dry/duplicate true positive.
 * Two token-identical i18n label assembly blocks ≥15 lines each.
 * Verdict: TRUE — extract a shared label builder.
 *
 * Uses for-loops (significant blocks extracted by isSignificantBlock)
 * with identical bodies to guarantee token-hash match.
 */

interface TranslationMap {
  [key: string]: string;
}

export function buildAllLabels(): TranslationMap {
  const labels: TranslationMap = {};

  // Block A — i18n assembly (token-identical to Block B)
  for (let i = 0; i < 1; i++) {
    const pad1 = 'p1';
    const pad2 = 'p2';
    const pad3 = 'p3';
    const pad4 = 'p4';
    labels['nav.home'] = 'Home';
    labels['nav.settings'] = 'Settings';
    labels['nav.profile'] = 'Profile';
    labels['nav.logout'] = 'Log Out';
    labels['page.title'] = 'Dashboard';
    labels['page.subtitle'] = 'Overview of your account';
    labels['page.loading'] = 'Loading data...';
    labels['page.error'] = 'Failed to load data';
    labels['page.retry'] = 'Retry';
  }

  // Block B — token-identical to Block A
  for (let i = 0; i < 1; i++) {
    const pad1 = 'p1';
    const pad2 = 'p2';
    const pad3 = 'p3';
    const pad4 = 'p4';
    labels['nav.home'] = 'Home';
    labels['nav.settings'] = 'Settings';
    labels['nav.profile'] = 'Profile';
    labels['nav.logout'] = 'Log Out';
    labels['page.title'] = 'Dashboard';
    labels['page.subtitle'] = 'Overview of your account';
    labels['page.loading'] = 'Loading data...';
    labels['page.error'] = 'Failed to load data';
    labels['page.retry'] = 'Retry';
  }

  return labels;
}
