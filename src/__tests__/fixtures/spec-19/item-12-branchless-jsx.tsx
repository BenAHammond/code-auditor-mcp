/**
 * Spec-19 item 12 — method-complexity false positive.
 * Branchless JSX presentational component, ~40 lines.
 * Zero conditionals, loops, or branches.
 * The violation should NOT fire: complexity is 1, threshold is 50.
 *
 * Uses React.createElement to avoid JSX compilation in test fixtures.
 * All logic is pure data lookup; no ternaries, no if/else, no &&/||.
 */

import React from 'react';

interface Metric {
  label: string;
  value: number;
  unit: string;
  trend: 'up' | 'down' | 'flat';
}

const TREND_SYMBOLS: Record<string, string> = {
  up: '▲',
  down: '▼',
  flat: '—',
};

interface MetricCardProps {
  metric: Metric;
  className?: string;
}

/**
 * MetricCard — presentational component.
 * Displays a single metric value with label, unit, and trend indicator.
 * Pure layout, no branching logic.
 */
export function MetricCard({ metric, className }: MetricCardProps) {
  const wrapperClass = 'metric-card ' + (className ?? '');

  const headerEl = React.createElement(
    'div',
    { className: 'metric-card__header' },
    React.createElement('span', { className: 'metric-card__label' }, metric.label)
  );

  const bodyEl = React.createElement(
    'div',
    { className: 'metric-card__body' },
    React.createElement('span', { className: 'metric-card__value' }, String(metric.value)),
    React.createElement('span', { className: 'metric-card__unit' }, metric.unit)
  );

  const trendClass = 'metric-card__trend metric-card__trend--' + metric.trend;

  const footerEl = React.createElement(
    'div',
    { className: 'metric-card__footer' },
    React.createElement(
      'span',
      { className: trendClass },
      TREND_SYMBOLS[metric.trend]
    )
  );

  return React.createElement('div', { className: wrapperClass }, headerEl, bodyEl, footerEl);
}

export default MetricCard;
