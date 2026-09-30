// qa_generate target:"pom" (runPomGenerate) must use the same secret-guard options as the suite and
// flow generators: recorded selectors/screens are structural (a common-word secret like "test" must
// not block generation because a locator id is literally "test"), while a real secret still blocks.
import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const fakeHome = mkdtempSync(join(tmpdir(), 'swipium-pom-secrets-home-'));
process.env.HOME = fakeHome;
process.env.SWIPIUM_DISABLE_DEVICE_DISCOVERY = '1';

const { SessionStore } = await import('../src/session/store.js');
const { runPomGenerate } = await import('../src/tools/suite.js');
type RecordedAction = import('../src/session/store.js').RecordedAction;

const root = mkdtempSync(join(tmpdir(), 'swipium-pom-secrets-proj-'));
writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'demo', version: '1.0.0' }));

afterAll(() => {
  rmSync(fakeHome, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

const act = (a: Partial<RecordedAction> & { action: string }): RecordedAction =>
  ({ at: 0, exportability: 'semantic', screen: 'com.example/.LoginActivity', ...a }) as RecordedAction;

describe('runPomGenerate secret guard', () => {
  it('does not refuse generation when a common-word secret only appears in locators', async () => {
    const sessions = new SessionStore();
    const s = sessions.create(root, undefined, {});
    s.secrets.add('test');
    s.recordedActions.push(
      act({ action: 'tap', selector: 'test', selectorKind: 'resource_id' }), // locator id equals the secret word
      act({ action: 'type', selector: 'password', selectorKind: 'resource_id', text: '${SWIPIUM_TEST_PASSWORD}', secret: true }),
    );
    const r = await runPomGenerate(sessions, { sessionId: s.id });
    expect(r.isError).toBeFalsy();
    const sc = r.structuredContent as { files: Array<{ content: string }> };
    expect(sc.files.map((f) => f.content).join('\n')).toContain('"test"');
  });
});
