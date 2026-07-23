import React from 'react';

/**
 * Simple component — well below complexity threshold (10).
 */
export function UserCard({ userId }: { userId: string }): JSX.Element {
  const [data, setData] = React.useState<any>(null);

  React.useEffect(() => {
    fetch(`/api/users/${userId}`)
      .then((r) => r.json())
      .then((d) => setData(d));
  }, [userId]);

  if (!data) return <span>Loading...</span>;
  return <span>{data?.name}</span>;
}
