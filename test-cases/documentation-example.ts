/**
 * Example file for documentation analysis
 */

// Missing documentation - should be flagged
function undocumentedFunction(param1: string, param2: number) {
  return param1.repeat(param2);
}

export class UndocumentedClass {
  private value: string;
  
  constructor(value: string) {
    this.value = value;
  }
  
  // Missing documentation
  process(input: any) {
    return input;
  }
}

/**
 * Properly documented function
 * @param name - User name
 * @param age - User age
 * @returns User object
 */
function documentedFunction(name: string, age: number) {
  return { name, age };
}