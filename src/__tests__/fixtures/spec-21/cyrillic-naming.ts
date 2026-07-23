/**
 * Spec-21 R5.4/R6: Exported function with Cyrillic name —
 * naming analyzer MUST return zero violations (unclassifiable).
 *
 * The name "получитьДанные" contains characters outside the Latin
 * script. The naming analyzer classifies these as unclassifiable
 * and skips them — no camelCase/PascalCase/snake_case rule fires.
 */

/**
 * Получить данные пользователя из базы данных.
 */
export function получитьДанные(userId: string): Record<string, unknown> {
  return { id: userId, имя: 'Тест' };
}

// Also unclassifiable: mixed-script identifier
export const API_Точка = '/api/data';

// Latin identifiers should still be checked normally.
export function getData(id: string): Record<string, unknown> {
  return { id };
}
