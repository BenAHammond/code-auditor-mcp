import React, { CSSProperties, ReactNode, ComponentType } from 'react';
import { BaseType, ConfigType, Validator } from './types';

// Test 1: satisfies operator at module level
const styles = {
  container: {
    display: 'flex',
    padding: '10px'
  },
  button: {
    backgroundColor: 'blue',
    color: 'white'
  }
} satisfies Record<string, CSSProperties>;

// Test 2: interface extends at module level
interface ExtendedType extends BaseType {
  customField: string;
  dateRange: [Date, Date];
}

// Test 3: type alias with imported type
type ConfiguredType = ConfigType & {
  isActive: boolean;
};

// Test 4: const assertion with type
const VALIDATORS = {
  required: (value: unknown) => !!value,
  email: (value: unknown) => typeof value === 'string' && value.includes('@')
} as const satisfies Record<string, Validator>;

// Test 5: Generic constraint
function wrapComponent<T extends ComponentType>(Component: T): T {
  return Component;
}

// Test 6: Module level type annotation
const typePresets: ExtendedType[] = [
  { name: 'test', value: 42, customField: 'test', dateRange: [new Date(), new Date()] }
];

// Component that uses ReactNode
export function TestComponent({ children }: { children: ReactNode }) {
  return (
    <div style={styles.container}>
      {children}
    </div>
  );
}