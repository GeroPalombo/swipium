// qa_device_info + qa_orientation: device-parity introspection and rotation,
// without raw adb. Read-only info needs no consent; orientation is a logged, non-destructive
// environment change.

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { qaOk, qaError, invalidArgumentError, isInvalidArgumentError, unknownSessionError } from '../lib/result.js';
import { run } from '../lib/spawn.js';
import { sensitiveRefusal } from '../lib/sensitive.js';
import { requireConsent, consumeConsent } from '../consent/consent.js';
import { blockedDeviceResult, getDriver, prepareFirstStep } from '../session/attach.js';
import { listSimulators, type Simulator } from '../lib/simctl.js';
import { getDeviceProps, getOrientation, setOrientation, listPackages, setGeo } from '../lib/device.js';
import type { SessionStore } from '../session/store.js';
import { assertAndroidAppId, invalidateScreenSizeCache } from '../drivers/DirectDriver.js';

/** Case-insensitive line filter; a pattern that is not a valid regex is matched literally. */
function lineFilter(pattern: string): RegExp {
  try {
    return new RegExp(pattern, 'i');
  } catch {
    return new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  }
}

function rotationLabel(rotation: number, auto: boolean): string {
  return auto ? 'auto' : rotation === 1 || rotation === 3 ? 'landscape' : 'portrait';
}

/** logs.since > a logcat -T time: a relative age ("90s", "5m", "1h") becomes epoch seconds before
 *  `now` (the device clock when the caller read it, else the host clock); a logcat "MM-DD hh:mm:ss[.mmm]" / "YYYY-MM-DD …" passes through. */
export function logcatSince(v: string, now = Date.now()): string | undefined {
  const rel = v.trim().match(/^(\d{1,6})\s*(s|m|h)$/i);
  if (rel) {
    const sec = Number(rel[1]) * ({ s: 1, m: 60, h: 3600 } as const)[rel[2].toLowerCase() as 's' | 'm' | 'h'];
    return ((now - sec * 1000) / 1000).toFixed(3);
  }
  return /^(?:\d{4}-)?\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d{1,3})?$/.test(v.trim()) ? v.trim() : undefined;
}

/** threadtime lines of `pkg`: every line of its current PID or of a PID logcat names for it (a crashed
 *  or restarted process), plus lines that name it (ActivityManager "has died", am_crash). */
function linesOfPackage(lines: string[], pkg: string, currentPid?: string): string[] {
  const esc = pkg.replace(/[.]/g, '\\.');
  const pidRe = new RegExp(`Process: ${esc}, PID: (\\d+)|Start proc (\\d+):${esc}[/:\\s]|\\b(\\d+):${esc}/`);
  const pids = new Set<string>(currentPid ? [currentPid] : []);
  for (const l of lines) {
    const m = l.match(pidRe);
    const p = m?.[1] ?? m?.[2] ?? m?.[3];
    if (p) pids.add(p);
  }
  const pidOf = (l: string) => l.match(/^\d\d-\d\d\s+\S+\s+(\d+)\s/)?.[1];
  return lines.filter((l) => l.includes(pkg) || pids.has(pidOf(l) ?? ''));
}

/** grep with N lines of trailing context per match (a FATAL header + its stack). */
function withContext(lines: string[], re: RegExp, after: number): string[] {
  if (!after) return lines.filter((l) => re.test(l));
  const out: string[] = [];
  let until = -1;
  lines.forEach((l, i) => {
    if (re.test(l)) until = i + after;
    if (i <= until) out.push(l);
  });
  return out;
}

export function registerDevice(server: McpServer, sessions: SessionStore): void {
  server.registerTool(
    'qa_device_info',
    {
      title: 'Device info',
      description:
        'Read-only device info. Android: model, SDK, ABIs, locale, screen, orientation (listPackages:true adds third-party ' +
        'packages; logs:{…} captures filtered logcat). iOS Simulator: name, runtime, state, screen.',
      inputSchema: {
        sessionId: z.string(),
        listPackages: z.boolean().optional().describe('Include installed third-party package names.'),
        packageFilter: z.string().optional().describe('Substring filter for the package list.'),
        logs: z
          .object({
            lines: z.number().int().min(1).max(20000).optional(),
            buffer: z.enum(['main', 'crash', 'system', 'events', 'all', 'default']).optional(),
            level: z.enum(['V', 'D', 'I', 'W', 'E', 'F']).optional(),
            tag: z.string().optional(),
            package: z.string().optional(),
            grep: z.string().optional(),
            context: z.number().int().min(0).max(200).optional(),
            since: z.string().optional(),
          })
          .strict()
          .optional()
          .describe(
            'Android: save logcat to an artifact instead. Scans the last `lines` (1000) lines overall; level is the minimum; package also ' +
              'matches a crashed app (its `Process:` PID); grep is a regex, context = lines kept after each match (40 shows a FATAL stack; ' +
              'or use buffer:"crash"); since = "5m" / "90s" / "MM-DD hh:mm:ss".',
          ),
      },
    },
    async ({ sessionId, listPackages: withPkgs, packageFilter, logs }) => {
      const session = sessions.get(sessionId);
      if (!session) return unknownSessionError(sessionId);
      // TOOL-19: the sensitive policy and argument checks come before the device lookup, so the
      // first refusal is the final one (not NO_DEVICE, then a second refusal after binding).
      if (logs) {
        if (session.sensitive) return sensitiveRefusal('Android logcat');
        const bad = (what: string, next: string) =>
          qaError({ what, changedState: false, retrySafe: true, failureCode: 'INVALID_ARGUMENT', nextSteps: [next] });
        if (logs.since && !logcatSince(logs.since))
          return bad(`Invalid logs.since "${logs.since}"`, 'Pass a relative age ("90s", "5m", "1h") or a logcat time ("10-11 14:05:00").');
        if (logs.tag && !/^[\w.$-]+$/.test(logs.tag))
          return bad(`Invalid logcat tag "${logs.tag}"`, 'Pass a plain tag name such as ReactNativeJS.');
        if (logs.package) {
          try {
            assertAndroidAppId(logs.package);
          } catch (e) {
            if (isInvalidArgumentError(e)) return invalidArgumentError(e, ['Pass a valid package, e.g. com.example.app.']);
            throw e;
          }
        }
      }
      const { driver, blocked } = await getDriver(session);
      const serial = driver?.currentDevice();
      if (!session || !driver || !serial) {
        return (
          blockedDeviceResult(blocked) ??
          qaError({
            what: 'No device attached to this session',
            failureCode: 'NO_DEVICE',
            changedState: false,
            retrySafe: true,
            nextSteps: [prepareFirstStep(session)],
          })
        );
      }
      if (logs && driver.kind !== 'direct') {
        return qaError({
          what: `logcat capture is Android-only (this session uses the "${driver.kind}" backend)`,
          changedState: false,
          retrySafe: false,
          failureCode: 'BACKEND_UNSUPPORTED',
          nextSteps: ['On an iOS simulator, use qa_ios { action:"logs", last:"5m" }.'],
        });
      }
      if (logs) {
        // LOG-1: on-demand Android logcat (the iOS counterpart is qa_ios logs). Sensitive mode and
        // malformed since/tag/package were refused above, before the device lookup.
        const lines = logs.lines ?? 1000;
        const level = logs.level ?? 'V';
        let since: string | undefined;
        if (logs.since) {
          // NEW-B: a relative age is measured on the DEVICE clock (an emulator can boot hours off the
          // host clock, and -T <host epoch> then selects nothing). Host clock only if date fails.
          let deviceNow: number | undefined;
          if (/^\s*\d+\s*[smh]\s*$/i.test(logs.since)) {
            const d = await run('adb', ['-s', serial, 'shell', 'date', '+%s'], { timeoutMs: 5000 }).catch(() => null);
            const sec = Number(d?.stdout.trim());
            if (Number.isFinite(sec) && sec > 0) deviceNow = sec * 1000;
          }
          since = logcatSince(logs.since, deviceNow);
          if (!since)
            return qaError({
              what: `Invalid logs.since "${logs.since}"`,
              changedState: false,
              retrySafe: true,
              failureCode: 'INVALID_ARGUMENT',
              nextSteps: ['Pass a relative age ("90s", "5m", "1h") or a logcat time ("10-11 14:05:00").'],
            });
        }
        // -T <time> reads everything since then; -t <n> the last n lines (per buffer). `lines` caps
        // the OUTPUT after the package/grep filters, not the scan: a crash inside a busy `since`
        // window, or a crashed package's FATAL block under later noise, is still found (LOG-1).
        // A package filter without `since` scans a wider tail for the same reason.
        const scanTail = logs.package ? Math.max(lines, 5000) : lines;
        const argv = ['-s', serial, 'logcat', '-d', '-v', 'threadtime', ...(since ? ['-T', since] : ['-t', String(scanTail)])];
        if (logs.buffer && logs.buffer !== 'default') argv.push('-b', logs.buffer);
        let pid: string | undefined;
        let pkgMatch: string | undefined; // package not running: select its lines by crash/start PID + name
        if (logs.package) {
          try {
            assertAndroidAppId(logs.package);
          } catch (e) {
            if (isInvalidArgumentError(e)) return invalidArgumentError(e, ['Pass a valid package, e.g. com.example.app.']);
            throw e;
          }
          const r = await run('adb', ['-s', serial, 'shell', 'pidof', logs.package], { timeoutMs: 5000 }).catch(() => null);
          pid = r?.stdout.trim().split(/\s+/)[0] || undefined;
          // Match its lines by the current PID plus the PIDs logcat names for it (`Process: <pkg>,
          // PID: n`, `Start proc n:<pkg>`) and by name, never `--pid` alone: right after a crash the
          // app is gone or already restarted under a new PID, and the crashed PID's FATAL block
          // is what the caller wants (LOG-1).
          pkgMatch = logs.package;
        }
        if (logs.tag) {
          if (!/^[\w.$-]+$/.test(logs.tag))
            return qaError({
              what: `Invalid logcat tag "${logs.tag}"`,
              changedState: false,
              retrySafe: true,
              failureCode: 'INVALID_ARGUMENT',
              nextSteps: ['Pass a plain tag name such as ReactNativeJS.'],
            });
          argv.push(`${logs.tag}:${level}`, '*:S');
        } else argv.push(`*:${level}`);
        const grepRe = logs.grep ? lineFilter(logs.grep) : undefined;
        let text: string;
        try {
          const r = await run('adb', argv, { timeoutMs: 15000, rejectOnNonZero: true });
          text = r.stdout;
        } catch (err) {
          return qaError({
            what: `logcat capture failed: ${String(err)}`,
            changedState: false,
            retrySafe: true,
            nextSteps: ['Confirm the device is online (qa_doctor), or try fewer lines / another buffer.'],
          });
        }
        const all = text.split('\n').filter((l) => l.trim() && !l.startsWith('--------- beginning of'));
        const ofPkg = pkgMatch ? linesOfPackage(all, pkgMatch, pid) : all;
        const filtered = grepRe ? withContext(ofPkg, grepRe, logs.context ?? 0) : ofPkg;
        const truncated = filtered.length > lines;
        const kept = filtered.slice(-lines);
        const body = kept.join('\n').slice(-120_000);
        const uri = kept.length
          ? sessions.saveArtifact(session, 'logcat', `logcat-${Date.now()}.txt`, body, 'text/plain', 'Android logcat (qa_device_info logs)')
          : null;
        const filters = {
          lines,
          buffer: logs.buffer ?? 'default',
          level,
          tag: logs.tag ?? null,
          package: logs.package ?? null,
          pid: pkgMatch ? `${pid ? `running as ${pid}; ` : 'not running; '}matched by current/crash/start PID and name` : null,
          grep: logs.grep ?? null,
          ...(logs.context ? { context: logs.context } : {}),
          ...(since ? { since } : {}),
        };
        return qaOk(
          {
            device: serial,
            uri,
            matched: kept.length,
            scanned: all.length,
            ...(truncated ? { truncated: true, matchedTotal: filtered.length } : {}),
            filters,
          },
          uri
            ? `captured ${kept.length} logcat line(s) (of ${all.length} read) > ${uri}` +
                (truncated
                  ? `\nOutput capped at the last ${lines} of ${filtered.length} matching lines; raise lines or narrow the filter.`
                  : '')
            : `no logcat lines matched (${all.length} read). Widen lines/level, or use buffer:"crash" for crashes.`,
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
      description: 'Set orientation (Android Emulator only): portrait, landscape, or auto. Logged as an environment change.',
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
            failureCode: 'NO_DEVICE',
            changedState: false,
            retrySafe: true,
            nextSteps: [prepareFirstStep(session)],
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
      description: 'Spoof the GPS location (Android Emulator only; consent-gated, logged as an environment change).',
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
            failureCode: 'NO_DEVICE',
            changedState: false,
            retrySafe: true,
            nextSteps: [prepareFirstStep(session)],
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
