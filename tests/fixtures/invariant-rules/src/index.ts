// This file imports from a banned module (debug-lib)
import debug from 'debug-lib';

// This file calls fetchData from outside the allowed src/services/** glob
import { fetchData } from './module';

// This export violates the naming rule (starts with lowercase)
export const notCapital = 42;

// This export satisfies the naming rule (starts with uppercase)
export function CapitalFunc(): string {
  return 'hello';
}

// This call should trigger call-constraint violation
// because index.ts is not in src/services/**
export function runApp(): string {
  return fetchData();
}
