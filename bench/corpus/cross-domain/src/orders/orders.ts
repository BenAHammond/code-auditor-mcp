/**
 * Orders module — writes to orders, inventory, payments, notifications tables.
 * Provides both validated and unvalidated write paths.
 */
import { validateOrder, formatHelper } from '../validators/validators';

export function saveOrder(data: Record<string, unknown>): void {
  // INSERT INTO orders ...
  validateOrder(data);
}

export function processOrder(id: number): void {
  // UPDATE orders ...
  validateOrder({ id });
  updateInventory(id);
  processPayment(id);
  sendNotification(id);
}

function updateInventory(id: number): void {
  // UPDATE inventory ...
  validateOrder({ id });
}

function processPayment(id: number): void {
  // INSERT INTO payments ...
}

function sendNotification(id: number): void {
  // INSERT INTO notifications ...
}

export function createValidatedOrder(data: Record<string, unknown>): void {
  validateOrder(data);
  // INSERT INTO orders ...
}

export function createUnvalidatedOrder(data: Record<string, unknown>): void {
  // INSERT INTO orders ... (no validation)
}

export function formatOrder(amount: number): string {
  // INSERT INTO orders ...
  return formatHelper(amount); // reaches only the non-validator helper
}
