/**
 * Tests for the orders module.
 */
import { saveOrder, createValidatedOrder, processOrder } from '../orders/orders';

describe('orders', () => {
  it('saves an order', () => {
    saveOrder({ id: 1, item: 'widget' });
  });

  it('creates a validated order', () => {
    createValidatedOrder({ id: 2, item: 'gadget' });
  });
});
