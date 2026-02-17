const pendingActions = new Map();
const ACTION_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

export function setPendingAction(messageId, action) {
  if (!messageId || !action) return;
  pendingActions.set(messageId, { ...action, timestamp: Date.now() });
}

export function getPendingAction(messageId) {
  const entry = pendingActions.get(messageId);
  if (!entry) return null;

  if (Date.now() - entry.timestamp > ACTION_TTL_MS) {
    pendingActions.delete(messageId);
    return null;
  }

  return entry;
}

export function clearPendingAction(messageId) {
  pendingActions.delete(messageId);
}
