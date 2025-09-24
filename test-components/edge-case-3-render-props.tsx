import React, { useState, useEffect, ReactNode } from 'react';
import { useRouter } from 'next/router';

// Edge Case 3: Render prop patterns and compound components
// Should handle render props without false positives

// Render prop component for data fetching
interface DataFetcherProps<T> {
  url: string;
  children: (data: {
    data: T | null;
    loading: boolean;
    error: Error | null;
    refetch: () => void;
  }) => ReactNode;
}

export function DataFetcher<T>({ url, children }: DataFetcherProps<T>) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  
  const fetchData = async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error('Failed to fetch');
      const result = await response.json();
      setData(result);
    } catch (err) {
      setError(err as Error);
    } finally {
      setLoading(false);
    }
  };
  
  useEffect(() => {
    fetchData();
  }, [url]);
  
  return <>{children({ data, loading, error, refetch: fetchData })}</>;
}

// Component using render props - mixed responsibilities
export const UserDashboardWithRenderProps: React.FC = () => {
  const router = useRouter();
  const [selectedUser, setSelectedUser] = useState<string | null>(null);
  const [isModalOpen, setIsModalOpen] = useState(false);
  
  // Business logic
  const calculateUserScore = (user: any) => {
    return user.posts * 10 + user.comments * 5 + user.likes;
  };
  
  // Navigation handler
  const navigateToUser = (userId: string) => {
    router.push(`/users/${userId}`);
  };
  
  // Modal handlers
  const openUserModal = (userId: string) => {
    setSelectedUser(userId);
    setIsModalOpen(true);
    // Track analytics
    window.analytics?.track('user_modal_opened', { userId });
  };
  
  return (
    <div className="dashboard">
      <h1>User Dashboard</h1>
      
      <DataFetcher<any[]> url="/api/users">
        {({ data: users, loading, error, refetch }) => {
          if (loading) return <div>Loading users...</div>;
          if (error) return <div>Error: {error.message}</div>;
          if (!users) return null;
          
          return (
            <>
              <button onClick={refetch}>Refresh Users</button>
              <div className="user-grid">
                {users.map(user => (
                  <div key={user.id} className="user-card">
                    <h3>{user.name}</h3>
                    <p>Score: {calculateUserScore(user)}</p>
                    <button onClick={() => openUserModal(user.id)}>
                      View Details
                    </button>
                    <button onClick={() => navigateToUser(user.id)}>
                      Go to Profile
                    </button>
                  </div>
                ))}
              </div>
            </>
          );
        }}
      </DataFetcher>
      
      {isModalOpen && selectedUser && (
        <DataFetcher<any> url={`/api/users/${selectedUser}`}>
          {({ data: userDetails, loading }) => (
            <div className="modal">
              {loading ? (
                <div>Loading user details...</div>
              ) : (
                <div>
                  <h2>{userDetails?.name}</h2>
                  <p>{userDetails?.email}</p>
                  <button onClick={() => setIsModalOpen(false)}>Close</button>
                </div>
              )}
            </div>
          )}
        </DataFetcher>
      )}
    </div>
  );
};

// Compound component pattern
interface TabsContextValue {
  activeTab: string;
  setActiveTab: (tab: string) => void;
}

const TabsContext = React.createContext<TabsContextValue | undefined>(undefined);

export const Tabs: React.FC<{ children: ReactNode; defaultTab: string }> & {
  Tab: typeof Tab;
  TabPanel: typeof TabPanel;
} = ({ children, defaultTab }) => {
  const [activeTab, setActiveTab] = useState(defaultTab);
  
  // Analytics tracking for tabs
  useEffect(() => {
    window.analytics?.track('tab_changed', { tab: activeTab });
  }, [activeTab]);
  
  return (
    <TabsContext.Provider value={{ activeTab, setActiveTab }}>
      <div className="tabs">{children}</div>
    </TabsContext.Provider>
  );
};

const Tab: React.FC<{ id: string; children: ReactNode }> = ({ id, children }) => {
  const context = React.useContext(TabsContext);
  if (!context) throw new Error('Tab must be used within Tabs');
  
  const { activeTab, setActiveTab } = context;
  
  return (
    <button
      className={activeTab === id ? 'active' : ''}
      onClick={() => setActiveTab(id)}
    >
      {children}
    </button>
  );
};

const TabPanel: React.FC<{ id: string; children: ReactNode }> = ({ id, children }) => {
  const context = React.useContext(TabsContext);
  if (!context) throw new Error('TabPanel must be used within Tabs');
  
  const { activeTab } = context;
  
  if (activeTab !== id) return null;
  
  return <div className="tab-panel">{children}</div>;
};

Tabs.Tab = Tab;
Tabs.TabPanel = TabPanel;

// Component with function-as-child pattern
interface ToggleProps {
  defaultOn?: boolean;
  children: (props: {
    on: boolean;
    toggle: () => void;
    setOn: (value: boolean) => void;
  }) => ReactNode;
}

export const Toggle: React.FC<ToggleProps> = ({ defaultOn = false, children }) => {
  const [on, setOn] = useState(defaultOn);
  
  const toggle = () => setOn(prev => !prev);
  
  return <>{children({ on, toggle, setOn })}</>;
};

// Usage example with mixed concerns
export const SettingsPageWithToggle: React.FC = () => {
  const [settings, setSettings] = useState({});
  const [isSaving, setIsSaving] = useState(false);
  
  // Save settings to API
  const saveSettings = async (newSettings: any) => {
    setIsSaving(true);
    try {
      await fetch('/api/settings', {
        method: 'POST',
        body: JSON.stringify(newSettings)
      });
      setSettings(newSettings);
    } catch (error) {
      console.error('Failed to save settings', error);
    } finally {
      setIsSaving(false);
    }
  };
  
  return (
    <div className="settings-page">
      <h1>Settings</h1>
      
      <Toggle defaultOn={false}>
        {({ on, toggle }) => (
          <div className="setting-item">
            <label>
              <input type="checkbox" checked={on} onChange={toggle} />
              Enable notifications
            </label>
            {on && (
              <div className="notification-options">
                <input type="text" placeholder="Email for notifications" />
                <button onClick={() => saveSettings({ notifications: { enabled: true } })}>
                  Save
                </button>
              </div>
            )}
          </div>
        )}
      </Toggle>
      
      {isSaving && <div>Saving settings...</div>}
    </div>
  );
};