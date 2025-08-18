// Test file with deeply nested logic - File 1

interface User {
  id: string;
  profile: {
    personal: {
      name: {
        first: string;
        last: string;
        middle?: string;
      };
      age: number;
      contact: {
        email: string;
        phone?: string;
        address?: {
          street: string;
          city: string;
          state: string;
          zip: string;
        };
      };
    };
    preferences: {
      notifications: {
        email: boolean;
        sms: boolean;
        push: boolean;
      };
      privacy: {
        profileVisibility: 'public' | 'private' | 'friends';
        dataSharing: boolean;
      };
    };
  };
  permissions: string[];
}

// Complex nested function that will be duplicated
export function processUserData(users: User[]): any[] {
  const processedUsers = [];
  
  for (const user of users) {
    if (user && user.profile) {
      if (user.profile.personal) {
        if (user.profile.personal.contact) {
          if (user.profile.personal.contact.email) {
            // Deep nested processing logic
            const emailDomain = user.profile.personal.contact.email.split('@')[1];
            
            if (emailDomain && emailDomain.includes('.')) {
              const isValidEmail = emailDomain.split('.').length >= 2;
              
              if (isValidEmail) {
                // Even deeper nesting
                if (user.profile.preferences) {
                  if (user.profile.preferences.notifications) {
                    if (user.profile.preferences.notifications.email) {
                      // Complex data transformation
                      const processedUser = {
                        id: user.id,
                        fullName: user.profile.personal.name 
                          ? `${user.profile.personal.name.first} ${user.profile.personal.name.last}`.trim()
                          : 'Unknown',
                        email: user.profile.personal.contact.email.toLowerCase(),
                        age: user.profile.personal.age || 0,
                        hasAddress: !!(user.profile.personal.contact.address 
                          && user.profile.personal.contact.address.street
                          && user.profile.personal.contact.address.city),
                        notifications: {
                          enabled: true,
                          channels: Object.entries(user.profile.preferences.notifications)
                            .filter(([_, enabled]) => enabled)
                            .map(([channel]) => channel)
                        },
                        privacyLevel: user.profile.preferences.privacy?.profileVisibility || 'private',
                        permissions: user.permissions?.filter(p => p.startsWith('user:')) || []
                      };
                      
                      // Additional nested validation
                      if (processedUser.age >= 18) {
                        if (processedUser.permissions.length > 0) {
                          processedUsers.push(processedUser);
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
  
  return processedUsers;
}

// Another complex nested function with similar structure
export function validateUserAccess(user: User, resource: string): boolean {
  if (user && user.profile) {
    if (user.profile.personal) {
      if (user.profile.personal.age >= 18) {
        if (user.permissions && user.permissions.length > 0) {
          for (const permission of user.permissions) {
            if (permission.startsWith('admin:')) {
              return true;
            }
            
            if (permission === `resource:${resource}:read`) {
              if (user.profile.preferences) {
                if (user.profile.preferences.privacy) {
                  if (user.profile.preferences.privacy.dataSharing) {
                    return true;
                  }
                }
              }
            }
          }
        }
      }
    }
  }
  
  return false;
}

// Deeply nested async function
export async function fetchAndProcessUserData(userIds: string[]): Promise<any[]> {
  const results = [];
  
  for (const userId of userIds) {
    try {
      const response = await fetch(`/api/users/${userId}`);
      
      if (response && response.ok) {
        const userData = await response.json();
        
        if (userData && userData.data) {
          if (userData.data.user) {
            if (userData.data.user.active) {
              if (userData.data.user.verified) {
                // Nested data processing
                const processed = {
                  id: userData.data.user.id,
                  status: 'active',
                  lastLogin: userData.data.user.lastLogin
                    ? new Date(userData.data.user.lastLogin)
                    : null,
                  metadata: userData.data.user.metadata
                    ? Object.keys(userData.data.user.metadata)
                        .filter(key => key.startsWith('public_'))
                        .reduce((acc, key) => {
                          acc[key] = userData.data.user.metadata[key];
                          return acc;
                        }, {} as any)
                    : {}
                };
                
                results.push(processed);
              }
            }
          }
        }
      }
    } catch (error) {
      console.error(`Failed to fetch user ${userId}:`, error);
    }
  }
  
  return results;
}