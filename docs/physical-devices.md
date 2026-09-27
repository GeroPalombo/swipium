# Physical Devices — Scoping Design (Roadmap)

Status: **out of scope** for the current release. This document scopes what first-class
physical-device support would require, so the boundary is deliberate rather than accidental.
Until everything in "Required before shipping" lands, Swipium refuses physical devices with the
typed failure code `PHYSICAL_DEVICE_UNSUPPORTED` (bucket `unsafe_refused`) — visible but refused,
so agents can explain *why* instead of reporting a bare "no device".

## Current behavior

- `qa_resolve_target` sees physical devices (adb enumerates them) but never selects one. If a
  physical device is the only candidate — or is explicitly requested via `device`/
  `preferRealDevice` — the plan is blocked with `PHYSICAL_DEVICE_UNSUPPORTED` and, when an
  emulator/simulator is viable, lists it as the alternative.
- `qa_test_this` blocks real-device requests and real-device-only iOS artifacts the same way.
- The refusal is server-side policy, not client-negotiable: a client cannot opt into physical
  devices by assertion (consistent with the consent model in `THREAT_MODEL.md`).

## Why the line is drawn here

A developer's simulator/emulator is a disposable sandbox. A physical device usually is not:

1. **Real user data.** Personal accounts, photos, messages, payment instruments, and 2FA apps
   live on real hardware. `clear_data`, fresh installs, permission resets, and exploratory
   tapping have real blast radius.
2. **Non-restorable environment mutations.** `wm size`/density overrides, airplane-mode toggles,
   geolocation spoofing, and animation-scale changes are harmless on an emulator that gets
   recreated, but leave a person's phone in a broken-feeling state if a run dies mid-restore.
3. **Identity and signing.** iOS real devices require Apple code signing and device trust;
   automation identity (WDA on-device) has store/account implications the simulator path avoids.
4. **Fleet variance.** OEM skins, battery optimizers, and vendor permission dialogs multiply the
   overlay/interstitial matrix that the oracle currently models for AOSP-like emulators.

## Required before shipping (design contract)

Same tool surface — `deviceClass: "physical"` as an explicit opt-in on target resolution, plus:

- **Threat-model addendum** (extend `THREAT_MODEL.md` per its "Explicit Non-Goals" clause):
  real-user-data adversary analysis; consent escalation for every mutation that touches device
  state; explicit non-support for carrier/eSIM/payment surfaces.
- **Mutation policy:** no `wm size`/density overrides; no geolocation spoof without per-action
  consent; `clear_data`/uninstall gated on the app-under-test's applicationId only, never
  system or third-party packages; mandatory restore verification at session end.
- **Data-safety preflight:** refuse when the device reports accounts/profiles that indicate a
  personal (non-lab) device unless the user affirms it is a test device; document the heuristics.
- **iOS reality check:** WDA on real hardware needs signing assets; decide between "bring your
  own signed WDA" and full signing automation before promising iOS parity.
- **Evidence hygiene:** screenshots/OCR from a personal device can capture other apps'
  notifications; sensitive-mode must default stricter on physical hardware.

## Non-goals even then

Remote device farms, multi-tenant device brokering, and anything that ships device data off the
machine remain out of scope (see `THREAT_MODEL.md` non-goals).
