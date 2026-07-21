/**
 * Spec-17 R8 Fixture 20: node-type-regression
 *
 * Single fixture exercising every tree-sitter node type that the
 * isSignificantBlock / isStringLiteral helpers and SOLID walkAST
 * callbacks match against. If a tree-sitter upgrade renames any of
 * these node types, the corresponding test MUST fail — this
 * prevents silent analyzer death like the PascalCase→snake_case
 * migration in Spec 08.
 *
 * Node types covered:
 *   for_statement, for_in_statement, if_statement, while_statement,
 *   do_statement, switch_statement, try_statement,
 *   string, template_string, throw_statement, new_expression,
 *   binary_expression (instanceof)
 */

export function nodeTypeSampler(): void {
  const items = [1, 2, 3];
  const obj = { a: 1, b: 2 };

  // for_statement
  for (let i = 0; i < items.length; i++) {
    console.log(items[i]);
  }

  // for_in_statement
  for (const key in obj) {
    console.log(key);
  }

  // if_statement
  if (items.length > 0) {
    console.log("has items");
  }

  // while_statement
  let j = 0;
  while (j < 3) {
    console.log(j);
    j++;
  }

  // do_statement
  let k = 0;
  do {
    console.log(k);
    k++;
  } while (k < 2);

  // switch_statement
  switch (items[0]) {
    case 1:
      console.log("one");
      break;
    default:
      console.log("other");
  }

  // try_statement
  try {
    throw new Error("test");
  } catch (e) {
    console.log("caught");
  }

  // string (literal)
  const s = "hello";

  // template_string
  const t = `world`;

  // throw_statement (inside try above, but standalone for clarity)
  if (!items) {
    throw new Error("missing");
  }

  // new_expression
  const map = new Map<string, number>();

  // binary_expression with instanceof
  if (map instanceof Map) {
    console.log("is Map");
  }
}
