/**
 * Test file for Bug 5: Match context in search results
 * Tests that surrounding lines are included with matches
 */

export function demonstrateMatchContext() {
  // Line before the match
  const settings = loadSettings();
  // This line contains the search term: country
  const userCountry = settings.country || 'US';
  // Line after the match
  const locale = `${settings.language}-${userCountry}`;
  
  // Another match further down
  console.log('Initializing application...');
  console.log('Loading configuration...');
  console.log(`User country detected: ${userCountry}`);
  console.log('Configuration loaded successfully');
  console.log('Starting main application...');
  
  return {
    locale,
    country: userCountry,
    settings
  };
}

// Function with multiple matches on the same line
export function parseLocationString(location: string) {
  // Multiple matches on one line - context should handle this
  // Format: "city, state, country" or "city, country"
  const parts = location.split(',').map(s => s.trim());
  
  if (parts.length === 3) {
    // Has state/province
    return {
      city: parts[0],
      state: parts[1],
      country: parts[2]  // First country match
    };
  } else if (parts.length === 2) {
    // No state/province  
    return {
      city: parts[0],
      country: parts[1]  // Second country match
    };
  }
  
  // Fallback parsing
  return {
    city: location,
    country: 'Unknown'  // Third country match
  };
}

// Function with matches at function boundaries
export function startOfFunction() {
  const country = 'USA';  // Match at start
  return country;
}

export function endOfFunction() {
  const data = {
    id: 123,
    name: 'Test'
  };
  
  return data;
  // Match at end: country
}

// Helper function to test context isn't provided
function loadSettings() {
  return {
    language: 'en',
    country: 'US',
    timezone: 'UTC'
  };
}