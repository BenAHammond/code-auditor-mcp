import React from 'react';

// True positive: custom hook NOT starting with 'use'
// This function calls built-in React hooks but doesn't follow the naming convention
function fetchUserData(userId: string) {
  const [data, setData] = React.useState<any>(null);
  React.useEffect(() => {
    fetch(`/api/users/${userId}`)
      .then(r => r.json())
      .then(setData);
  }, [userId]);
  return data;
}

interface DashboardProps {
  userId: string;
}

export function Dashboard({ userId }: DashboardProps): JSX.Element {
  // Calling fetchUserData — a function that uses hooks internally
  // but doesn't start with 'use' → triggers hooks-naming
  const userData = fetchUserData(userId);

  return (
    <div>
      <h1>Dashboard</h1>
      <p>{userData?.name}</p>
    </div>
  );
}

// Near-miss: properly named custom hook — does NOT trigger hooks-naming
function useUserDetails(userId: string) {
  const [details, setDetails] = React.useState<any>(null);
  React.useEffect(() => {
    fetch(`/api/details/${userId}`)
      .then(r => r.json())
      .then(setDetails);
  }, [userId]);
  return details;
}

export function UserDetails({ userId }: { userId: string }): JSX.Element {
  const details = useUserDetails(userId);
  return <pre>{JSON.stringify(details, null, 2)}</pre>;
}
