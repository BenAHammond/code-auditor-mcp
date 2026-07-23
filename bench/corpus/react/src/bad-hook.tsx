import React from 'react';

interface UserProfileProps {
  userId: string;
  role: string;
  permissions: string[];
  theme: 'light' | 'dark' | 'system';
  locale: string;
  view: 'summary' | 'details' | 'settings';
}

/**
 * Complex component exceeding maxComponentComplexity (10).
 * Complexity breakdown: base(1) + 8 if_statements(8) + 3 switch_cases(3) = 12
 */
export function UserProfile({
  userId,
  role,
  permissions,
  theme,
  locale,
  view,
}: UserProfileProps): JSX.Element {
  const [data, setData] = React.useState<any>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    fetch(`/api/users/${userId}`)
      .then((r) => r.json())
      .then((d) => {
        setData(d);
        setLoading(false);
      })
      .catch((e) => {
        setError(e.message);
        setLoading(false);
      });
  }, [userId]);

  // Many conditional branches to increase complexity
  if (loading) {
    if (theme === 'dark') {
      return <div className="loading-dark">Loading...</div>;
    }
    return <div className="loading">Loading...</div>;
  }

  if (error) {
    if (role === 'admin') {
      return <div className="error-admin">Error: {error}</div>;
    }
    return <div className="error">Error: {error}</div>;
  }

  if (!data) {
    return <div>No data found</div>;
  }

  if (role === 'admin') {
    if (permissions.includes('manage_users')) {
      return (
        <div>
          <h1>Admin: {data?.name}</h1>
          <p>Managing users</p>
        </div>
      );
    }
    return (
      <div>
        <h1>Admin: {data?.name}</h1>
        <p>Restricted access</p>
      </div>
    );
  }

  if (theme === 'system' && locale === 'en') {
    return <div>{data?.name} (default)</div>;
  }

  // Switch statement adds 3 complexity points (one per case)
  switch (view) {
    case 'summary':
      return <div className="summary-view">{data?.name}</div>;
    case 'details':
      return <div className="details-view">{data?.name} — {data?.email}</div>;
    case 'settings':
      return <div className="settings-view">Settings for {data?.name}</div>;
  }

  return <div>{data?.name}</div>;
}
