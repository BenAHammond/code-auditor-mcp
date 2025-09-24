/**
 * Test file for Bug 1: Line-level content search within function bodies
 * This file contains various patterns to test content search functionality
 */

import { DatabaseConnection } from './mock-db';

// Function with "country" in the body - should be found by content search
export function validateAddress(data: any) {
  // Check if country is provided
  if (!data.country) {
    throw new Error('Country is required for address validation');
  }
  
  // Special handling for different countries
  switch (data.country.toLowerCase()) {
    case 'usa':
    case 'united states':
      return validateUSAddress(data);
    case 'canada':
      return validateCanadianAddress(data);
    case 'uk':
    case 'united kingdom':
      // UK addresses have different format
      return validateUKAddress(data);
    default:
      // Generic validation for other countries
      return genericAddressValidation(data);
  }
}

// Function with nested quotes to test query parser
export function generateSQLQuery(table: string, filters: any) {
  let query = `SELECT * FROM ${table} WHERE 1=1`;
  
  if (filters.country) {
    // This should be findable with query: "column: 'country'"
    query += ` AND column: 'country' = '${filters.country}'`;
  }
  
  if (filters.status) {
    // Test escape sequences
    query += ` AND status = '${filters.status.replace(/'/g, "\\'")}'`;
  }
  
  return query;
}

// Helper functions referenced above
function validateUSAddress(data: any) {
  return data.zip && data.state && data.city;
}

function validateCanadianAddress(data: any) {
  return data.postalCode && data.province && data.city;
}

function validateUKAddress(data: any) {
  // UK uses postcode instead of zip
  return data.postcode && data.city;
}

function genericAddressValidation(data: any) {
  return data.city && (data.zip || data.postalCode || data.postcode);
}

// Function with multiple search targets on different lines
export async function processInternationalOrder(order: any) {
  const db = new DatabaseConnection();
  
  // Line 67: First mention of country
  const countryCode = order.shippingAddress.country;
  
  // Line 70: Calculate shipping based on country
  const shippingRate = await db.query(
    `SELECT rate FROM shipping_rates WHERE country = ?`,
    [countryCode]
  );
  
  // Line 76: Validate country-specific requirements
  if (countryCode === 'USA') {
    // US specific validation
    if (!order.taxId) {
      throw new Error('Tax ID required for US orders');
    }
  }
  
  // Line 84: Log country information
  console.log(`Processing order for country: ${countryCode}`);
  
  return {
    ...order,
    shippingRate: shippingRate[0]?.rate || 0,
    countrySpecificData: {
      country: countryCode,
      requiresTaxId: countryCode === 'USA'
    }
  };
}