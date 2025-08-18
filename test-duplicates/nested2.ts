// Test file with deeply nested logic - File 2
// Contains exact and similar duplicates from nested1.ts

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

// EXACT DUPLICATE: Same complex nested function from nested1.ts
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

// SIMILAR: Slightly modified version with different variable names and minor logic changes
export function processUserRecords(userList: User[]): any[] {
  const results = [];
  
  for (const usr of userList) {
    if (usr && usr.profile) {
      if (usr.profile.personal) {
        if (usr.profile.personal.contact) {
          if (usr.profile.personal.contact.email) {
            // Deep nested processing logic (similar but not identical)
            const domain = usr.profile.personal.contact.email.split('@')[1];
            
            if (domain && domain.indexOf('.') > -1) {
              const validEmail = domain.split('.').length > 1;
              
              if (validEmail) {
                // Even deeper nesting with slight differences
                if (usr.profile.preferences) {
                  if (usr.profile.preferences.notifications) {
                    if (usr.profile.preferences.notifications.email === true) {
                      // Similar data transformation with minor differences
                      const record = {
                        userId: usr.id,
                        name: usr.profile.personal.name 
                          ? `${usr.profile.personal.name.first} ${usr.profile.personal.name.last}`.trim()
                          : 'Anonymous',
                        emailAddress: usr.profile.personal.contact.email.toLowerCase(),
                        userAge: usr.profile.personal.age || 0,
                        hasFullAddress: !!(usr.profile.personal.contact.address 
                          && usr.profile.personal.contact.address.street
                          && usr.profile.personal.contact.address.city
                          && usr.profile.personal.contact.address.state),
                        notificationSettings: {
                          active: true,
                          enabledChannels: Object.entries(usr.profile.preferences.notifications)
                            .filter(([_, active]) => active === true)
                            .map(([type]) => type)
                        },
                        privacy: usr.profile.preferences.privacy?.profileVisibility || 'private',
                        userPermissions: usr.permissions?.filter(perm => perm.indexOf('user:') === 0) || []
                      };
                      
                      // Similar validation with different threshold
                      if (record.userAge > 17) {
                        if (record.userPermissions.length >= 1) {
                          results.push(record);
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
  
  return results;
}

// Another deeply nested function with switch statements
export function categorizeUserByDepth(user: User): string {
  if (user) {
    if (user.profile) {
      if (user.profile.personal) {
        switch (true) {
          case user.profile.personal.age < 18:
            if (user.permissions) {
              switch (user.permissions.length) {
                case 0:
                  return 'minor-no-permissions';
                case 1:
                case 2:
                  if (user.profile.preferences) {
                    if (user.profile.preferences.privacy) {
                      switch (user.profile.preferences.privacy.profileVisibility) {
                        case 'public':
                          return 'minor-limited-public';
                        case 'private':
                          return 'minor-limited-private';
                        default:
                          return 'minor-limited-friends';
                      }
                    }
                  }
                  return 'minor-limited';
                default:
                  return 'minor-elevated';
              }
            }
            return 'minor-unknown';
            
          case user.profile.personal.age >= 65:
            if (user.permissions) {
              if (user.permissions.some(p => p.startsWith('admin:'))) {
                if (user.profile.preferences) {
                  if (user.profile.preferences.notifications) {
                    if (Object.values(user.profile.preferences.notifications).every(n => n)) {
                      return 'senior-admin-all-notifications';
                    }
                  }
                }
                return 'senior-admin';
              }
            }
            return 'senior-regular';
            
          default:
            return 'adult-regular';
        }
      }
    }
  }
  
  return 'unknown';
}