import React, { useState, useEffect, useContext } from 'react';
import { AuthContext } from './contexts/AuthContext';
import { ThemeContext } from './contexts/ThemeContext';
import { AnalyticsContext } from './contexts/AnalyticsContext';

// Edge Case 2: HOC with multiple wrapped components
// Should detect the inner components separately

// Higher Order Component that adds multiple concerns
export function withEnhancement<P extends object>(
  Component: React.ComponentType<P>
): React.ComponentType<P> {
  return function EnhancedComponent(props: P) {
    // Authentication concern
    const { user, login, logout } = useContext(AuthContext);
    
    // Theme concern
    const { theme, toggleTheme } = useContext(ThemeContext);
    
    // Analytics concern
    const { trackEvent } = useContext(AnalyticsContext);
    
    // Local state
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState<Error | null>(null);
    
    // Side effect for tracking
    useEffect(() => {
      trackEvent('component_mounted', {
        componentName: Component.displayName || Component.name,
        userId: user?.id
      });
    }, [trackEvent, user]);
    
    // Data fetching
    useEffect(() => {
      const fetchUserPreferences = async () => {
        setIsLoading(true);
        try {
          const response = await fetch(`/api/preferences/${user?.id}`);
          const data = await response.json();
          // Do something with preferences
        } catch (err) {
          setError(err as Error);
        } finally {
          setIsLoading(false);
        }
      };
      
      if (user) {
        fetchUserPreferences();
      }
    }, [user]);
    
    if (isLoading) return <div>Loading...</div>;
    if (error) return <div>Error: {error.message}</div>;
    
    return <Component {...props} theme={theme} user={user} />;
  };
}

// Component using the HOC
const ProfileCard: React.FC<{ name: string; bio: string }> = ({ name, bio }) => {
  return (
    <div className="profile-card">
      <h2>{name}</h2>
      <p>{bio}</p>
    </div>
  );
};

export const EnhancedProfileCard = withEnhancement(ProfileCard);

// Anonymous function component inside another component
export const ContainerWithInlineComponents: React.FC = () => {
  const [activeTab, setActiveTab] = useState('profile');
  
  // Inline component definition - should be detected separately
  const TabContent = () => {
    const [data, setData] = useState(null);
    const [loading, setLoading] = useState(false);
    
    useEffect(() => {
      // Data fetching inside inline component
      const fetchData = async () => {
        setLoading(true);
        const response = await fetch(`/api/tab/${activeTab}`);
        const result = await response.json();
        setData(result);
        setLoading(false);
      };
      
      fetchData();
    }, []);
    
    // Business logic calculation
    const calculateMetrics = () => {
      if (!data) return 0;
      // Complex calculation
      return Object.values(data).reduce((sum: number, val: any) => sum + val, 0);
    };
    
    return (
      <div>
        {loading ? 'Loading...' : `Metrics: ${calculateMetrics()}`}
      </div>
    );
  };
  
  return (
    <div>
      <div className="tabs">
        <button onClick={() => setActiveTab('profile')}>Profile</button>
        <button onClick={() => setActiveTab('settings')}>Settings</button>
      </div>
      <TabContent />
    </div>
  );
};

// Component factory function
export const createDataTable = (config: { apiEndpoint: string; columns: string[] }) => {
  // This returns a component - should be detected
  return function DataTable() {
    const [data, setData] = useState([]);
    const [sortColumn, setSortColumn] = useState('');
    const [filter, setFilter] = useState('');
    const [page, setPage] = useState(0);
    
    // Data fetching
    useEffect(() => {
      fetch(`${config.apiEndpoint}?page=${page}&sort=${sortColumn}&filter=${filter}`)
        .then(res => res.json())
        .then(setData);
    }, [page, sortColumn, filter]);
    
    // Event handlers
    const handleSort = (column: string) => {
      setSortColumn(column);
      // Analytics tracking
      window.analytics?.track('table_sorted', { column });
    };
    
    const handleFilter = (value: string) => {
      setFilter(value);
      setPage(0); // Reset pagination
    };
    
    return (
      <div className="data-table">
        <input 
          type="text" 
          value={filter} 
          onChange={(e) => handleFilter(e.target.value)}
          placeholder="Filter..."
        />
        <table>
          <thead>
            <tr>
              {config.columns.map(col => (
                <th key={col} onClick={() => handleSort(col)}>
                  {col}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.map((row: any, idx) => (
              <tr key={idx}>
                {config.columns.map(col => (
                  <td key={col}>{row[col]}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        <div className="pagination">
          <button onClick={() => setPage(p => Math.max(0, p - 1))}>Previous</button>
          <span>Page {page + 1}</span>
          <button onClick={() => setPage(p => p + 1)}>Next</button>
        </div>
      </div>
    );
  };
};

// Usage
export const UserTable = createDataTable({
  apiEndpoint: '/api/users',
  columns: ['name', 'email', 'role']
});