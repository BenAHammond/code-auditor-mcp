// This file is in src/services/** — allowed to call fetchData
import { fetchData } from '../module';

export function ServiceCaller(): string {
  return fetchData();
}
