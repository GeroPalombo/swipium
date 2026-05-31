import { describe, expect, it } from 'vitest';
import { displayArgv, resolveCommandTemplate } from '../src/lib/commandTemplate.js';

describe('command templates', () => {
  it('resolves argv arrays without using shell strings', () => {
    const resolved = resolveCommandTemplate(['xcrun', 'simctl', 'boot', '{udid}'], { udid: 'ABC 123' });

    expect(resolved.command).toBe('xcrun');
    expect(resolved.args).toEqual(['simctl', 'boot', 'ABC 123']);
    expect(resolved.deprecatedString).toBe(false);
    expect(displayArgv(resolved.argv)).toBe('xcrun simctl boot "ABC 123"');
  });
});
