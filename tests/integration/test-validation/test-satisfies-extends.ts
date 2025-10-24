// Test file for satisfies operator and interface extension
import { CSSProperties } from 'react';
import { BaseFilters } from '@/components/shared/filters/CommonFilterControls';
import { BaseType } from './types';
import { UnusedType } from './unused-module';

// Test 1: satisfies operator
const styles = {
  container: {
    display: 'flex',
    padding: 10
  }
} satisfies Record<string, CSSProperties>;

// Test 2: interface extends - this was being marked as false positive
export interface ReportFilters extends BaseFilters {
  customField: string;
  dateRange: [Date, Date];
}

// Test 3: interface extends with local type
interface ExtendedType extends BaseType {
  additionalField: number;
}

// Test 4: Multiple satisfies
const theme = {
  colors: { primary: 'blue' }
} satisfies { colors: Record<string, string> };

// Test 5: Satisfies with imported type
const config = {
  name: 'test',
  value: 42
} satisfies BaseType;

// UnusedType should still be reported as unused