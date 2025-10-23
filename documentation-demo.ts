/**
 * Demo file for documentation analysis
 */

// Missing documentation - should be flagged
function undocumentedFunction(param1: string, param2: number) {
  return param1.repeat(param2);
}

/**
 * Properly documented function
 * @param name - User name
 * @returns Greeting message
 */
function documentedFunction(name: string) {
  return `Hello, ${name}!`;
}