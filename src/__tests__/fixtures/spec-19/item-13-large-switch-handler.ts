/**
 * Spec-19 item 13 — solid/method-complexity TRUE positive (oracle: MUST fire).
 * 15-branch switch in a single handler method, complexity > 50.
 * Large dispatch method — genuine complexity.
 */

enum ActionType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  ARCHIVE = 'archive',
  RESTORE = 'restore',
  PUBLISH = 'publish',
  UNPUBLISH = 'unpublish',
  ASSIGN = 'assign',
  UNASSIGN = 'unassign',
  TRANSFER = 'transfer',
  MERGE = 'merge',
  SPLIT = 'split',
  CLONE = 'clone',
  LOCK = 'lock',
  UNLOCK = 'unlock',
}

interface Action {
  type: ActionType;
  entityId: string;
  payload?: Record<string, unknown>;
}

interface ActionResult {
  success: boolean;
  message: string;
  entity?: unknown;
}

export async function handleAction(action: Action): Promise<ActionResult> {
  // Each case adds an if-branch for validation...
  switch (action.type) {
    case ActionType.CREATE: {
      if (!action.payload || !action.payload.name) {
        return { success: false, message: 'Missing name' };
      }
      if (typeof action.payload.name !== 'string') {
        return { success: false, message: 'Name must be a string' };
      }
      if (action.payload.name.length > 255) {
        return { success: false, message: 'Name too long' };
      }
      const entity = { id: action.entityId, name: action.payload.name };
      return { success: true, message: 'Created', entity };
    }
    case ActionType.UPDATE: {
      if (!action.payload) {
        return { success: false, message: 'Missing payload' };
      }
      if (Object.keys(action.payload).length === 0) {
        return { success: false, message: 'Empty payload' };
      }
      const entity = { id: action.entityId, ...action.payload };
      return { success: true, message: 'Updated', entity };
    }
    case ActionType.DELETE: {
      if (!action.entityId) {
        return { success: false, message: 'Missing entityId' };
      }
      return { success: true, message: 'Deleted' };
    }
    case ActionType.ARCHIVE: {
      if (!action.payload || !action.payload.reason) {
        return { success: false, message: 'Missing archive reason' };
      }
      return { success: true, message: 'Archived' };
    }
    case ActionType.RESTORE: {
      if (!action.entityId) {
        return { success: false, message: 'Missing entityId' };
      }
      return { success: true, message: 'Restored' };
    }
    case ActionType.PUBLISH: {
      if (!action.payload || !action.payload.channel) {
        return { success: false, message: 'Missing channel' };
      }
      if (!['web', 'mobile', 'api'].includes(String(action.payload.channel))) {
        return { success: false, message: 'Invalid channel' };
      }
      return { success: true, message: 'Published' };
    }
    case ActionType.UNPUBLISH: {
      if (!action.entityId) {
        return { success: false, message: 'Missing entityId' };
      }
      return { success: true, message: 'Unpublished' };
    }
    case ActionType.ASSIGN: {
      if (!action.payload || !action.payload.userId) {
        return { success: false, message: 'Missing userId' };
      }
      return { success: true, message: 'Assigned' };
    }
    case ActionType.UNASSIGN: {
      return { success: true, message: 'Unassigned' };
    }
    case ActionType.TRANSFER: {
      if (!action.payload || !action.payload.targetId) {
        return { success: false, message: 'Missing targetId' };
      }
      return { success: true, message: 'Transferred' };
    }
    case ActionType.MERGE: {
      if (!action.payload || !action.payload.sourceId || !action.payload.targetId) {
        return { success: false, message: 'Missing sourceId or targetId' };
      }
      return { success: true, message: 'Merged' };
    }
    case ActionType.SPLIT: {
      if (!action.payload || !action.payload.parts || action.payload.parts.length < 2) {
        return { success: false, message: 'Need at least 2 parts' };
      }
      return { success: true, message: 'Split' };
    }
    case ActionType.CLONE: {
      if (!action.payload || !action.payload.newName) {
        return { success: false, message: 'Missing newName' };
      }
      const cloned = { id: 'clone-' + action.entityId, name: action.payload.newName };
      return { success: true, message: 'Cloned', entity: cloned };
    }
    case ActionType.LOCK: {
      if (!action.payload || !action.payload.reason) {
        return { success: false, message: 'Missing lock reason' };
      }
      return { success: true, message: 'Locked' };
    }
    case ActionType.UNLOCK: {
      return { success: true, message: 'Unlocked' };
    }
    default: {
      return { success: false, message: 'Unknown action type' };
    }
  }
}
