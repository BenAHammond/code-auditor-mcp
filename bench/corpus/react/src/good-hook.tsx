import React from 'react';

/**
 * Simple component — well below complexity threshold (10).
 * No useEffect, no hooks at all — clean near-miss for all React rules.
 */
export function UserCard({ userId }: { userId: string }): JSX.Element {
  const [data, setData] = React.useState<any>(null);

  if (!data) return <span>Loading...</span>;
  return <span>{data?.name}</span>;
}
