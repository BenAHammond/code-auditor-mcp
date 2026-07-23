/**
 * Order processing with branching logic — cyclomatic complexity ~8.
 * With maxMethodComplexity set to 5, this should trigger solid/method-complexity.
 */
export class OrderService {
  processOrder(
    orderId: string,
    items: Array<{ id: string; quantity: number; price: number }>,
    customer: { tier: string; credit: number },
    options?: { expedited?: boolean; gift?: boolean }
  ): { status: string; total: number } {
    let total = 0;
    let discount = 0;

    for (const item of items) {
      if (item.quantity > 10) {
        total += item.price * item.quantity * 0.9;
      } else if (item.quantity > 5) {
        total += item.price * item.quantity * 0.95;
      } else {
        total += item.price * item.quantity;
      }
    }

    if (customer.tier === 'premium') {
      discount = total * 0.15;
    } else if (customer.tier === 'gold') {
      discount = total * 0.1;
    } else if (customer.tier === 'silver') {
      discount = total * 0.05;
    }

    if (total > customer.credit) {
      return { status: 'rejected', total: total - discount };
    }

    if (options?.expedited) {
      total += 25;
    }

    if (options?.gift) {
      total += 5;
    }

    return { status: 'confirmed', total: total - discount };
  }
}
