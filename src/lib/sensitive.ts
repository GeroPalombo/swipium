// Sensitive-mode refusal (Security: sensitive-mode session option). A single, honest
// refusal for any pixel/video/log capture when the session opted into sensitive mode, so a
// privacy-sensitive project can run Swipium with no screen contents leaving the device.

import { qaError } from './result.js';
import type { CallToolResult } from '@modelcontextprotocol/server';

export function sensitiveRefusal(what: string): CallToolResult {
  return qaError({
    what: `${what} refused: this session is in sensitive mode (no screenshots/video/logs are captured)`,
    changedState: false,
    retrySafe: false,
    failureCode: 'SENSITIVE_MODE_REFUSED',
    nextSteps: [
      'Start a non-sensitive session (omit sensitive:true) to capture pixels, or rely on structured snapshot + health, which carry no screen contents.',
    ],
  });
}
