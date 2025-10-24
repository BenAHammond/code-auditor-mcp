// Test file to validate type-only usage detection
import { BaseType, ConfigType, Component, Factory, Logger, Validator, Middleware } from './types';
import { useState, useEffect } from 'react';
import * as Types from './namespace-types';

// Test 1: Interface extension
interface ExtendedInterface extends BaseType {
  additionalProp: string;
}

// Test 2: Type alias extension
type ExtendedType = BaseType & { extra: boolean };
type UnionType = BaseType | ConfigType;

// Test 3: Class implements
class Implementation implements BaseType {
  name: string = '';
  value: number = 0;
}

// Test 4: Generic constraints
function genericConstraint<T extends BaseType>(param: T): T {
  return param;
}

class GenericClass<T extends ConfigType> {
  data: T;
  constructor(data: T) {
    this.data = data;
  }
}

// Test 5: Type annotations
const typedVariable: BaseType = { name: 'test', value: 42 };
let anotherTyped: ConfigType;

// Test 6: Type assertions
const assertion1 = someValue as BaseType;
const assertion2 = <ConfigType>someOtherValue;

// Test 7: Type parameters
const array: Array<BaseType> = [];
const promise: Promise<ConfigType> = Promise.resolve({} as ConfigType);
const map: Map<string, Component> = new Map();

// Test 8: Return type annotations
function returnsBase(): BaseType {
  return { name: 'test', value: 1 };
}

const arrowReturn = (): ConfigType => ({} as ConfigType);

// Test 9: Parameter type annotations
function takesBase(param: BaseType): void {
  console.log(param);
}

const arrowParam = (config: ConfigType, factory: Factory) => {
  // implementation
};

// Test 10: Property type annotations
const objectWithTypes = {
  prop1: BaseType,
  prop2: ConfigType as ConfigType,
  method(logger: Logger): Validator {
    return {} as Validator;
  }
};

// Test 11: Complex type usage
type ComplexType = {
  base: BaseType;
  config?: ConfigType;
  nested: {
    component: Component;
  };
};

// Test 12: Index signatures
interface IndexSignature {
  [key: string]: BaseType;
}

// Test 13: Conditional types
type ConditionalType<T> = T extends BaseType ? true : false;

// Test 14: Type predicate
function isBaseType(value: unknown): value is BaseType {
  return true;
}

// Test 15: Namespace type access
const namespaceType: Types.NamespaceType = {} as Types.NamespaceType;

// Test 16: Constructor parameter types
class ConstructorClass {
  constructor(private base: BaseType, public config: ConfigType) {}
}

// Test 17: Method signatures in interfaces
interface MethodInterface {
  processBase(base: BaseType): ConfigType;
  validateComponent(comp: Component): boolean;
}

// Test 18: Tuple types
type TupleType = [BaseType, ConfigType, Component];

// Test 19: Mapped types
type MappedType<T extends BaseType> = {
  [K in keyof T]: T[K];
};

// Test 20: Heritage with qualified names
class QualifiedImplementation implements Types.NamespaceInterface {
  // implementation
}

// Test 21: Type arguments in function calls
genericConstraint<BaseType>({ name: 'test', value: 1 });

// Test 22: Type arguments in new expressions
const instance = new GenericClass<ConfigType>({} as ConfigType);

// Test 23: React hooks should NOT be marked as type-only
const [state, setState] = useState<BaseType>({ name: '', value: 0 });
useEffect(() => {
  console.log(state);
}, [state]);

// Test 24: Middleware usage (runtime value)
const middleware: Middleware = (req, res, next) => {
  next();
};

// Variables for assertions
declare const someValue: any;
declare const someOtherValue: any;