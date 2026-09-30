// Physical devices are visible but REFUSED with a typed code (docs/physical-devices.md):
// agents must be able to explain *why*, never see a bare NO_DEVICE when hardware is present.
import { describe, expect, it } from 'vitest';
import { planTarget, type TargetInputs } from '../src/core/targetPlan.js';

const base = (over: Partial<TargetInputs> = {}): TargetInputs => ({
  android: { online: [], avds: [] },
  ios: { bootedSimulators: [], availableSimulators: [] },
  ...over,
});

describe('planTarget physical-device policy', () => {
  it('refuses a physical Android device with PHYSICAL_DEVICE_UNSUPPORTED when it is the only candidate', () => {
    const plan = planTarget(base({ android: { online: ['R5CN30XXXX'], avds: [] } }));
    expect(plan.selected).toBeNull();
    expect(plan.blocked?.failureCode).toBe('PHYSICAL_DEVICE_UNSUPPORTED');
    expect(plan.blocked?.detail).toContain('R5CN30XXXX');
  });

  it('prefers the emulator and mentions the visible physical device in the reason', () => {
    const plan = planTarget(base({ android: { online: ['emulator-5554', 'R5CN30XXXX'], avds: [] } }));
    expect(plan.selected).toBe('android-emulator');
    expect(plan.device).toBe('emulator-5554');
    expect(plan.reason).toContain('R5CN30XXXX');
    expect(plan.blocked).toBeUndefined();
  });

  it('boots an AVD instead of selecting an online physical device', () => {
    const plan = planTarget(base({ android: { online: ['R5CN30XXXX'], avds: ['Pixel_8'] } }));
    expect(plan.selected).toBe('android-emulator');
    expect(plan.willBoot).toBe(true);
    expect(plan.bootTarget).toBe('Pixel_8');
  });

  it('refuses preferRealDevice even when a physical device is online, offering the emulator alternative', () => {
    const plan = planTarget(
      base({ preferRealDevice: true, requestedPlatform: 'android', android: { online: ['emulator-5554', 'R5CN30XXXX'], avds: [] } }),
    );
    expect(plan.blocked?.failureCode).toBe('PHYSICAL_DEVICE_UNSUPPORTED');
    expect(plan.alternatives).toContain('android-emulator');
  });

  it('refuses an explicitly requested physical Android serial', () => {
    const plan = planTarget(base({ requestedDevice: 'R5CN30XXXX', android: { online: ['R5CN30XXXX'], avds: ['Pixel_8'] } }));
    expect(plan.blocked?.failureCode).toBe('PHYSICAL_DEVICE_UNSUPPORTED');
    expect(plan.alternatives).toContain('android-emulator');
  });

  it('refuses a requested real iOS device and points at the simulator when one exists', () => {
    const plan = planTarget(
      base({
        requestedDevice: 'udid-real-1',
        ios: {
          bootedSimulators: [{ udid: 'sim-1', name: 'iPhone 16' }],
          availableSimulators: [],
          realDevices: ['udid-real-1'],
        },
      }),
    );
    expect(plan.blocked?.failureCode).toBe('PHYSICAL_DEVICE_UNSUPPORTED');
    expect(plan.alternatives).toContain('ios-simulator');
  });

  it('still returns NO_DEVICE when nothing at all is available', () => {
    const plan = planTarget(base());
    expect(plan.blocked?.failureCode).toBe('NO_DEVICE');
  });
});

describe('planTarget property-verified emulators (H6)', () => {
  it('treats a non-`emulator-N` serial listed in android.emulators as an emulator', () => {
    const plan = planTarget(base({ android: { online: ['localhost:5555'], avds: [], emulators: ['localhost:5555'] } }));
    expect(plan.selected).toBe('android-emulator');
    expect(plan.device).toBe('localhost:5555');
    const requested = planTarget(
      base({ requestedDevice: 'localhost:5555', android: { online: ['localhost:5555'], avds: [], emulators: ['localhost:5555'] } }),
    );
    expect(requested.blocked).toBeUndefined();
  });
});
