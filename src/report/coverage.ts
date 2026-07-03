import type { Driver } from '../drivers/Driver.js';
import type { Session } from '../session/store.js';

export interface AutomationBackendReport {
  kind: Driver['kind'] | 'unknown';
  mode: string;
  structured: boolean;
  description: string;
}

function driverKind(driver: Driver | undefined): Driver['kind'] | undefined {
  return driver?.kind;
}

export function coverageForSession(session: Pick<Session, 'device' | 'driver'>): string {
  const device = session.device ?? session.driver?.currentDevice?.();
  const kind = driverKind(session.driver);
  if (kind === 'direct') {
    if (!device) return 'Android emulator target unknown';
    return device.startsWith('emulator-') ? 'Android Emulator only' : 'Android physical device is outside public v1 scope';
  }
  if (kind === 'simulator') return 'iOS Simulator visual coverage';
  if (kind === 'wda') return 'iOS Simulator structured WDA coverage';
  return 'emulator/simulator coverage only';
}

export function automationBackendForSession(session: Pick<Session, 'device' | 'driver'>): AutomationBackendReport {
  const kind = driverKind(session.driver);
  if (kind === 'direct') {
    return {
      kind,
      mode: 'android-emulator-structured-adb',
      structured: true,
      description: 'Android structured ADB/UIAutomator on an emulator',
    };
  }
  if (kind === 'remote') {
    return {
      kind,
      mode: 'remote-structured',
      structured: true,
      description: 'Remote structured automation backend',
    };
  }
  if (kind === 'simulator') {
    return {
      kind,
      mode: 'ios-simulator-visual-simctl',
      structured: false,
      description: 'iOS Simulator visual-only simctl backend; structured taps, typing, and snapshots require WDA',
    };
  }
  if (kind === 'wda') {
    return {
      kind,
      mode: 'ios-simulator-structured-wda',
      structured: true,
      description: 'iOS Simulator structured WebDriverAgent backend',
    };
  }
  return {
    kind: 'unknown',
    mode: 'unknown',
    structured: false,
    description: 'No automation backend was selected',
  };
}
