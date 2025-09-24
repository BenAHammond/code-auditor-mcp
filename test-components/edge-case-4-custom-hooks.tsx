import React, { useState, useEffect, useCallback, useRef } from 'react';

// Edge Case 4: Custom hooks and hook composition
// Should analyze components using custom hooks properly

// Custom hook with mixed responsibilities (anti-pattern)
export const useUserDashboard = (userId: string) => {
  // Data fetching
  const [user, setUser] = useState(null);
  const [posts, setPosts] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  
  // UI state
  const [selectedPost, setSelectedPost] = useState<string | null>(null);
  const [isEditMode, setIsEditMode] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  
  // Form state
  const [formData, setFormData] = useState({});
  const [validationErrors, setValidationErrors] = useState({});
  
  // Business logic
  const calculateEngagement = useCallback(() => {
    if (!posts.length) return 0;
    const totalLikes = posts.reduce((sum: number, post: any) => sum + post.likes, 0);
    const totalComments = posts.reduce((sum: number, post: any) => sum + post.comments, 0);
    return totalLikes * 2 + totalComments * 3;
  }, [posts]);
  
  // Analytics tracking
  useEffect(() => {
    window.analytics?.track('dashboard_viewed', {
      userId,
      timestamp: Date.now()
    });
  }, [userId]);
  
  // Data fetching
  useEffect(() => {
    const fetchData = async () => {
      setIsLoading(true);
      try {
        const [userRes, postsRes] = await Promise.all([
          fetch(`/api/users/${userId}`),
          fetch(`/api/users/${userId}/posts`)
        ]);
        
        setUser(await userRes.json());
        setPosts(await postsRes.json());
      } catch (error) {
        console.error('Failed to fetch data', error);
      } finally {
        setIsLoading(false);
      }
    };
    
    fetchData();
  }, [userId]);
  
  // WebSocket connection for real-time updates
  useEffect(() => {
    const ws = new WebSocket(`ws://localhost:3000/users/${userId}`);
    
    ws.onmessage = (event) => {
      const update = JSON.parse(event.data);
      if (update.type === 'new_post') {
        setPosts(prev => [...prev, update.post]);
      }
    };
    
    return () => ws.close();
  }, [userId]);
  
  return {
    // Data
    user,
    posts,
    isLoading,
    // UI State
    selectedPost,
    setSelectedPost,
    isEditMode,
    setIsEditMode,
    sidebarOpen,
    setSidebarOpen,
    // Form
    formData,
    setFormData,
    validationErrors,
    // Computed
    engagement: calculateEngagement()
  };
};

// Component using the problematic hook
export const ProblematicDashboard: React.FC<{ userId: string }> = ({ userId }) => {
  const dashboard = useUserDashboard(userId);
  
  if (dashboard.isLoading) return <div>Loading...</div>;
  
  return (
    <div className="dashboard">
      <h1>{dashboard.user?.name}'s Dashboard</h1>
      <p>Engagement Score: {dashboard.engagement}</p>
      {/* Rest of the UI */}
    </div>
  );
};

// Well-structured custom hooks (good pattern)
export const useUser = (userId: string) => {
  const [user, setUser] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  
  useEffect(() => {
    fetch(`/api/users/${userId}`)
      .then(res => res.json())
      .then(setUser)
      .finally(() => setIsLoading(false));
  }, [userId]);
  
  return { user, isLoading };
};

export const usePosts = (userId: string) => {
  const [posts, setPosts] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  
  useEffect(() => {
    fetch(`/api/users/${userId}/posts`)
      .then(res => res.json())
      .then(setPosts)
      .finally(() => setIsLoading(false));
  }, [userId]);
  
  return { posts, isLoading };
};

// Component with composed hooks (good pattern)
export const WellStructuredDashboard: React.FC<{ userId: string }> = ({ userId }) => {
  const { user, isLoading: userLoading } = useUser(userId);
  const { posts, isLoading: postsLoading } = usePosts(userId);
  
  const engagement = posts.reduce((sum: number, post: any) => 
    sum + post.likes * 2 + post.comments * 3, 0
  );
  
  if (userLoading || postsLoading) return <div>Loading...</div>;
  
  return (
    <div className="dashboard">
      <h1>{user?.name}'s Dashboard</h1>
      <p>Engagement Score: {engagement}</p>
    </div>
  );
};

// Component with inline hook logic (should detect mixed responsibilities)
export const ComponentWithInlineHooks: React.FC = () => {
  // Authentication check
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  
  useEffect(() => {
    fetch('/api/auth/check')
      .then(res => res.json())
      .then(data => setIsAuthenticated(data.authenticated));
  }, []);
  
  // Theme management
  const [theme, setTheme] = useState('light');
  
  useEffect(() => {
    const savedTheme = localStorage.getItem('theme');
    if (savedTheme) setTheme(savedTheme);
  }, []);
  
  const toggleTheme = () => {
    const newTheme = theme === 'light' ? 'dark' : 'light';
    setTheme(newTheme);
    localStorage.setItem('theme', newTheme);
    // Analytics
    window.analytics?.track('theme_changed', { theme: newTheme });
  };
  
  // Data fetching
  const [data, setData] = useState(null);
  
  useEffect(() => {
    if (isAuthenticated) {
      fetch('/api/data')
        .then(res => res.json())
        .then(setData);
    }
  }, [isAuthenticated]);
  
  // Timer functionality
  const [seconds, setSeconds] = useState(0);
  const intervalRef = useRef<NodeJS.Timeout>();
  
  useEffect(() => {
    intervalRef.current = setInterval(() => {
      setSeconds(s => s + 1);
    }, 1000);
    
    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
      }
    };
  }, []);
  
  return (
    <div className={`app ${theme}`}>
      <button onClick={toggleTheme}>Toggle Theme</button>
      <p>Time: {seconds}s</p>
      {data && <div>{JSON.stringify(data)}</div>}
    </div>
  );
};

// Hook composition with conditional logic
export const ConditionalHookComponent: React.FC<{ mode: 'view' | 'edit' }> = ({ mode }) => {
  // Common state
  const [data, setData] = useState(null);
  
  // Conditional hook usage based on mode
  if (mode === 'edit') {
    // Form validation hooks
    const [errors, setErrors] = useState({});
    const [isDirty, setIsDirty] = useState(false);
    
    // Auto-save functionality
    useEffect(() => {
      if (isDirty) {
        const timer = setTimeout(() => {
          // Auto-save logic
          console.log('Auto-saving...');
        }, 5000);
        
        return () => clearTimeout(timer);
      }
    }, [isDirty, data]);
  }
  
  // Data fetching (common to both modes)
  useEffect(() => {
    fetch('/api/data')
      .then(res => res.json())
      .then(setData);
  }, []);
  
  return (
    <div>
      {mode === 'view' ? (
        <div>View Mode: {JSON.stringify(data)}</div>
      ) : (
        <div>Edit Mode - with auto-save</div>
      )}
    </div>
  );
};