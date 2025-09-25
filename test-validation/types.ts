// Type definitions for testing type-only usage detection

export interface BaseType {
  name: string;
  value: number;
}

export interface ConfigType {
  setting?: string;
  enabled?: boolean;
}

export class Component {
  render() {}
}

export type Factory = () => BaseType;

export interface Logger {
  log(message: string): void;
}

export type Validator = (value: unknown) => boolean;

export type Middleware = (req: any, res: any, next: () => void) => void;