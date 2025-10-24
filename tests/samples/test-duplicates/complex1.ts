// Complex test file 1 - Advanced patterns and edge cases

import { Observable, Subject, BehaviorSubject } from 'rxjs';
import { map, filter, switchMap, catchError, retry, debounceTime } from 'rxjs/operators';

// Complex generic type with nested constraints
type DeepPartial<T> = T extends object ? {
  [P in keyof T]?: T[P] extends (infer U)[] ? DeepPartial<U>[] :
    T[P] extends readonly (infer U)[] ? readonly DeepPartial<U>[] :
    DeepPartial<T[P]>
} : T;

// Complex recursive data structure
interface TreeNode<T> {
  id: string;
  data: T;
  children: TreeNode<T>[];
  parent?: TreeNode<T>;
  metadata?: {
    created: Date;
    modified: Date;
    version: number;
    tags: string[];
  };
}

// Complex class with decorators and mixins (will be duplicated)
@sealed
@logger
export class DataProcessor<T extends Record<string, any>> {
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

// Complex recursive algorithm (will be duplicated with variations)
export function findOptimalPath<T>(
  graph: Map<string, Map<string, number>>,
  start: string,
  end: string,
  constraints?: {
    maxDistance?: number;
    avoidNodes?: Set<string>;
    preferredPaths?: string[][];
    weightModifiers?: Map<string, number>;
  }
): { path: string[], distance: number } | null {
  const distances = new Map<string, number>();
  const previous = new Map<string, string | null>();
  const visited = new Set<string>();
  const queue = new PriorityQueue<string>();
  
  // Initialize
  for (const node of graph.keys()) {
    distances.set(node, node === start ? 0 : Infinity);
    previous.set(node, null);
    queue.enqueue(node, distances.get(node)!);
  }
  
  while (!queue.isEmpty()) {
    const current = queue.dequeue()!;
    
    if (current === end) {
      // Reconstruct path
      const path: string[] = [];
      let node: string | null = end;
      
      while (node !== null) {
        path.unshift(node);
        node = previous.get(node) || null;
      }
      
      const distance = distances.get(end)!;
      
      if (constraints?.maxDistance && distance > constraints.maxDistance) {
        return null;
      }
      
      return { path, distance };
    }
    
    if (visited.has(current)) continue;
    visited.add(current);
    
    const neighbors = graph.get(current);
    if (!neighbors) continue;
    
    for (const [neighbor, weight] of neighbors) {
      if (constraints?.avoidNodes?.has(neighbor)) continue;
      
      let adjustedWeight = weight;
      
      // Apply weight modifiers
      if (constraints?.weightModifiers?.has(neighbor)) {
        adjustedWeight *= constraints.weightModifiers.get(neighbor)!;
      }
      
      // Check preferred paths
      if (constraints?.preferredPaths) {
        for (const preferred of constraints.preferredPaths) {
          const currentIndex = preferred.indexOf(current);
          const neighborIndex = preferred.indexOf(neighbor);
          
          if (currentIndex !== -1 && neighborIndex === currentIndex + 1) {
            adjustedWeight *= 0.8; // Prefer this path
          }
        }
      }
      
      const altDistance = distances.get(current)! + adjustedWeight;
      
      if (altDistance < distances.get(neighbor)!) {
        distances.set(neighbor, altDistance);
        previous.set(neighbor, current);
        queue.enqueue(neighbor, altDistance);
      }
    }
  }
  
  return null;
}

// Complex state machine implementation
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

// Helper classes and types
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

// Decorators
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

// Types
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