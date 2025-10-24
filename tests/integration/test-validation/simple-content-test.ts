/**
 * Simple test for content search and match context
 */

export function testContentSearch() {
  // This function contains the word country in its body
  const userCountry = "USA";
  console.log(`User is from country: ${userCountry}`);
  
  // Another mention of country here
  if (userCountry === "USA") {
    console.log("Country is United States");
  }
  
  return userCountry;
}