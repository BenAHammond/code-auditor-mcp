// Complex test file 2 - Contains duplicates and variations from complex1.ts

import { Observable, Subject, BehaviorSubject } from 'rxjs';
import { map, filter, switchMap, catchError, retry, debounceTime } from 'rxjs/operators';

// EXACT DUPLICATE: Same complex generic type
type DeepPartial<T> = T extends object ? {
  [P in keyof T]?: T[P] extends (infer U)[] ? DeepPartial<U>[] :
    T[P] extends readonly (infer U)[] ? readonly DeepPartial<U>[] :
    DeepPartial<T[P]>
} : T;

// SIMILAR: Tree structure with minor differences
interface TreeNode<T> {
  id: string;
  value: T; // Changed from 'data' to 'value'
  children: TreeNode<T>[];
  parent?: TreeNode<T>;
  meta?: { // Changed from 'metadata' to 'meta'
    createdAt: Date; // Changed property names
    updatedAt: Date;
    version: number;
    labels: string[]; // Changed from 'tags' to 'labels'
  };
}

// EXACT DUPLICATE: Same complex class (different name)
@sealed
@logger
export class DataHandler<T extends Record<string, any>> { // Changed class name
  private cache = new Map<string, T>();
  private subscribers = new Set<(data: T) => void>();
  private eventStream$ = new Subject<ProcessingEvent<T>>();
  
  constructor(
    private readonly config: ProcessorConfig,
    private readonly validator: (data: unknown) => data is T
  ) {
    this.initializeEventHandlers();
  }
  
  private initializeEventHandlers(): void {
    this.eventStream$
      .pipe(
        filter(event => event.type === 'data' && this.validator(event.payload)),
        debounceTime(this.config.debounceMs || 300),
        map(event => this.transformData(event.payload as T)),
        switchMap(async data => {
          try {
            const processed = await this.complexProcessing(data);
            return { success: true, data: processed };
          } catch (error) {
            return { success: false, error };
          }
        }),
        retry(3),
        catchError(error => {
          console.error('Stream error:', error);
          return [];
        })
      )
      .subscribe(result => {
        if (result.success) {
          this.notifySubscribers(result.data);
        }
      });
  }
  
  private async complexProcessing(data: T): Promise<T> {
    // Complex nested processing with multiple async operations
    const stages = [
      async (d: T) => {
        if (this.config.stage1?.enabled) {
          for (const key in d) {
            if (d.hasOwnProperty(key)) {
              const value = d[key];
              if (typeof value === 'object' && value !== null) {
                if (Array.isArray(value)) {
                  d[key] = await Promise.all(
                    value.map(async (item, index) => {
                      if (typeof item === 'object' && item !== null) {
                        return this.processNestedObject(item, `${key}[${index}]`);
                      }
                      return item;
                    })
                  ) as T[Extract<keyof T, string>];
                } else {
                  d[key] = await this.processNestedObject(value, key) as T[Extract<keyof T, string>];
                }
              }
            }
          }
        }
        return d;
      },
      async (d: T) => {
        if (this.config.stage2?.enabled) {
          const entries = Object.entries(d);
          const processed = await Promise.all(
            entries.map(async ([key, value]) => {
              if (this.shouldProcessField(key, value)) {
                const transformed = await this.applyTransformations(key, value);
                return [key, transformed];
              }
              return [key, value];
            })
          );
          return Object.fromEntries(processed) as T;
        }
        return d;
      },
      async (d: T) => {
        if (this.config.stage3?.validation) {
          const validationResults = await this.validateData(d);
          if (!validationResults.isValid) {
            throw new ValidationError(validationResults.errors);
          }
        }
        return d;
      }
    ];
    
    let result = data;
    for (const stage of stages) {
      result = await stage(result);
    }
    
    return result;
  }
  
  private async processNestedObject(obj: any, path: string): Promise<any> {
    const processed: any = {};
    
    for (const [key, value] of Object.entries(obj)) {
      const fullPath = `${path}.${key}`;
      
      switch (typeof value) {
        case 'string':
          processed[key] = this.config.transformers?.string?.(value, fullPath) || value;
          break;
          
        case 'number':
          processed[key] = this.config.transformers?.number?.(value, fullPath) || value;
          break;
          
        case 'boolean':
          processed[key] = this.config.transformers?.boolean?.(value, fullPath) || value;
          break;
          
        case 'object':
          if (value === null) {
            processed[key] = null;
          } else if (value instanceof Date) {
            processed[key] = this.config.transformers?.date?.(value, fullPath) || value;
          } else if (Array.isArray(value)) {
            processed[key] = await Promise.all(
              value.map((item, index) => 
                this.processNestedObject(item, `${fullPath}[${index}]`)
              )
            );
          } else {
            processed[key] = await this.processNestedObject(value, fullPath);
          }
          break;
          
        default:
          processed[key] = value;
      }
    }
    
    return processed;
  }
  
  private transformData(data: T): T {
    // Complex transformation logic
    const clone = JSON.parse(JSON.stringify(data));
    
    const transform = (obj: any, depth: number = 0): any => {
      if (depth > 10) return obj;
      
      if (Array.isArray(obj)) {
        return obj.map(item => transform(item, depth + 1));
      }
      
      if (obj && typeof obj === 'object') {
        const result: any = {};
        
        for (const [key, value] of Object.entries(obj)) {
          if (key.startsWith('_')) continue;
          
          const transformedKey = this.config.keyTransformer?.(key) || key;
          result[transformedKey] = transform(value, depth + 1);
        }
        
        return result;
      }
      
      return obj;
    };
    
    return transform(clone);
  }
  
  private shouldProcessField(key: string, value: any): boolean {
    if (this.config.fieldFilters?.exclude?.includes(key)) return false;
    if (this.config.fieldFilters?.include && !this.config.fieldFilters.include.includes(key)) return false;
    
    if (typeof value === 'object' && value !== null) {
      if (this.config.fieldFilters?.excludeTypes?.includes('object')) return false;
    }
    
    return true;
  }
  
  private async applyTransformations(key: string, value: any): Promise<any> {
    const transformations = this.config.fieldTransformations?.[key];
    if (!transformations) return value;
    
    let result = value;
    for (const transform of transformations) {
      result = await transform(result);
    }
    
    return result;
  }
  
  private async validateData(data: T): Promise<ValidationResult> {
    const errors: ValidationError[] = [];
    
    const validateRecursive = async (obj: any, path: string = ''): Promise<void> => {
      for (const [key, value] of Object.entries(obj)) {
        const fullPath = path ? `${path}.${key}` : key;
        const rules = this.config.validationRules?.[fullPath];
        
        if (rules) {
          for (const rule of rules) {
            const result = await rule.validate(value);
            if (!result.isValid) {
              errors.push({
                path: fullPath,
                message: result.message,
                code: rule.code
              });
            }
          }
        }
        
        if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
          await validateRecursive(value, fullPath);
        }
      }
    };
    
    await validateRecursive(data);
    
    return {
      isValid: errors.length === 0,
      errors
    };
  }
  
  private notifySubscribers(data: T): void {
    this.subscribers.forEach(subscriber => {
      try {
        subscriber(data);
      } catch (error) {
        console.error('Subscriber error:', error);
      }
    });
  }
}

// SIMILAR: Modified version of findOptimalPath with different implementation details
export function findShortestPath<T>( // Different function name
  graph: Map<string, Map<string, number>>,
  start: string,
  end: string,
  options?: { // Changed parameter name
    maxCost?: number; // Changed property name
    blacklistNodes?: Set<string>; // Changed property name
    preferredRoutes?: string[][]; // Changed property name
    costMultipliers?: Map<string, number>; // Changed property name
  }
): { route: string[], cost: number } | null { // Changed return property names
  const costs = new Map<string, number>(); // Changed variable name
  const predecessors = new Map<string, string | null>(); // Changed variable name
  const explored = new Set<string>(); // Changed variable name
  const priorityQueue = new PriorityQueue<string>(); // Changed variable name
  
  // Initialize with slightly different logic
  graph.forEach((_, node) => {
    costs.set(node, node === start ? 0 : Number.MAX_SAFE_INTEGER); // Different infinity value
    predecessors.set(node, null);
    priorityQueue.enqueue(node, costs.get(node)!);
  });
  
  while (!priorityQueue.isEmpty()) {
    const currentNode = priorityQueue.dequeue()!; // Changed variable name
    
    if (currentNode === end) {
      // Reconstruct route with different implementation
      const route: string[] = [];
      let n: string | null = end;
      
      do {
        route.unshift(n);
        n = predecessors.get(n) || null;
      } while (n !== null);
      
      const totalCost = costs.get(end)!;
      
      if (options?.maxCost && totalCost > options.maxCost) {
        return null;
      }
      
      return { route, cost: totalCost };
    }
    
    if (explored.has(currentNode)) continue;
    explored.add(currentNode);
    
    const adjacentNodes = graph.get(currentNode); // Changed variable name
    if (!adjacentNodes) continue;
    
    for (const [adjacent, baseCost] of adjacentNodes) { // Changed variable names
      if (options?.blacklistNodes?.has(adjacent)) continue;
      
      let modifiedCost = baseCost; // Changed variable name
      
      // Apply cost multipliers with different calculation
      if (options?.costMultipliers?.has(adjacent)) {
        modifiedCost = modifiedCost * options.costMultipliers.get(adjacent)!;
      }
      
      // Check preferred routes with different logic
      if (options?.preferredRoutes) {
        for (const route of options.preferredRoutes) {
          const currIdx = route.indexOf(currentNode);
          const adjIdx = route.indexOf(adjacent);
          
          if (currIdx >= 0 && adjIdx === currIdx + 1) {
            modifiedCost = modifiedCost * 0.75; // Different multiplier
          }
        }
      }
      
      const newCost = costs.get(currentNode)! + modifiedCost;
      
      if (newCost < costs.get(adjacent)!) {
        costs.set(adjacent, newCost);
        predecessors.set(adjacent, currentNode);
        priorityQueue.enqueue(adjacent, newCost);
      }
    }
  }
  
  return null;
}

// EXACT DUPLICATE: Same state machine implementation
export class StateMachine<TState extends string, TEvent extends string> {
  private currentState: TState;
  private stateHandlers = new Map<TState, StateHandler<TState, TEvent>>();
  private transitions = new Map<string, Transition<TState, TEvent>>();
  private history: Array<{ state: TState, event?: TEvent, timestamp: Date }> = [];
  
  constructor(
    initialState: TState,
    private readonly config: StateMachineConfig<TState, TEvent>
  ) {
    this.currentState = initialState;
    this.history.push({ state: initialState, timestamp: new Date() });
    this.initializeStates();
  }
  
  private initializeStates(): void {
    for (const [state, handler] of Object.entries(this.config.states) as [TState, StateHandler<TState, TEvent>][]) {
      this.stateHandlers.set(state, handler);
      
      if (handler.transitions) {
        for (const [event, transition] of Object.entries(handler.transitions) as [TEvent, Transition<TState, TEvent>][]) {
          const key = `${state}:${event}`;
          this.transitions.set(key, transition);
        }
      }
    }
  }
  
  async processEvent(event: TEvent, data?: any): Promise<void> {
    const key = `${this.currentState}:${event}`;
    const transition = this.transitions.get(key);
    
    if (!transition) {
      if (this.config.onInvalidTransition) {
        await this.config.onInvalidTransition(this.currentState, event);
      }
      return;
    }
    
    // Check guard
    if (transition.guard && !await transition.guard(data)) {
      return;
    }
    
    // Execute exit action
    const currentHandler = this.stateHandlers.get(this.currentState);
    if (currentHandler?.onExit) {
      await currentHandler.onExit();
    }
    
    // Execute transition action
    if (transition.action) {
      await transition.action(data);
    }
    
    // Update state
    const previousState = this.currentState;
    this.currentState = transition.target;
    this.history.push({ state: this.currentState, event, timestamp: new Date() });
    
    // Execute entry action
    const newHandler = this.stateHandlers.get(this.currentState);
    if (newHandler?.onEntry) {
      await newHandler.onEntry();
    }
    
    // Notify listeners
    if (this.config.onStateChange) {
      await this.config.onStateChange(previousState, this.currentState, event);
    }
  }
}

// Complex template literal type (will create variations)
type APIEndpoint<TResource extends string, TAction extends string> = 
  TAction extends 'list' ? `/api/${TResource}` :
  TAction extends 'get' ? `/api/${TResource}/:id` :
  TAction extends 'create' ? `/api/${TResource}` :
  TAction extends 'update' ? `/api/${TResource}/:id` :
  TAction extends 'delete' ? `/api/${TResource}/:id` :
  never;

// Complex mapped type with conditional logic
type DeepReadonly<T> = T extends Function ? T :
  T extends Array<infer U> ? ReadonlyArray<DeepReadonly<U>> :
  T extends Map<infer K, infer V> ? ReadonlyMap<DeepReadonly<K>, DeepReadonly<V>> :
  T extends Set<infer U> ? ReadonlySet<DeepReadonly<U>> :
  T extends object ? { readonly [K in keyof T]: DeepReadonly<T[K]> } :
  T;

// Same helper classes
class PriorityQueue<T> {
  private items: Array<{ element: T, priority: number }> = [];
  
  enqueue(element: T, priority: number): void {
    const item = { element, priority };
    let added = false;
    
    for (let i = 0; i < this.items.length; i++) {
      if (item.priority < this.items[i].priority) {
        this.items.splice(i, 0, item);
        added = true;
        break;
      }
    }
    
    if (!added) {
      this.items.push(item);
    }
  }
  
  dequeue(): T | undefined {
    return this.items.shift()?.element;
  }
  
  isEmpty(): boolean {
    return this.items.length === 0;
  }
}

// Same decorators
function sealed(constructor: Function) {
  Object.seal(constructor);
  Object.seal(constructor.prototype);
}

function logger(constructor: Function) {
  const original = constructor;
  
  function newConstructor(...args: any[]) {
    console.log(`Creating instance of ${original.name}`);
    return new (original as any)(...args);
  }
  
  newConstructor.prototype = original.prototype;
  return newConstructor as any;
}

// Same types (needed for the class)
interface ProcessorConfig {
  debounceMs?: number;
  stage1?: { enabled: boolean };
  stage2?: { enabled: boolean };
  stage3?: { validation: boolean };
  transformers?: {
    string?: (value: string, path: string) => string;
    number?: (value: number, path: string) => number;
    boolean?: (value: boolean, path: string) => boolean;
    date?: (value: Date, path: string) => Date;
  };
  keyTransformer?: (key: string) => string;
  fieldFilters?: {
    include?: string[];
    exclude?: string[];
    excludeTypes?: string[];
  };
  fieldTransformations?: Record<string, Array<(value: any) => Promise<any>>>;
  validationRules?: Record<string, ValidationRule[]>;
}

interface ProcessingEvent<T> {
  type: 'data' | 'error' | 'complete';
  payload?: T;
  error?: Error;
}

interface ValidationResult {
  isValid: boolean;
  errors: ValidationError[];
}

interface ValidationError {
  path: string;
  message: string;
  code: string;
}

interface ValidationRule {
  code: string;
  validate: (value: any) => Promise<{ isValid: boolean; message?: string }>;
}

class ValidationError extends Error {
  constructor(public errors: ValidationError[]) {
    super('Validation failed');
  }
}

interface StateHandler<TState, TEvent> {
  onEntry?: () => Promise<void>;
  onExit?: () => Promise<void>;
  transitions?: Record<TEvent, Transition<TState, TEvent>>;
}

interface Transition<TState, TEvent> {
  target: TState;
  guard?: (data?: any) => Promise<boolean>;
  action?: (data?: any) => Promise<void>;
}

interface StateMachineConfig<TState extends string, TEvent extends string> {
  states: Record<TState, StateHandler<TState, TEvent>>;
  onStateChange?: (from: TState, to: TState, event: TEvent) => Promise<void>;
  onInvalidTransition?: (state: TState, event: TEvent) => Promise<void>;
}