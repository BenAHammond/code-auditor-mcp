/**
 * Test file for Bug 3: Content search mode vs metadata search
 * Tests searchMode: 'metadata' | 'content' | 'both'
 */

// Function whose NAME contains 'country' - should match in metadata search
export function getCountryCode(locale: string): string {
  const parts = locale.split('-');
  return parts[1] || 'US';
}

// Function whose SIGNATURE contains 'country' - should match in metadata search
export function formatAddress(
  street: string,
  city: string,
  country: string  // This parameter should be found in metadata search
): string {
  return `${street}, ${city}, ${country}`;
}

// Function with 'country' only in JSDoc - metadata search
/**
 * Validates phone numbers based on country format
 * @param phoneNumber The phone number to validate
 * @param countryCode The country code for validation rules
 * @returns true if valid for the country
 */
export function validatePhoneNumber(phoneNumber: string, countryCode: string): boolean {
  // Note: 'country' appears in JSDoc but not in function name
  const patterns: Record<string, RegExp> = {
    US: /^\d{3}-\d{3}-\d{4}$/,
    UK: /^\d{4} \d{6}$/,
    CA: /^\d{3}-\d{3}-\d{4}$/
  };
  
  return patterns[countryCode]?.test(phoneNumber) || false;
}

// Function with 'country' ONLY in body - should only match in content search
export function calculateShipping(weight: number, destination: string): number {
  // The word country only appears in the function body, not metadata
  const domesticRate = 5.99;
  const internationalRate = 19.99;
  
  // Check if shipping to same country
  if (destination === 'domestic') {
    return weight * domesticRate;
  } else {
    // International shipping to different country
    return weight * internationalRate;
  }
}

// Function that should match in BOTH modes
export function getCountryInfo(countryCode: string) {
  // This has 'country' in both name AND body
  const countries = {
    US: { name: 'United States', currency: 'USD' },
    UK: { name: 'United Kingdom', currency: 'GBP' },
    CA: { name: 'Canada', currency: 'CAD' }
  };
  
  // Return country information
  return countries[countryCode] || { name: 'Unknown country', currency: 'N/A' };
}

// Edge case: function with search term in string literals only
export function getErrorMessages() {
  return {
    INVALID_COUNTRY: 'Please select a valid country',
    COUNTRY_REQUIRED: 'Country field is required',
    UNSUPPORTED_COUNTRY: 'This country is not supported'
  };
}