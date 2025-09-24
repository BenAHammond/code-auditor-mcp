// Test for conditional and ternary import usage
import { prodConfig, devConfig, testConfig } from './configs';
import { Logger, ConsoleLogger, FileLogger } from './loggers';
import { validateProd, validateDev } from './validators';
import { unusedImport } from './unused';

// Test 1: Ternary operator
export function getConfig(env: string) {
  return env === 'production' ? prodConfig : devConfig;
}

// Test 2: Nested ternary
export function getLoggerType(env: string, useFile: boolean) {
  return env === 'production' 
    ? (useFile ? FileLogger : Logger)
    : ConsoleLogger;
}

// Test 3: Conditional usage in if statements
export function validate(data: any, isProd: boolean) {
  if (isProd) {
    return validateProd(data);
  } else {
    return validateDev(data);
  }
}

// Test 4: Switch statement usage
export function getConfigByEnv(env: string) {
  switch (env) {
    case 'production':
      return prodConfig;
    case 'development':
      return devConfig;
    case 'test':
      return testConfig;
    default:
      return devConfig;
  }
}

// Test 5: Logical operators
export function getValidator(useProd: boolean) {
  const validator = useProd && validateProd || validateDev;
  return validator;
}

// Test 6: Conditional property access
export function conditionalAccess(useLogger: boolean) {
  const result = useLogger && Logger.log('message');
  return result;
}

// unusedImport should still be detected as unused