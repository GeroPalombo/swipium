// qa_device_info + qa_orientation: device-parity introspection and rotation,
// without raw adb. Read-only info needs no consent; orientation is a logged, non-destructive
// environment change.

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { qaOk, qaError, unknownSessionError } from '../lib/result.js';
import { requireConsent, consumeConsent } from '../consent/consent.js';
import { blockedDeviceResult, getDriver } from '../session/attach.js';
import { listSimulators, type Simulator } from '../lib/simctl.js';
import { getDeviceProps, getOrientation, setOrientation, listPackages, setGeo } from '../lib/device.js';
import type { SessionStore } from '../session/store.js';
import { invalidateScreenSizeCache } from '../drivers/DirectDriver.js';

function rotationLabel(rotation: number, auto: boolean): string {
  return auto ? 'auto' : rotation === 1 || rotation === 3 ? 'landscape' : 'portrait';
}

export function registerDevice(server: McpServer, sessions: SessionStore): void {
  server.registerTool(
    'qa_device_info',
    {
      title: 'Device info',
      description:
        'Read-only device info (no consent). Android: model/manufacturer/SDK+release, ABIs, locale, timezone, screen size/density, orientation, third-party app count (listPackages:true, optionally packageFilter, adds names). iOS Simulator: name, runtime, state, screen size.',
      inputSchema: {
        sessionId: z.string(),
        listPackages: z.boolean().optional().describe('Include installed third-party package names.'),
        packageFilter: z.string().optional().describe('Substring filter for the package list.'),
      },
    },
    async ({ sessionId, listPackages: withPkgs, packageFilter }) => {
      const session = sessions.get(sessionId);
      if (!session) return unknownSessionError(sessionId);
      const { driver, blocked } = await getDriver(session);
      const serial = driver?.currentDevice();
      if (!session || !driver || !serial) {
        return (
          blockedDeviceResult(blocked) ??
          qaError({
            what: 'No device attached to this session',
            changedState: false,
            retrySafe: true,
            nextSteps: ['Call qa_prepare_target first.'],
          })
        );
      }
      if (driver.kind === 'simulator' || driver.kind === 'wda') {
        // H9: the getprop/settings helpers below are adb-only. On an iOS simulator they would
        // return ok:true with every field null. Report what simctl actually knows instead.
        const sims = await listSimulators().catch(() => [] as Simulator[]);
        const sim = sims.find((x) => x.udid === serial);
        const screen = await driver.screenSize().catch(() => null);
        const payload = {
          device: serial,
          platform: 'ios',
          backend: driver.kind,
          props: { name: sim?.name ?? null, runtime: sim?.runtime ?? null, state: sim?.state ?? null },
          screen,
          orientation: 'unknown',
          unsupported: ['orientation', 'installedThirdPartyCount', 'packages', 'abis', 'locale', 'timezone'],
        };
        return qaOk(
          payload,
          `iOS simulator ${sim?.name ?? serial} · ${sim?.runtime ?? 'runtime ?'} · ${sim?.state ?? '?'}
` + `screen ${screen ? `${screen.width}x${screen.height}pt` : '?'} · orientation/packages/locale are not available via simctl`,
        );
      }
      if (driver.kind !== 'direct') {
        return qaError({
          what: `Device info is not supported on the "${driver.kind}" backend`,
          changedState: false,
          retrySafe: false,
          failureCode: 'BACKEND_UNSUPPORTED',
          nextSteps: ['Use an Android emulator (adb) or an iOS simulator session.'],
        });
      }
      const [props, screen, density, orientation, pkgs] = await Promise.all([
        getDeviceProps(serial),
        driver.screenSize().catch(() => null),
        driver.screenDensity().catch(() => null),
        getOrientation(serial),
        listPackages(serial, { thirdPartyOnly: true, filter: packageFilter }),
      ]);
      const orient = orientation ? rotationLabel(orientation.rotation, orientation.auto) : 'unknown';
      const payload = {
        device: serial,
        props,
        screen: screen ? { ...screen, density } : null,
        orientation: orient,
        rotation: orientation?.rotation ?? null,
        autoRotate: orientation?.auto ?? null,
        installedThirdPartyCount: pkgs.length,
        ...(withPkgs ? { packages: pkgs } : {}),
      };
      const summary =
        `${props.manufacturer ?? '?'} ${props.model ?? '?'} · Android ${props.release ?? '?'} (SDK ${props.sdk ?? '?'}) · ${props.abis[0] ?? '?'}\n` +
        `screen ${screen ? `${screen.width}x${screen.height}@${density ?? '?'}dpi` : '?'} · orientation ${orient} · locale ${props.locale ?? '?'} · tz ${props.timezone ?? '?'}\n` +
        `${pkgs.length} third-party apps installed${withPkgs ? ':\n  ' + pkgs.join('\n  ') : ' (listPackages:true to list)'}`;
      return qaOk(payload, summary);
    },
  );

  server.registerTool(
    'qa_orientation',
    {
      title: 'Set orientation',
      description:
        'Set screen orientation (Android Emulator only): portrait | landscape | auto (re-enables auto-rotate). Non-destructive; logged as an environment change and surfaced in qa_report.',
      inputSchema: {
        sessionId: z.string(),
        orientation: z.enum(['portrait', 'landscape', 'auto']),
      },
    },
    async ({ sessionId, orientation }) => {
      const session = sessions.get(sessionId);
      if (!session) return unknownSessionError(sessionId);
      const { driver, blocked } = await getDriver(session);
      const serial = driver?.currentDevice();
      if (!session || !driver || !serial) {
        return (
          blockedDeviceResult(blocked) ??
          qaError({
            what: 'No device attached to this session',
            changedState: false,
            retrySafe: true,
            nextSteps: ['Call qa_prepare_target first.'],
          })
        );
      }
      if (driver.kind !== 'direct') {
        // H9: setOrientation drives adb `settings put`, so on iOS it would fail or no-op.
        return qaError({
          what: 'Setting orientation is only supported on the Android emulator backend',
          changedState: false,
          retrySafe: false,
          failureCode: 'BACKEND_UNSUPPORTED',
          nextSteps: ['On an iOS simulator, rotate from the Simulator menu (Device > Rotate Left/Right) or via your WDA client.'],
        });
      }
      try {
        await setOrientation(serial, orientation);
      } catch (e) {
        invalidateScreenSizeCache(serial); // a partial failure may still have rotated the device
        return qaError({
          what: `Could not set orientation: ${String(e)}`,
          changedState: false,
          retrySafe: true,
          nextSteps: ['Confirm the device is online.'],
        });
      }
      // DirectDriver caches screen size + rotation for a short TTL. Drop it so the very next
      // swipe/keyboard check uses the new axes instead of the pre-rotation ones.
      invalidateScreenSizeCache(serial);
      sessions.addEnvChange(session, `orientation > ${orientation}`);
      const now = await getOrientation(serial);
      sessions.recordMutation(session, {
        tool: 'qa_orientation',
        action: 'orientation_set',
        risk: 'low',
        target: { device: serial, orientation, rotation: now?.rotation ?? null, autoRotate: now?.auto ?? null },
        consent: { required: false, approved: true },
        status: 'executed',
      });
      return qaOk(
        { orientation, rotation: now?.rotation ?? null, autoRotate: now?.auto ?? null },
        `orientation set to ${orientation}${now ? ` (rotation=${now.rotation}, auto=${now.auto})` : ''}`,
      );
    },
  );

  server.registerTool(
    'qa_geolocation',
    {
      title: 'Set location',
      description:
        'Spoof the GPS location (Android Emulator only). Consent-gated and logged as an environment change. For location-based apps (maps, nearby, geofencing). Pass lat + lng (decimal degrees).',
      inputSchema: {
        sessionId: z.string(),
        lat: z.number().describe('Latitude in decimal degrees.'),
        lng: z.number().describe('Longitude in decimal degrees.'),
        consentId: z.string().optional(),
        approve: z.boolean().optional(),
      },
    },
    async ({ sessionId, lat, lng, consentId, approve }) => {
      const session = sessions.get(sessionId);
      if (!session) return unknownSessionError(sessionId);
      const { driver, blocked } = await getDriver(session);
      const serial = driver?.currentDevice();
      if (!session || !driver || !serial) {
        return (
          blockedDeviceResult(blocked) ??
          qaError({
            what: 'No device attached to this session',
            changedState: false,
            retrySafe: true,
            nextSteps: ['Call qa_prepare_target first.'],
          })
        );
      }
      if (driver.kind !== 'direct') {
        return qaError({
          what: 'Geolocation spoofing is only supported on the Android emulator backend',
          changedState: false,
          retrySafe: false,
          failureCode: 'BACKEND_UNSUPPORTED',
          nextSteps: ['On iOS, set a simulated location from the simulator UI; on real devices use a mock-location app.'],
        });
      }
      const gate = consumeConsent(consentId, approve, { action: 'geo_set', affects: { lat, lng } });
      if (!gate.approved) {
        sessions.recordMutation(session, {
          tool: 'qa_geolocation',
          action: 'geo_set',
          risk: 'medium',
          target: { device: serial, lat, lng },
          consent: { required: true, approved: false },
          status: 'requested',
        });
        return requireConsent({
          action: 'geo_set',
          risk: 'medium',
          exactCommand: `adb -s ${serial} emu geo fix ${lng} ${lat}`,
          affects: { lat, lng },
          explain: `Spoof the device location to (${lat}, ${lng})? Affects any location-aware app.`,
        });
      }
      sessions.recordMutation(session, {
        tool: 'qa_geolocation',
        action: 'geo_set',
        risk: 'medium',
        target: { device: serial, lat, lng },
        consent: { required: true, consentId, approved: true },
        status: 'approved',
      });
      try {
        await setGeo(serial, lat, lng);
      } catch (e) {
        const emulatorHint = !serial.startsWith('emulator-') ? ' (this looks like a real device; `adb emu` only works on emulators)' : '';
        sessions.recordMutation(session, {
          tool: 'qa_geolocation',
          action: 'geo_set',
          risk: 'medium',
          target: { device: serial, lat, lng },
          consent: { required: true, consentId, approved: true },
          status: 'blocked',
          detail: String(e),
        });
        return qaError({
          what: `Could not set location: ${String(e)}${emulatorHint}`,
          changedState: false,
          retrySafe: true,
          nextSteps: ['Use an emulator for location spoofing.'],
        });
      }
      sessions.addEnvChange(session, `geolocation > (${lat}, ${lng})`);
      sessions.recordMutation(session, {
        tool: 'qa_geolocation',
        action: 'geo_set',
        risk: 'medium',
        target: { device: serial, lat, lng },
        consent: { required: true, consentId, approved: true },
        status: 'executed',
      });
      return qaOk({ lat, lng, set: true }, `location set to (${lat}, ${lng})`);
    },
  );
}
