// Test file with deeply nested logic - File 3
// Contains more variations and edge cases

// Complex nested conditional with multiple return paths
export function analyzeDataStructure(data: any): { valid: boolean; depth: number; issues: string[] } {
  const issues: string[] = [];
  let maxDepth = 0;
  
  function checkDepth(obj: any, currentDepth: number): boolean {
    if (currentDepth > maxDepth) {
      maxDepth = currentDepth;
    }
    
    if (obj === null || obj === undefined) {
      return false;
    }
    
    if (typeof obj === 'object') {
      if (Array.isArray(obj)) {
        if (obj.length > 0) {
          for (let i = 0; i < obj.length; i++) {
            if (typeof obj[i] === 'object') {
              if (!checkDepth(obj[i], currentDepth + 1)) {
                issues.push(`Invalid element at index ${i} at depth ${currentDepth}`);
                return false;
              }
            }
          }
        }
      } else {
        const keys = Object.keys(obj);
        if (keys.length > 0) {
          for (const key of keys) {
            if (obj.hasOwnProperty(key)) {
              if (typeof obj[key] === 'object') {
                if (!checkDepth(obj[key], currentDepth + 1)) {
                  issues.push(`Invalid property '${key}' at depth ${currentDepth}`);
                  return false;
                }
              }
            }
          }
        }
      }
    }
    
    return true;
  }
  
  const isValid = checkDepth(data, 0);
  
  return {
    valid: isValid,
    depth: maxDepth,
    issues
  };
}

// EXACT DUPLICATE of fetchAndProcessUserData from nested1.ts with extra nesting
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

// Complex nested loops and conditions
export function findMatchingPatterns(data: any[][], patterns: string[]): Map<string, number[][]> {
  const matches = new Map<string, number[][]>();
  
  for (let i = 0; i < patterns.length; i++) {
    const pattern = patterns[i];
    const patternMatches: number[][] = [];
    
    for (let row = 0; row < data.length; row++) {
      if (data[row]) {
        for (let col = 0; col < data[row].length; col++) {
          if (data[row][col]) {
            if (typeof data[row][col] === 'string') {
              if (data[row][col].includes(pattern)) {
                // Check surrounding cells
                const surroundingMatches = [];
                
                for (let dr = -1; dr <= 1; dr++) {
                  for (let dc = -1; dc <= 1; dc++) {
                    if (dr !== 0 || dc !== 0) {
                      const newRow = row + dr;
                      const newCol = col + dc;
                      
                      if (newRow >= 0 && newRow < data.length) {
                        if (data[newRow] && newCol >= 0 && newCol < data[newRow].length) {
                          if (data[newRow][newCol]) {
                            if (typeof data[newRow][newCol] === 'string') {
                              if (data[newRow][newCol].includes(pattern)) {
                                surroundingMatches.push([newRow, newCol]);
                              }
                            }
                          }
                        }
                      }
                    }
                  }
                }
                
                if (surroundingMatches.length > 0) {
                  patternMatches.push([row, col, ...surroundingMatches.flat()]);
                }
              }
            }
          }
        }
      }
    }
    
    if (patternMatches.length > 0) {
      matches.set(pattern, patternMatches);
    }
  }
  
  return matches;
}

// Recursive function with deep nesting
export function deepClone<T>(obj: T, depth: number = 0, maxDepth: number = 10): T {
  if (depth > maxDepth) {
    throw new Error('Maximum depth exceeded');
  }
  
  if (obj === null || obj === undefined) {
    return obj;
  }
  
  if (obj instanceof Date) {
    return new Date(obj.getTime()) as any;
  }
  
  if (obj instanceof Array) {
    const cloneArr: any[] = [];
    for (let i = 0; i < obj.length; i++) {
      if (typeof obj[i] === 'object') {
        if (obj[i] !== null) {
          if (!(obj[i] instanceof Date)) {
            cloneArr[i] = deepClone(obj[i], depth + 1, maxDepth);
          } else {
            cloneArr[i] = new Date((obj[i] as any).getTime());
          }
        } else {
          cloneArr[i] = null;
        }
      } else {
        cloneArr[i] = obj[i];
      }
    }
    return cloneArr as any;
  }
  
  if (obj instanceof Object) {
    const cloneObj: any = {};
    for (const attr in obj) {
      if (obj.hasOwnProperty(attr)) {
        if (typeof obj[attr] === 'object') {
          if (obj[attr] !== null) {
            if (!(obj[attr] instanceof Date)) {
              if (!(obj[attr] instanceof Array)) {
                cloneObj[attr] = deepClone(obj[attr], depth + 1, maxDepth);
              } else {
                cloneObj[attr] = deepClone(obj[attr], depth + 1, maxDepth);
              }
            } else {
              cloneObj[attr] = new Date((obj[attr] as any).getTime());
            }
          } else {
            cloneObj[attr] = null;
          }
        } else {
          cloneObj[attr] = obj[attr];
        }
      }
    }
    return cloneObj;
  }
  
  return obj;
}