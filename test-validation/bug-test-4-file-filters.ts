/**
 * Test file for Bug 4: File filter functionality
 * This file should be found with various filter patterns
 */

// Test exact file match: file:"bug-test-4-file-filters.ts"
export function testExactFileMatch() {
  return 'This function should be found with exact file filter';
}

// Test directory filter: file:"test-validation"
export function testDirectoryFilter() {
  return 'This function should be found when filtering by directory';
}

// Test glob pattern: file:"**/bug-test-4-*.ts"
export function testGlobPattern() {
  return 'This function should be found with glob patterns';
}

// Test partial match: file:"file-filters"
export function testPartialMatch() {
  return 'This function should be found with partial file name';
}

// Combined with other searches
export function validateUserCountry(user: any) {
  // Should find this with: country file:"test-validation"
  if (!user.country) {
    throw new Error('User country is required');
  }
  
  // Should also work with: file:"bug-test-4" "validate"
  return {
    isValid: true,
    country: user.country
  };
}

// Multiple filter test
export async function processRegionalData(region: string, data: any[]) {
  // Test combining filters: 
  // 1. file:"test-validation/bug-test-4"
  // 2. "regional" 
  // 3. async
  
  const results = [];
  for (const item of data) {
    if (item.region === region) {
      results.push({
        ...item,
        processed: true,
        timestamp: new Date()
      });
    }
  }
  
  return results;
}