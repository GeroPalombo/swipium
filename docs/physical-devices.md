# Physical devices

Status: **not supported in Swipium 2.0.** Swipium runs only on Android Emulators and iOS
Simulators. A physical device is visible to Swipium, but every path that could act on it refuses it
with the typed failure code `PHYSICAL_DEVICE_UNSUPPORTED` (bucket `unsafe_refused`), so an agent can
explain *why* instead of reporting a bare "no device". The refusal is server-side policy. A client
cannot opt in by passing a flag. This page describes the current behavior and what support would
need.

## Current behavior

| Path | What happens with a physical device |
| --- | --- |
| `qa_resolve_target` | Lists it but never selects it. If it is the only candidate, or is requested with `device`, the plan is blocked with `PHYSICAL_DEVICE_UNSUPPORTED` and a viable emulator or simulator is offered as the alternative. `preferRealDevice:true` always returns the refusal. |
| `qa_test_this` | Refuses `preferRealDevice:true`, an explicit physical `device` serial, and iOS artifacts that only install on real hardware (device-only `.ipa` or `.app` builds). |
| `qa_prepare_target` | Refuses a physical serial before anything is installed or launched. When it boots an emulator, it binds only a serial that was not online before the boot, so a phone that happens to be plugged in is never picked up. |
| Device auto-attach (any tool that needs a device) | Before binding the single online device, Swipium probes it. A physical device is refused, a still-booting emulator returns `DEVICE_NOT_READY`, and a device whose properties cannot be read (offline or unauthorized) is not bound. |
| iOS | Swipium enumerates simulators only, through `xcrun simctl`. Real iPhones and iPads are never listed or targeted. |

## How Android emulators are recognized

adb lists emulators and phones side by side, so Swipium classifies each online serial
(`src/session/attach.ts`, `src/core/targetPlan.ts`):

1. A serial of the form `emulator-<port>` is an emulator.
2. Any other serial, for example `localhost:5555`, `127.0.0.1:<port>` or a Genymotion address, is
   probed once with `adb -s <serial> shell getprop`. It is treated as an emulator when any of these
   is true:
   - `ro.kernel.qemu` or `ro.boot.qemu` is `1`;
   - `ro.hardware` is `goldfish` or `ranchu`;
   - `ro.genymotion.version` is set, or `ro.product.manufacturer` is `Genymotion`.
3. Everything else whose properties could be read is physical and is refused.
4. An emulator is used only once `sys.boot_completed` is `1`.

`qa_test_this`, `qa_resolve_target`, `qa_prepare_target` and device auto-attach all use this
property probe, so a network-attached emulator (`localhost:5555`, Genymotion) is accepted everywhere.

## Why the line is drawn here

A developer's emulator or simulator is a disposable sandbox. A physical device usually is not:

1. **Real user data.** Personal accounts, photos, messages, payment methods and 2FA apps live on
   real hardware. Data wipes, fresh installs, permission resets and exploratory tapping have real
   consequences there.
2. **Changes that can't be undone.** Screen size and density overrides, airplane-mode toggles,
   location spoofing and animation-scale changes do no harm on an emulator you can recreate. On a
   person's phone they leave it feeling broken if a run dies before restoring them.
3. **Identity and signing.** Real iOS devices need Apple code signing and device trust. Running
   WebDriverAgent on hardware brings account and provisioning questions that the simulator path
   avoids.
4. **Fleet variance.** OEM skins, battery optimizers and vendor permission dialogs multiply the
   overlays and interstitials that Swipium's oracle currently models for AOSP-like emulators.

## Roadmap: what support would require

Physical-device support is not scheduled. It would keep the same tool surface, with an explicit
opt-in on target resolution, and it would need at least:

- **A threat-model extension** (per the out-of-scope clause in `THREAT_MODEL.md`): analysis of the
  real-user-data adversary, stronger consent for every change to device state, and explicit
  non-support for carrier, eSIM and payment surfaces.
- **A mutation policy:** no screen size or density overrides; no location spoofing without consent
  for each action; data wipes and uninstalls limited to the app under test, never system or
  third-party packages; and a mandatory check at session end that everything was restored.
- **A data-safety preflight:** refuse devices whose accounts or profiles suggest a personal phone
  rather than a lab device, unless the user confirms it is a test device, with the heuristics
  documented.
- **An iOS decision:** "bring your own signed WebDriverAgent" versus full signing automation,
  before promising parity with iOS Simulator support.
- **Evidence hygiene:** screenshots and OCR on a personal device can capture other apps'
  notifications, so sensitive mode would need stricter defaults on hardware.

Remote device farms, multi-tenant device brokering, and anything that sends device data off the
machine stay out of scope even then.
