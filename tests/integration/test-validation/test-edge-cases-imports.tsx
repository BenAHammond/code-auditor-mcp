// Test file for edge case import detection
import React, { useState, useEffect, useMemo } from 'react';
import * as utils from './utils';
import { config } from './config';
import { defaults } from './defaults';
import { api } from './api';
import { ComponentA, ComponentB, ComponentC } from './components';
import { withAuth, withLogging, withCache } from './decorators';
import { prodConfig, devConfig } from './configs';
import { Button, Card } from './ui-components';
import type { User, Post } from './types';
import { helper as helperAlias } from './helpers';
import './polyfills'; // side-effect import
import 'reflect-metadata'; // side-effect import

// Test 1: Dynamic property access
export function testDynamicAccess(key: string, endpoint: string) {
  const value = config[key]; // dynamic property access
  const result = api[`get${endpoint}`](); // template literal property access
  return { value, result };
}

// Test 2: Object spread operations
export function testSpread(overrides: any) {
  return {
    ...defaults, // spread operator
    ...overrides,
    extra: utils.helper() // namespace usage
  };
}

// Test 3: JSX with compound components
export function TestComponent() {
  const [count, setCount] = useState(0); // hook usage
  
  return (
    <Card>
      <Button onClick={() => setCount(count + 1)} />
      <Button.Primary /> {/* compound component */}
    </Card>
  );
}

// Test 4: Factory pattern
export function componentFactory(type: string) {
  const components = { ComponentA, ComponentB, ComponentC };
  return components[type];
}

// Test 5: Decorators
@withAuth
@withLogging
@withCache
class TestService {
  getData() {
    return "data";
  }
}

// Test 6: Conditional usage
export function getConfig() {
  const config = process.env.NODE_ENV === 'production' ? prodConfig : devConfig;
  return config;
}

// Test 7: Aliased import usage
export function useHelper() {
  return helperAlias();
}

// Test 8: Type-only usage
export function processUser(user: User): Post[] {
  return [];
}

// Test 9: Re-export
export { helper } from './helper';
export * from './shared';

// Test 10: Array method with import reference
export function processItems(items: any[]) {
  return items.map(utils.transform); // method reference
}