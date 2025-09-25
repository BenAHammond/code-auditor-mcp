import { BaseType } from './test-validation/types';

// Module-level interface extension - BaseType should be marked as used
export interface ExtendedType extends BaseType {
  additionalField: string;
  isActive: boolean;
}

export function useExtendedType() {
  const data: ExtendedType = {
    name: 'test',
    value: 123,
    additionalField: 'extra',
    isActive: true
  };
  
  return data;
}