/**
 * Test file for Bug 6: SRP (Single Responsibility Principle) false positives
 * Components that should and shouldn't trigger SRP violations
 */

import React, { useState, useEffect } from 'react';
import { fetchUser, updateUser } from './api';
import { validateEmail, formatDate } from './utils';

// Component with SINGLE responsibility - should NOT trigger SRP violation
export const UserAvatar: React.FC<{ userId: string }> = ({ userId }) => {
  const [imageUrl, setImageUrl] = useState<string>('');
  
  useEffect(() => {
    // Only handles avatar display logic
    setImageUrl(`/api/avatars/${userId}`);
  }, [userId]);
  
  return (
    <img 
      src={imageUrl} 
      alt="User avatar"
      className="avatar"
      onError={(e) => {
        e.currentTarget.src = '/default-avatar.png';
      }}
    />
  );
};

// Component with MULTIPLE unrelated responsibilities - SHOULD trigger SRP violation
export const UserProfileManager: React.FC<{ userId: string }> = ({ userId }) => {
  // State management responsibility
  const [user, setUser] = useState<any>(null);
  const [posts, setPosts] = useState<any[]>([]);
  const [stats, setStats] = useState<any>(null);
  
  // Data fetching responsibility
  useEffect(() => {
    fetchUser(userId).then(setUser);
    fetchUserPosts(userId).then(setPosts);
    fetchUserStats(userId).then(setStats);
  }, [userId]);
  
  // Form handling responsibility
  const handleUpdateProfile = (data: any) => {
    updateUser(userId, data);
  };
  
  // Email validation responsibility
  const handleEmailChange = (email: string) => {
    if (validateEmail(email)) {
      setUser({ ...user, email });
    }
  };
  
  // Analytics responsibility
  const trackProfileView = () => {
    analytics.track('profile_viewed', { userId });
  };
  
  // Rendering multiple unrelated sections
  return (
    <div>
      {/* Profile section */}
      <section>
        <h2>Profile</h2>
        <form onSubmit={handleUpdateProfile}>
          <input onChange={(e) => handleEmailChange(e.target.value)} />
        </form>
      </section>
      
      {/* Posts section - unrelated to profile */}
      <section>
        <h2>Posts</h2>
        {posts.map(post => <div key={post.id}>{post.title}</div>)}
      </section>
      
      {/* Stats section - unrelated to profile and posts */}
      <section>
        <h2>Statistics</h2>
        <div>Total views: {stats?.views}</div>
        <div>Join date: {formatDate(stats?.joinDate)}</div>
      </section>
    </div>
  );
};

// Component with related responsibilities - should NOT trigger SRP
export const UserForm: React.FC<{ onSubmit: (data: any) => void }> = ({ onSubmit }) => {
  const [formData, setFormData] = useState({
    name: '',
    email: '',
    country: ''
  });
  
  // All these handle form-related concerns
  const handleChange = (field: string, value: string) => {
    setFormData({ ...formData, [field]: value });
  };
  
  const handleValidation = () => {
    return formData.name && validateEmail(formData.email);
  };
  
  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (handleValidation()) {
      onSubmit(formData);
    }
  };
  
  // Single cohesive rendering responsibility
  return (
    <form onSubmit={handleSubmit}>
      <input 
        value={formData.name}
        onChange={(e) => handleChange('name', e.target.value)}
      />
      <input 
        value={formData.email}
        onChange={(e) => handleChange('email', e.target.value)}
      />
      <button type="submit">Submit</button>
    </form>
  );
};

// Mock functions
async function fetchUserPosts(userId: string) {
  return [];
}

async function fetchUserStats(userId: string) {
  return { views: 0, joinDate: new Date() };
}

const analytics = {
  track: (event: string, data: any) => {}
};