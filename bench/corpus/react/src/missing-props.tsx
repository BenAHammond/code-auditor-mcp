import React from 'react';

// True positive: component without props validation → triggers missing-props
// Uses non-destructured `props` parameter — extractPropTypes won't find props,
// so hasPropsValidation returns false.
export function AlertBanner(props: any): JSX.Element {
  return (
    <div className={`alert alert-${props.type}`}>
      <strong>{props.type}:</strong> {props.message}
    </div>
  );
}

// Near-miss: component WITH props interface — does NOT trigger missing-props
interface StatusBadgeProps {
  status: 'online' | 'offline' | 'away';
}

export function StatusBadge({ status }: StatusBadgeProps): JSX.Element {
  return <span className={`badge badge-${status}`}>{status}</span>;
}
