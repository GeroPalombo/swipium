// Auth-screen heuristic (Phase 2.2 P1.5). Classifies whether the current screen looks like a
// login/sign-in surface vs an authenticated screen — purely from the UI tree, no credentials.
// Used to report whether login was needed / performed / skipped (persisted session).

import { isSecureNode } from '../lib/redact.js';
import type { RawNode } from '../snapshot/parse.js';

const LOGIN_TEXT_RE = /sign ?in|log ?in|forgot password|create account|sign ?up|continue with (google|apple|facebook)|enter your (email|password)|welcome back/i;
const EMAIL_HINT_RE = /e-?mail|username/i;

export interface AuthScreen {
  isLoginScreen: boolean;
  hasPasswordField: boolean;
  signals: string[];
}

export function detectAuthScreen(nodes: RawNode[]): AuthScreen {
  const signals: string[] = [];
  const hasPasswordField = nodes.some((n) => isSecureNode(n));
  if (hasPasswordField) signals.push('password-field');

  const joined = nodes.map((n) => `${n.text} ${n.desc}`).join('  ');
  if (LOGIN_TEXT_RE.test(joined)) signals.push('login-copy');
  if (EMAIL_HINT_RE.test(joined)) signals.push('email-field');

  // A password field is decisive; otherwise require two corroborating text signals to avoid
  // flagging an ordinary screen that merely mentions "sign in" in a footer link.
  const isLoginScreen = hasPasswordField || signals.filter((s) => s !== 'password-field').length >= 2;
  return { isLoginScreen, hasPasswordField, signals };
}
