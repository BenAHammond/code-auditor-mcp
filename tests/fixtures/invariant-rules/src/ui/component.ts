// This file is in src/ui/** — importing from src/services/** violates the
// no-services-from-ui module-boundary rule.
import { ServiceCaller } from '../services/api';

export function UiComponent(): string {
  return ServiceCaller();
}
