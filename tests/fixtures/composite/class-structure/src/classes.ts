/**
 * Composite class-structure fixture — a class hierarchy that stacks several
 * historically-interacting SOLID / DRY constructs in one file:
 *
 *  1. a god class (16 methods) — `solid/class-size`
 *  2. a subclass overriding a parent method to throw — `solid/liskov-substitution`
 *  3. `instanceof` against a user-defined type inside a class method — `solid/open-closed`
 *  4. a concrete dependency held by construction — `solid/dependency-inversion`
 *  5. a function with five parameters — `parameter-count`
 *
 * Every public member carries a JSDoc comment so the documentation analyzer
 * (a non-target here) stays silent and the declared finding set is exactly the
 * five target rules above.
 */

/** A formatter that never throws. */
export class Formatter {
  /** Render a value to a string, unchanged. */
  render(value: string): string {
    return value;
  }
}

/** 2. Overrides `render` to throw on an empty value — breaks the parent contract. */
export class StrictFormatter extends Formatter {
  /** Render a value, rejecting the empty string. */
  render(value: string): string {
    if (value === '') {
      throw new Error('empty value');
    }
    return value;
  }
}

/** A concrete engine — the dependency `Machine` should receive, not build. */
class Engine {
  spin(): void {}
}

/** 4. Holds a concrete dependency constructed inline — an inversion break. */
export class Machine {
  /** The engine is a concrete `new Engine()` owned by the class. */
  private engine = new Engine();

  /** Spin the engine. */
  run(): void {
    this.engine.spin();
  }
}

/** A circle shape. */
class Circle {
  radius = 0;
}

/** A square shape. */
class Square {
  side = 0;
}

/** 3. Branches on a concrete user type — adding a shape forces an edit here. */
export class AreaCalculator {
  /** Compute the area, branching on the concrete shape type. */
  areaOf(shape: Circle | Square): number {
    if (shape instanceof Circle) {
      return Math.PI * shape.radius * shape.radius;
    }
    return shape.side * shape.side;
  }
}

/** 6. Five parameters — should be an options object. */
export function configure(
  host: string,
  port: number,
  user: string,
  pass: string,
  retries: number,
): void {
  void host; void port; void user; void pass; void retries;
}

/** 1. A god class — sixteen methods exceed the class-size threshold. */
export class LegacyFacade {
  /** Returns 1. */
  m01(): number { return 1; }
  /** Returns 2. */
  m02(): number { return 2; }
  /** Returns 3. */
  m03(): number { return 3; }
  /** Returns 4. */
  m04(): number { return 4; }
  /** Returns 5. */
  m05(): number { return 5; }
  /** Returns 6. */
  m06(): number { return 6; }
  /** Returns 7. */
  m07(): number { return 7; }
  /** Returns 8. */
  m08(): number { return 8; }
  /** Returns 9. */
  m09(): number { return 9; }
  /** Returns 10. */
  m10(): number { return 10; }
  /** Returns 11. */
  m11(): number { return 11; }
  /** Returns 12. */
  m12(): number { return 12; }
  /** Returns 13. */
  m13(): number { return 13; }
  /** Returns 14. */
  m14(): number { return 14; }
  /** Returns 15. */
  m15(): number { return 15; }
  /** Returns 16. */
  m16(): number { return 16; }
}
