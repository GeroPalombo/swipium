// Flow correctness fixes:
//  - text/desc/id visibility ignores the Android package prefix of a resource-id;
//  - invalid step options are parse errors instead of silently falling back to defaults, and a
//    YAML number given as tap/inputText text keeps its written spelling;
//  - cancellation unwinds assertNotVisible / scrollTo / seeds as CANCELLED;
//  - the launch foreground check matches the package exactly;
//  - waitForVisible timeoutMs:0 still checks the screen once;
//  - secret variable names and inline secret literals match whole words.

import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.HOME = mkdtempSync(join(tmpdir(), 'swipium-flowfix-home-'));
process.env.SWIPIUM_DISABLE_DEVICE_DISCOVERY = '1';

const { runFlow, visible } = await import('../src/flows/run.js');
const { parseFlow, isSecretVarName, SECRET_VAR_NAME } = await import('../src/flows/schema.js');
const { lintFlowObjectWithOptions } = await import('../src/flows/lint.js');
const { executeSeed } = await import('../src/flows/seedExec.js');
const { runWithSignal } = await import('../src/lib/abortScope.js');
const { SessionStore } = await import('../src/session/store.js');
type Driver = import('../src/drivers/Driver.js').Driver;
type Flow = import('../src/flows/schema.js').Flow;
type FlowStep = import('../src/flows/schema.js').FlowStep;

const PKG = 'com.acme.checkout';

function xml(): string {
  return (
    `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation="0">` +
    `<node class="android.widget.FrameLayout" package="${PKG}" text="" resource-id="" content-desc="" bounds="[0,0][1080,1920]" clickable="false" enabled="true">` +
    `<node class="android.widget.TextView" text="Home" resource-id="${PKG}:id/title" content-desc="" bounds="[40,100][1040,180]" clickable="false" enabled="true"/>` +
    `<node class="android.widget.Button" text="Pay" resource-id="${PKG}:id/pay_button" content-desc="" bounds="[40,300][1040,400]" clickable="true" enabled="true"/>` +
    `</node></hierarchy>`
  );
}

function abortError(): Error {
  const e = new Error('aborted');
  e.name = 'AbortError';
  return e;
}

class Fake implements Driver {
  readonly kind = 'direct' as const;
  fg = `${PKG}/.Main`;
  swipes = 0;
  existsBySelector?: (using: string, value: string) => Promise<boolean>;
  async listDevices() {
    return ['fake'];
  }
  useDevice() {}
  currentDevice() {
    return 'fake';
  }
  async installApp() {}
  async isInstalled() {
    return true;
  }
  async isRunning() {
    return true;
  }
  async launchApp() {}
  async terminateApp() {}
  async clearData() {}
  async imeShown() {
    return false;
  }
  async logcat() {
    return '';
  }
  async airplaneOn() {
    return false;
  }
  async setAirplane() {}
  async foregroundOwner() {
    return this.fg;
  }
  async screenshot() {
    return Buffer.alloc(0);
  }
  async dumpXml() {
    return xml();
  }
  async tapXY() {}
  async pressXY() {}
  async inputText() {}
  async clearFocusedText() {}
  async pressKey() {}
  async swipe() {
    this.swipes++;
  }
  async adbReverseMetro() {}
  async screenSize() {
    return { width: 1080, height: 1920 };
  }
  async screenDensity() {
    return 420;
  }
  async openUrl() {}
  async disableAnimations() {}
}

function flowOf(steps: FlowStep[]): Flow {
  return { name: 'fix', appId: PKG, mode: 'structured', fixtures: [], setup: [], teardown: [], steps } as Flow;
}

async function runWith(fake: Fake, steps: FlowStep[], signal?: AbortSignal) {
  const sessions = new SessionStore();
  const session = sessions.create(mkdtempSync(join(tmpdir(), 'swipium-flowfix-proj-')));
  session.appId = PKG;
  return runWithSignal(signal, () => runFlow(sessions, session, fake, flowOf(steps)));
}

describe('visibility ignores the resource-id package prefix', () => {
  const nodes = (id: string) => ({ allNodes: [{ text: 'Pay', desc: '', id }] });

  it('a word from the package name is not visible on every screen', () => {
    expect(visible(nodes(`${PKG}:id/pay_button`), 'checkout')).toBe(false);
    expect(visible(nodes(`${PKG}:id/pay_button`), 'pay_button')).toBe(true);
  });

  it('iOS identifiers (no package prefix) are matched whole', () => {
    expect(visible(nodes('checkoutButton'), 'checkout')).toBe(true);
  });

  it('assertNotVisible on a package word passes and assertVisible fails', async () => {
    const r1 = await runWith(new Fake(), [{ kind: 'assertNotVisible', query: 'Checkout' }]);
    expect(r1.passed).toBe(true);
    const r2 = await runWith(new Fake(), [{ kind: 'waitForVisible', query: 'Checkout', timeoutMs: 0 }]);
    expect(r2.passed).toBe(false);
  }, 20_000);
});

describe('waitForVisible timeoutMs:0', () => {
  it('checks the screen once instead of timing out without looking', async () => {
    const r = await runWith(new Fake(), [{ kind: 'waitForVisible', query: 'Home', timeoutMs: 0 }]);
    expect(r.passed).toBe(true);
  }, 20_000);
});

describe('launch foreground check', () => {
  it('warns when a sibling package with the same prefix is in front', async () => {
    const fake = new Fake();
    fake.fg = `${PKG}.debug/.Main`;
    const r = await runWith(fake, [{ kind: 'prepareTarget' }]);
    expect(r.steps[0].detail).toMatch(/foreground is com\.acme\.checkout\.debug/);
  }, 20_000);
});

describe('cancellation is CANCELLED, not BACKEND_UNSUPPORTED', () => {
  it('assertNotVisible rethrows an abort from the native selector check', async () => {
    const fake = new Fake();
    fake.existsBySelector = async () => {
      throw abortError();
    };
    const r = await runWith(fake, [{ kind: 'assertNotVisible', query: 'accessibility id=pay' }]);
    expect(r.passed).toBe(false);
    expect(r.failureCode).toBe('CANCELLED');
  }, 20_000);

  it('scrollTo rethrows an abort from the native selector check', async () => {
    const fake = new Fake();
    fake.existsBySelector = async () => {
      throw abortError();
    };
    const r = await runWith(fake, [{ kind: 'scrollTo', query: 'accessibility id=pay' }]);
    expect(r.failureCode).toBe('CANCELLED');
  }, 20_000);

  it('scrollTo stops scrolling as soon as the call is cancelled', async () => {
    const fake = new Fake();
    const ac = new AbortController();
    fake.existsBySelector = async () => {
      setTimeout(() => ac.abort(), 20);
      return false;
    };
    const started = Date.now();
    const r = await runWith(fake, [{ kind: 'scrollTo', query: 'accessibility id=missing' }], ac.signal);
    expect(r.failureCode).toBe('CANCELLED');
    expect(fake.swipes).toBeLessThan(8);
    expect(Date.now() - started).toBeLessThan(3000);
  }, 20_000);
});

describe('seed execution honors the call signal', () => {
  const setup = () => {
    const sessions = new SessionStore();
    const session = sessions.create(mkdtempSync(join(tmpdir(), 'swipium-seed-proj-')));
    return { sessions, session };
  };

  it('an API seed fetch carries a signal that follows the call', async () => {
    const { sessions, session } = setup();
    const ac = new AbortController();
    let seen: AbortSignal | undefined;
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
      seen = init?.signal ?? undefined;
      return new Response('ok', { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    try {
      const r = await runWithSignal(ac.signal, () =>
        executeSeed(sessions, session, undefined, 'user', { type: 'api', url: 'http://127.0.0.1:9/seed' }),
      );
      expect(r.ok).toBe(true);
      expect(seen).toBeInstanceOf(AbortSignal);
      expect(seen!.aborted).toBe(false);
      ac.abort();
      expect(seen!.aborted).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('a script seed is killed when the call is cancelled', async () => {
    const { sessions, session } = setup();
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 100);
    const started = Date.now();
    await expect(
      runWithSignal(ac.signal, () =>
        executeSeed(sessions, session, undefined, 'slow', {
          type: 'script',
          command: [process.execPath, '-e', 'setTimeout(() => {}, 20000)'],
        }),
      ),
    ).rejects.toBeTruthy();
    expect(Date.now() - started).toBeLessThan(5000);
  }, 20_000);
});

describe('flow schema rejects invalid options', () => {
  const errorsOf = (step: string) => parseFlow(`name: x\nsteps:\n  - ${step}\n`).errors;

  it('an unknown note outcome is an error, not a pass', () => {
    expect(errorsOf('note: { outcome: failed, reason: "r" }').join(' ')).toMatch(/note outcome must be one of/);
    const ok = parseFlow('name: x\nsteps:\n  - note: { outcome: blocked, reason: "r" }\n');
    expect(ok.flow?.steps[0]).toEqual({ kind: 'note', outcome: 'blocked', reason: 'r' });
    const dflt = parseFlow('name: x\nsteps:\n  - note: { reason: "r" }\n');
    expect(dflt.flow?.steps[0]).toMatchObject({ outcome: 'pass' });
  });

  it('swipe area and distance are validated', () => {
    expect(errorsOf('swipe: { direction: up, area: middle }').join(' ')).toMatch(/swipe area must be one of/);
    expect(errorsOf('swipe: { direction: up, distance: 0 }').join(' ')).toMatch(/distance must be a number greater than 0/);
    expect(errorsOf('swipe: { direction: up, distance: 1.5 }')).toHaveLength(1);
    expect(errorsOf('swipe: { direction: up, distance: "far" }')).toHaveLength(1);
    const ok = parseFlow('name: x\nsteps:\n  - swipe: { direction: up, area: top, distance: 0.4 }\n');
    expect(ok.flow?.steps[0]).toEqual({ kind: 'swipe', direction: 'up', area: 'top', distance: 0.4 });
  });

  it('minScore, minConfidence and threshold must be within 0..1', () => {
    expect(errorsOf('tapImage: { template: a.png, minScore: 85 }').join(' ')).toMatch(/minScore must be a number from 0 to 1/);
    expect(errorsOf('assertImage: { template: a.png, minScore: "high" }')).toHaveLength(1);
    expect(errorsOf('tapOcrText: { text: Pay, minConfidence: -0.1 }').join(' ')).toMatch(/minConfidence/);
    expect(errorsOf('assertOcrText: { text: Pay, minConfidence: 2 }')).toHaveLength(1);
    expect(errorsOf('assertDiff: { baseline: home, threshold: 5 }').join(' ')).toMatch(/threshold/);
    const ok = parseFlow(
      'name: x\nsteps:\n  - assertDiff: { baseline: home, threshold: 0 }\n  - tapImage: { template: a.png, minScore: 1 }\n',
    );
    expect(ok.errors).toEqual([]);
  });

  it('inputText secret / into of the wrong type and a non-list fixtures are errors', () => {
    expect(errorsOf('inputText: { text: a, secret: "yes" }').join(' ')).toMatch(/secret must be true or false/);
    expect(errorsOf('inputText: { text: a, into: 3 }').join(' ')).toMatch(/into must be a selector string/);
    expect(parseFlow('name: x\nfixtures: user\nsteps:\n  - tap: Pay\n').errors.join(' ')).toMatch(/fixtures/);
  });

  it('a YAML number for tap / inputText text keeps the spelling the author wrote', () => {
    const p = parseFlow('name: x\nsteps:\n  - tap: 1\n  - inputText: 007\n  - inputText: { into: Code, text: 1.50 }\n');
    expect(p.errors).toEqual([]);
    expect(p.flow?.steps[0]).toEqual({ kind: 'tap', selector: '1' });
    expect(p.flow?.steps[1]).toMatchObject({ kind: 'inputText', value: '007' });
    expect(p.flow?.steps[2]).toMatchObject({ kind: 'inputText', value: '1.50', into: 'Code' });
  });
});

describe('secret names match whole words', () => {
  it('keeps real credential names', () => {
    for (const name of [
      'SWIPIUM_TEST_PASSWORD',
      'API_KEY',
      'apiKey',
      'OTP_CODE',
      'PIN',
      'SWIPIUM_VERIFICATION_CODE',
      'SWIPIUM_APIKEY',
      'CLIENTSECRET',
      'authToken',
      'SWIPIUM_OTPCODE',
      'CARD_CVV',
      'otp2',
    ])
      expect(isSecretVarName(name), name).toBe(true);
    expect(SECRET_VAR_NAME.test('SWIPIUM_TEST_PASSWORD')).toBe(true);
  });

  it('no longer matches words that merely contain a short one', () => {
    for (const name of ['SHIPPING', 'KEYWORD', 'SWIPIUM_PASSENGER_NAME', 'SPINNER', 'BARCODE_FORMAT', 'SWIPIUM_TEST_EMAIL'])
      expect(isSecretVarName(name), name).toBe(false);
  });

  it('a shipping variable in a flow is not registered as secret', () => {
    const p = parseFlow('name: x\nsteps:\n  - inputText: "${SWIPIUM_SHIPPING_ZIP}"\n  - inputText: "${SWIPIUM_PIN}"\n');
    expect(p.flow?.steps.map((s) => (s as { secret?: boolean }).secret)).toEqual([false, true]);
  });

  it('lint flags inline credentials but not ordinary text', () => {
    const lintCodes = (text: string) => {
      const flow = parseFlow(`name: x\nsteps:\n  - inputText: ${JSON.stringify(text)}\n`).flow!;
      return lintFlowObjectWithOptions('x.yaml', flow).map((f) => f.code);
    };
    expect(lintCodes('secret santa')).not.toContain('INLINE_SECRET');
    expect(lintCodes('free shipping')).not.toContain('INLINE_SECRET');
    expect(lintCodes('hotpot')).not.toContain('INLINE_SECRET');
    expect(lintCodes('hunter2Password')).toContain('INLINE_SECRET');
    expect(lintCodes('my_api_key_123')).toContain('INLINE_SECRET');
    expect(lintCodes('password: hunter2')).toContain('INLINE_SECRET');
    expect(lintCodes('mytoken')).toContain('INLINE_SECRET');
  });
});
