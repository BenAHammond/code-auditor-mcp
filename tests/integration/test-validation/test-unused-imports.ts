// Test file to validate unused import detection

// These imports should be detected as unused
import { useState, useEffect, useCallback } from 'react';
import { debounce, throttle } from 'lodash';
import fs from 'fs';
import path from 'path';
import * as crypto from 'crypto';

// This import is used
import { format } from 'date-fns';

// Type-only import (should be handled based on configuration)
import type { ReactNode } from 'react';

// Function that only uses some imports
export function formatDate(date: Date): string {
  // Only uses 'format' from date-fns
  return format(date, 'yyyy-MM-dd');
}

// Another function that doesn't use any imports
export function simpleFunction(a: number, b: number): number {
  return a + b;
}

// Arrow function that doesn't use imports
export const arrowFunction = (text: string) => {
  return text.toUpperCase();
};

// Class that doesn't use imports
export class MyClass {
  private value: number;

  constructor(value: number) {
    this.value = value;
  }

  getValue(): number {
    return this.value;
  }
}