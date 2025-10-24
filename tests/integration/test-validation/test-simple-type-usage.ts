// Simple test to validate type-only usage detection
import { BaseFilters } from '@/components/shared/filters/CommonFilterControls';

// This should NOT mark BaseFilters as unused
export interface ReportFilters extends BaseFilters {
  customField: string;
}