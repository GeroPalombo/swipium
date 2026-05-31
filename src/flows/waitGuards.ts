export const DEFAULT_SELECTOR_WAIT_MS = 8000;

/** Build the Flow V2 wait guard that should precede a generated selector action. */
export function waitForVisibleGuard(selector: string, timeoutMs = DEFAULT_SELECTOR_WAIT_MS): Record<string, unknown> {
  const id = selector.match(/^id\s*=\s*(.+)$/i)?.[1];
  if (id) return { waitForVisible: { id, timeoutMs } };

  const accessibilityId = selector.match(/^accessibility id\s*=\s*(.+)$/i)?.[1];
  if (accessibilityId) return { waitForVisible: { 'accessibility id': accessibilityId, timeoutMs } };

  return { waitForVisible: { text: selector, timeoutMs } };
}
