/**
 * Mixed-concern detection for `solid/single-responsibility` (#128).
 *
 * The single-responsibility rule historically fired only on *size* proxies
 * (parameter count, line count). A function can be short and still do three
 * unrelated jobs — and a long function can be a single cohesive pipeline
 * (fetch → shape). This module classifies the *calls* a function makes into a
 * small set of concern categories and counts how many *unrelated* categories
 * the function spans. That span is the actual SRP signal the size proxies were
 * standing in for.
 *
 * The design leans hard on precision — a false positive here blocks an agent's
 * edit loop, not just adds noise:
 *
 *   - A call is classified by its **callee name** (`sendEmail(...)` → messaging,
 *     `db.query(...)` → data-access), never by structural shape. Renaming a
 *     call site cannot mask or trigger a finding the way a shape match could.
 *   - Nested function bodies are skipped: a `.map(x => …)` callback is a
 *     separate function, and its calls belong to *it*, not to the enclosing
 *     function. Otherwise `rows.map(row => save(row))` would read as the outer
 *     function doing data-access *and* persistence.
 *   - `data-access` and `data-transformation` are **related** — fetch-and-shape
 *     is one job (a repository method). `db.query()` + `.map()` collapses to a
 *     single concern group and does not fire. See `countConcernGroups`.
 *   - Ambiguous verbs (`find`, `get`, `update`, …) are data-access only when
 *     the *receiver* is a data handle (`db.find`, `client.get`); on an ordinary
 *     array they are transformation (`rows.find`), not data access.
 *   - `console.*` is incidental debugging, not an observability concern, so it
 *     does not register (a route handler that logs does not become "mixed").
 */

import type { ASTNode } from '../../languages/types.js';

/** The concern categories a function can span. */
export type FunctionConcern =
  | 'data-access'
  | 'data-transformation'
  | 'messaging'
  | 'logging'
  | 'rendering';

/** Human-readable labels, for violation messages. */
export const CONCERN_LABELS: Record<FunctionConcern, string> = {
  'data-access': 'data access',
  'data-transformation': 'data transformation',
  'messaging': 'messaging',
  'logging': 'logging',
  'rendering': 'rendering',
};

/**
 * The *irreducible* concerns — the output / side-effect categories a function
 * can produce. `data-transformation` (map/filter/reduce/shape) and `logging`
 * (observability) are glue and annotation, not responsibilities: a function
 * that "shapes then sends" or "fetches then logs" is a single job, so neither
 * votes toward the SRP span. Only a function spanning two or more of the three
 * below is doing two jobs.
 */
const VOTING_CONCERNS: ReadonlySet<FunctionConcern> = new Set([
  'data-access',
  'messaging',
  'rendering',
]);

/** The voting concerns only, sorted for stable messages. */
export function votingConcerns(concerns: Set<FunctionConcern>): FunctionConcern[] {
  return [...concerns].filter((c) => VOTING_CONCERNS.has(c)).sort();
}

/**
 * Node types that introduce a nested function/closure boundary. A call inside
 * one of these belongs to that nested function, not to the function being
 * analyzed, so the walk does not descend into them.
 */
const NESTED_FUNCTION_TYPES = new Set([
  'function_declaration',
  'function_expression',
  'arrow_function',
  'method_definition',
  'generator_function_declaration',
  'generator_function_expression',
  'method_declaration', // Go method
  'func_literal',       // Go closure
]);

/** True when the node type denotes a function/method definition or literal. */
export function isFunctionNodeType(type: string): boolean {
  return NESTED_FUNCTION_TYPES.has(type);
}

/**
 * Data-access verbs that are unambiguous even with no receiver (a bare call):
 * `query(...)`, `fetch(...)`, `save(...)`, … A function named `query` that does
 * a SQL query is data access regardless of what it is called on.
 */
const BARE_DATA_VERBS = new Set([
  'query', 'fetch', 'findone', 'findmany', 'findall', 'findbyid', 'findby',
  'insert', 'update', 'delete', 'upsert', 'save', 'persist', 'migrate', 'runquery',
]);

/**
 * Data-access verbs that require a data-ish receiver (`db.find`, `client.get`).
 * These are only data access when the receiver is a data handle; on an ordinary
 * array (`rows.find`) they are transformation. Superset of {@link BARE_DATA_VERBS}.
 */
const DATA_VERBS = new Set<string>([
  ...BARE_DATA_VERBS,
  'find', 'get', 'getone', 'getbyid', 'remove', 'execute', 'count', 'sum',
  'avg', 'max', 'min', 'post', 'put', 'patch', 'head', 'del', 'list',
  'create', 'read', 'truncate', 'findbypk', 'updateone', 'updatemany',
  'deleteone', 'deletemany', 'bulkcreate', 'bulkinsert', 'findandupdate',
]);

/**
 * Receiver-name tokens that mark a data handle: a connection, repository,
 * ORM, client, or store. Matched by substring on the lowercased receiver, so
 * `dbPool`, `connectionPool`, and `this.pool` all register.
 *
 * Deliberately excludes result-set words (`rows`, `results`, `records`,
 * `dataset`) — those are already-fetched arrays whose `.map()`/`.find()` are
 * transformation, not data access.
 */
const DATA_RECEIVERS = [
  'database', 'datastore', 'repository', 'repo', 'connection', 'conn',
  'client', 'collection', 'model', 'cursor', 'session', 'store', 'pool',
  'querybuilder', 'prisma', 'knex', 'sequelize', 'mongoose', 'redis',
  'mongo', 'orm', 'dynamodb', 'firestore', 'supabase', 'postgres', 'mysql',
  'sqlite', 'axios', 'graphql', 'superagent', 'request', 'api', 'http',
  'https', 'db', 'sql',
];

/**
 * Data-transformation verbs: array/collection shaping. Single-value coercions
 * (`trim`, `split`, `parseInt`, `toString`, …) are intentionally omitted — a
 * `.trim()` is incidental, not a responsibility.
 */
const TRANSFORM_VERBS = new Set([
  'map', 'filter', 'reduce', 'sort', 'groupby', 'group', 'flatmap', 'slice',
  'find', 'findindex', 'findlast', 'some', 'every', 'concat', 'join',
  'reverse', 'includes', 'indexof', 'flatten', 'compact', 'uniq', 'unique',
  'merge', 'pick', 'omit', 'normalize', 'transform', 'stringify', 'serialize',
  'format', 'keys', 'values', 'entries', 'assign', 'clone', 'deepclone',
  'pluck', 'chunk', 'shuffle',
]);

/**
 * Messaging / notification verbs. Explicit names only — no bare `send*` prefix,
 * because `res.send(...)` is an HTTP response (part of a handler's single job),
 * not a notification. `sendEmail`, `notify`, `publish`, `enqueue`, `broadcast`
 * are the real side-channel signals.
 *
 * `alert` is deliberately absent: a bare `alert(...)` is browser UI feedback
 * (a synchronous dialog in the same process), not a messaging side-channel to
 * another system or person. Counting it as "messaging" mislabels ordinary
 * React handlers as god-functions.
 */
const MESSAGING_NAMES = new Set([
  'email', 'mail', 'notify', 'notification', 'sms', 'publish', 'enqueue',
  'broadcast', 'newsletter', 'mailer', 'sendemail', 'sendmessage',
  'sendnotification', 'sendmail', 'sendsms', 'sendtext',
  'pushnotification', 'textmessage',
]);

/**
 * Logging / observability / audit verbs. Explicit named events plus a dedicated
 * `logger.*` receiver. `console.*` is deliberately absent — a stray debug
 * statement is not a responsibility. `logEvent`, `audit`, `track`, `analytics`,
 * `sentry`, `logger.info` are.
 */
const LOGGING_NAMES = new Set([
  'logevent', 'logerror', 'loginfo', 'logwarn', 'logwarning', 'logdebug',
  'logmessage', 'audit', 'track', 'trackevent', 'analytics', 'telemetry',
  'metric', 'sentry', 'logger', 'gtag', 'ga',
]);

/**
 * Rendering / presentation verbs. `createElement` is deliberately absent:
 * `document.createElement("canvas")` is DOM *construction* (image export),
 * not a presentation concern — treating it as "rendering" would mislabel
 * canvas-manipulation save handlers as god-functions.
 */
const RENDERING_NAMES = new Set([
  'render', 'rendertostring', 'display', 'template', 'markdown', 'draw',
  'print', 'rendercomponent', 'paint',
]);

/** Extract the trailing identifier of a callee expression, lowercased. */
function trailingIdentifier(calleeText: string): string {
  const match = calleeText.trim().match(/([A-Za-z_$][\w$]*)\s*$/);
  return match ? match[1].toLowerCase() : '';
}

/** Extract the receiver (text before the last `.`), lowercased; '' for a bare call. */
function receiverText(calleeText: string): string {
  const dot = calleeText.lastIndexOf('.');
  return dot >= 0 ? calleeText.slice(0, dot).trim().toLowerCase() : '';
}

/** True when the receiver name contains a data-handle token. */
function hasDataReceiver(receiver: string): boolean {
  if (!receiver) return false;
  return DATA_RECEIVERS.some((token) => receiver.includes(token));
}

/** Classify one callee expression into a concern category, or null. */
function classifyCall(calleeText: string): FunctionConcern | null {
  const full = calleeText.trim().toLowerCase();
  const name = trailingIdentifier(full);
  if (!name) return null;
  const receiver = receiverText(full);

  // Specific concerns first, then the broad data-access/transform split.
  if (MESSAGING_NAMES.has(name)) return 'messaging';
  if (LOGGING_NAMES.has(name) || receiver === 'logger') return 'logging';
  if (RENDERING_NAMES.has(name)) return 'rendering';
  if (BARE_DATA_VERBS.has(name) || name.startsWith('fetch')) return 'data-access';
  if (receiver && hasDataReceiver(receiver) && DATA_VERBS.has(name)) return 'data-access';
  if (TRANSFORM_VERBS.has(name)) return 'data-transformation';

  return null;
}

/**
 * Classify every call in a function body into concern categories, skipping
 * nested function bodies (their calls belong to them, not to this function).
 */
export function detectFunctionConcerns(
  functionNode: ASTNode,
  getText: (node: ASTNode) => string,
): Set<FunctionConcern> {
  const concerns = new Set<FunctionConcern>();

  const visit = (node: ASTNode, isRoot: boolean): void => {
    if (!isRoot && NESTED_FUNCTION_TYPES.has(node.type)) return;

    if (node.type === 'call_expression') {
      const callee = node.children?.[0];
      if (callee) {
        const concern = classifyCall(getText(callee));
        if (concern) concerns.add(concern);
      }
    }

    for (const child of node.children ?? []) visit(child, false);
  };

  visit(functionNode, true);
  return concerns;
}

/**
 * Count the number of *unrelated* concern groups a function spans.
 *
 * Only the irreducible concerns vote (`data-access`, `messaging`, `rendering`).
 * `data-transformation` and `logging` are glue and annotation, so they never
 * count: "load and shape" (data-access + transformation), "shape and send"
 * (transformation + messaging), "shape and render" (transformation + rendering),
 * and "do the job and log it" are all single jobs. A function spans two or more
 * irreducible concerns — fetch + email, query + render — and only then is it
 * doing two jobs.
 */
export function countConcernGroups(concerns: Set<FunctionConcern>): number {
  return votingConcerns(concerns).length;
}
