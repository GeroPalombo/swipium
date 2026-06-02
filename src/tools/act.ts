// qa_act — the single consolidated action tool (DESIGN §3 locked schema).
// Resolves a target (ref | selector | coords), performs the action, waits for the screen
// to settle, then returns the post-action snapshot + a deterministic health check. So one
// call both acts AND observes the result.

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { qaOk, qaError, qaStop } from '../lib/result.js';
import { parseSnapshot, signature, renderElements } from '../snapshot/parse.js';
import { presentElements } from '../snapshot/present.js';
import { obstructionAt } from '../snapshot/overlays.js';
import { settle } from '../snapshot/settle.js';
import { checkHealth } from '../oracle/health.js';
import { recordHealthFindings } from '../oracle/record.js';
import { makeRedactor } from '../lib/redact.js';
import { getDriver } from '../session/attach.js';
import { resolveTarget, setsEqual } from '../core/target.js';
import { recordableNativeSelector, recordableTap } from '../flows/generate.js';
import { classifyFlowDriverError } from '../flows/run.js';
import { structuredSignature } from '../explore/signatures.js';
import type { RecordedAction, Session, SessionStore } from '../session/store.js';
import type { RawNode } from '../snapshot/parse.js';
import type { NativeSelectorStrategy, SnapshotElement } from '../drivers/Driver.js';

interface NativeSelector {
  using: NativeSelectorStrategy;
  value: string;
}

function nativeSelectorFor(selector?: string): NativeSelector | null {
  const m = selector?.match(/^(accessibility id|name|predicate string|class chain)\s*=\s*(.+)$/i);
  if (!m) return null;
  return { using: m[1].toLowerCase() as NativeSelectorStrategy, value: m[2] };
}

function screenTitleFromNodes(nodes: RawNode[]): string | undefined {
  if (!nodes.length) return undefined;
  const height = nodes[0].bounds[3] || 0;
  const topBand = height ? height * 0.28 : Number.POSITIVE_INFINITY;
  const candidates = nodes
    .filter((n) => n.text && n.text.trim().length >= 2 && n.text.trim().length <= 40 && !n.clickable)
    .sort((a, b) => a.bounds[1] - b.bounds[1]);
  const header = candidates.find((n) => n.bounds[1] <= topBand) ?? candidates[0];
  return header?.text?.trim() || undefined;
}

function recordingScreenContext(session: Session): { screen?: string; screenSig?: string } {
  const nodes = session.lastSnapshot?.allNodes;
  if (!nodes?.length) return {};
  const els = nodes.map((n) => ({ id: n.id, label: n.desc, text: n.text } as unknown as SnapshotElement));
  return { screen: screenTitleFromNodes(nodes), screenSig: structuredSignature(els) };
}

function recordableNativeTarget(session: Parameters<typeof recordableNativeSelector>[0], native: NativeSelector): Omit<RecordedAction, 'at' | 'action'> {
  const selectorKind = native.using === 'accessibility id' ? 'accessibility_id' : native.using === 'name' ? 'name' : native.using === 'predicate string' ? 'predicate' : 'class_chain';
  return {
    selector: native.value,
    selectorKind,
    exportability: 'semantic',
    ...recordableNativeSelector(session, selectorKind, native.value),
  };
}

export function registerAct(server: McpServer, sessions: SessionStore): void {
  server.registerTool(
    'qa_act',
    {
      title: 'Act on the screen',
      description:
        'Perform one synchronized UI action and observe the result. Actions & their fields:\n' +
        '- tap: target {ref|text|id|selector|x,y}\n' +
        '- type: target (a field) + text + mode:"replace"|"append" (default replace); optional submit:true\n' +
        '- clear: target (a field), focuses it and clears existing text\n' +
        '- swipe: direction up|down|left|right (optional target as start point)\n' +
        '- scroll: direction + optional untilVisible {text|id} + maxScrolls (default 8)\n' +
        '- press: key back|home|enter\n' +
        '- open_url: url (deep link)\n' +
        '- wait: for {settled:true | ref | text | id | selector} + timeoutMs\n' +
        'Every non-wait action auto-waits for the screen to settle, then returns the post snapshot (quality + @eN elements), whether the screen changed, and a health check.',
      inputSchema: {
        sessionId: z.string(),
        action: z.enum(['tap', 'type', 'clear', 'swipe', 'scroll', 'press', 'open_url', 'wait']),
        target: z
          .object({
            ref: z.string().optional(),
            text: z.string().optional(),
            id: z.string().optional(),
            selector: z.string().optional().describe('Backend-native selector, e.g. "accessibility id=email", "name=Continue", "predicate string=label == \\"Continue\\"", or "class chain=**/XCUIElementTypeButton[...]".'),
            index: z.number().optional(),
            x: z.number().optional(),
            y: z.number().optional(),
          })
          .optional(),
        text: z.string().optional(),
        mode: z.enum(['replace', 'append']).optional(),
        submit: z.boolean().optional(),
        direction: z.enum(['up', 'down', 'left', 'right']).optional(),
        untilVisible: z.object({ text: z.string().optional(), id: z.string().optional() }).optional(),
        maxScrolls: z.number().optional(),
        key: z.enum(['back', 'home', 'enter']).optional(),
        url: z.string().optional(),
        durationMs: z.number().optional().describe('tap press duration. Coordinate taps default to ~100ms (RN ignores instant taps); ref/selector taps are instant unless set.'),
        ignoreOverlay: z.boolean().optional().describe('tap even if an overlay obstructs the target (default false → returns blockedByOverlay).'),
        for: z
          .object({
            settled: z.boolean().optional(),
            ref: z.string().optional(),
            text: z.string().optional(),
            id: z.string().optional(),
            selector: z.string().optional().describe('Backend-native selector, e.g. "accessibility id=email" or "name=Continue". Requires WDA/native selector support.'),
          })
          .optional(),
        timeoutMs: z.number().optional(),
      },
    },
    async (args) => {
      const { sessionId, action } = args;
      const session = sessions.get(sessionId);
      const { driver: d } = session ? await getDriver(session) : { driver: undefined };
      if (!session || !d) {
        return qaError({
          what: 'No device attached to this session',
          changedState: false,
          retrySafe: true,
          nextSteps: ['Call qa_prepare_target first.'],
        });
      }
      if (d.kind === 'simulator') {
        return qaError({
          what: 'Structured interaction (tap/type/swipe) is not available on the iOS simulator backend',
          changedState: false,
          retrySafe: false,
          failureCode: 'BACKEND_UNSUPPORTED',
          nextSteps: ['Attach WebDriverAgent with qa_wda for structured tap/type/snapshot. Without WDA, navigate via qa_ios deep links and verify with qa_assert_visual.'],
        });
      }
      // Budget gate (review §4.1 / Rec 4): refuse new work once the session budget is spent.
      // `wait` is exempt from the action/screenshot caps (it's synchronization, not an
      // action), but it is NOT exempt from the TIME budget — otherwise repeated waits could
      // burn the clock indefinitely.
      const stopReason = sessions.budgetStop(session);
      if (stopReason && (action !== 'wait' || /time budget/.test(stopReason))) {
        return qaStop(stopReason, { counters: session.counters, mode: session.mode });
      }
      const fail = (what: string, changedState: boolean) =>
        qaError({ what, changedState, retrySafe: true, nextSteps: ['Run qa_snapshot to see the current screen, then retry.'] });

      // ---- wait is its own path (no settle/health afterward) ----
      if (action === 'wait') {
        const timeoutMs = args.timeoutMs ?? 8000;
        if (args.for?.settled || !args.for) {
          const s = await settle(d, { timeoutMs });
          const post = parseSnapshot(s.xml);
          session.lastSnapshot = { fullByRef: post.fullByRef, signatures: new Set(post.elements.map(signature)), allNodes: post.allNodes };
          const { elements: shown, rendered } = presentElements(post.elements, makeRedactor(session.secrets));
          return qaOk({ action, settled: s.settled, quality: post.quality.verdict, elements: shown }, `wait(settled)=${s.settled}\n\n${rendered}`);
        }
        const deadline = Date.now() + timeoutMs;
        const want = args.for;
        const native = nativeSelectorFor(want?.selector);
        if (want?.selector && !native) {
          return qaError({ what: `Unsupported wait selector ${JSON.stringify(want.selector)}`, changedState: false, retrySafe: true, nextSteps: ['Use accessibility id=..., name=..., predicate string=..., class chain=..., or wait by text/id/ref.'] });
        }
        if (native) {
          if (!d.existsBySelector) return qaError({
            what: `${native.using} waits require backend-native selector support`,
            changedState: false,
            retrySafe: false,
            failureCode: 'BACKEND_UNSUPPORTED',
            nextSteps: ['Use a WDA-backed iOS session, or wait by text/id/ref on this backend.'],
          });
          while (Date.now() < deadline) {
            if (await d.existsBySelector(native.using, native.value)) {
              return qaOk({ action, found: true, selector: want?.selector, via: 'native-selector' }, `wait: found ${want?.selector}`);
            }
            await new Promise((r) => setTimeout(r, 400));
          }
          return qaError({ what: `wait timed out (${timeoutMs}ms) for ${JSON.stringify(want)}`, changedState: false, retrySafe: true, nextSteps: ['Re-check the native selector value, or run qa_snapshot to inspect the current screen.'] });
        }
        while (Date.now() < deadline) {
          const parsed = parseSnapshot(await d.dumpXml());
          session.lastSnapshot = { fullByRef: parsed.fullByRef, signatures: new Set(parsed.elements.map(signature)), allNodes: parsed.allNodes };
          const hit = parsed.elements.find((e) =>
            (want.ref && e.ref === want.ref) ||
            (want.id && e.id === want.id) ||
            (want.text && (e.text?.toLowerCase().includes(want.text.toLowerCase()) || e.label?.toLowerCase().includes(want.text.toLowerCase()))),
          );
          if (hit) return qaOk({ action, found: true, ref: hit.ref }, `wait: found ${hit.ref}`);
          await new Promise((r) => setTimeout(r, 400));
        }
        return qaError({ what: `wait timed out (${timeoutMs}ms) for ${JSON.stringify(want)}`, changedState: false, retrySafe: true, nextSteps: ['Re-snapshot; the element may use different text/id.'] });
      }

      // Phase timing (P1.6): mark the first real action so the report can split setup vs active.
      sessions.milestone(session, 'first_action');

      const preSigs = session.lastSnapshot?.signatures ?? new Set<string>();
      let meta: Record<string, unknown> = {};
      // remembered so a no-change tap can be retried as a longer press (RN tap quirk)
      let tapRetry: { x: number; y: number; instant: boolean } | undefined;
      // action-IR step to record once the action succeeds (built here while lastSnapshot is
      // still the PRE-navigation screen, so a tapped @ref still resolves to its label).
      let toRecord: Omit<RecordedAction, 'at'> | undefined;

      try {
        switch (action) {
          case 'tap': {
            const native = nativeSelectorFor(args.target?.selector);
            if (native) {
              if (!d.tapBySelector) return qaError({
                what: `${native.using} selectors require backend-native selector support`,
                changedState: false,
                retrySafe: false,
                failureCode: 'BACKEND_UNSUPPORTED',
                nextSteps: ['Use a WDA-backed iOS session, or target by ref/text/id/coordinates on this backend.'],
              });
              await d.tapBySelector(native.using, native.value);
              meta = { selector: args.target?.selector, via: 'native-selector' };
              toRecord = { action: 'tap', ...recordableNativeTarget(session, native) };
              break;
            }
            const t = await resolveTarget(session, args.target);
            if ('error' in t) return fail(t.error, false);
            // Overlay obstruction check (CR4): if another element is drawn over the target
            // point, return a structured blockedByOverlay instead of tapping blindly.
            if (!args.ignoreOverlay && t.via !== 'coords' && session.lastSnapshot?.allNodes) {
              // works for ref AND selector taps — t.ref is the resolved @eN in either case
              const node = t.ref ? session.lastSnapshot.fullByRef.get(t.ref) : undefined;
              const obs = obstructionAt(session.lastSnapshot.allNodes, node, t.x, t.y);
              if (obs.obstructed) {
                return qaError(
                  {
                    what: `Target at (${t.x},${t.y}) is obstructed by ${obs.by?.cls?.split('.').pop()}${obs.by?.text ? ` "${obs.by.text}"` : ''}`,
                    changedState: false,
                    retrySafe: true,
                    failureCode: 'OVERLAY_OBSTRUCTION',
                    nextSteps: ['Call qa_clear_overlay (auto, or hide_keyboard/minimize_logbox), then retry — or pass ignoreOverlay:true to tap anyway.'],
                  },
                  { blockedByOverlay: true, obstructedBy: obs.by },
                );
              }
            }
            // Coordinate taps default to a short press (RN often ignores instant taps);
            // ref/selector taps stay instant unless durationMs is given.
            const isCoord = t.via === 'coords';
            const durationMs = args.durationMs ?? (isCoord ? 100 : undefined);
            if (durationMs) await d.pressXY(t.x, t.y, durationMs);
            else await d.tapXY(t.x, t.y);
            tapRetry = { x: t.x, y: t.y, instant: !durationMs };
            meta = { tappedAt: [t.x, t.y], via: t.via, ...(durationMs ? { durationMs } : {}) };
            toRecord = { action: 'tap', ...recordableTap(session, args.target, t) };
            break;
          }
          case 'type': {
            if (args.text == null) return fail('type requires `text`.', false);
            const native = nativeSelectorFor(args.target?.selector);
            if (native) {
              if (!d.typeBySelector) return qaError({
                what: `${native.using} selectors require backend-native selector support`,
                changedState: false,
                retrySafe: false,
                failureCode: 'BACKEND_UNSUPPORTED',
                nextSteps: ['Use a WDA-backed iOS session, or target by ref/text/id/coordinates on this backend.'],
              });
              if ((args.mode ?? 'replace') === 'replace') {
                if (!d.clearBySelector) return qaError({
                  what: `replace-mode typing by ${native.using} requires backend-native clear support`,
                  changedState: false,
                  retrySafe: false,
                  failureCode: 'BACKEND_UNSUPPORTED',
                  nextSteps: ['Use append mode, or attach a WDA backend that supports element clear.'],
                });
                await d.clearBySelector(native.using, native.value);
              }
              await d.typeBySelector(native.using, native.value, args.text);
              meta = { typedChars: args.text.length, redacted: true, mode: args.mode ?? 'replace', via: 'native-selector', selector: args.target?.selector, submit: !!args.submit };
              toRecord = { action: 'type', ...recordableNativeTarget(session, native), text: args.text };
              if (args.submit) await d.pressKey('enter');
              break;
            }
            const t = await resolveTarget(session, args.target);
            if ('error' in t) return fail(t.error, false);
            // Typing into a secure field → remember the value so it's scrubbed everywhere, and
            // record that a login was performed (auth-state reporting, P1.5).
            if (t.secure) {
              session.secrets.add(args.text);
              sessions.markAuth(session, { loginPerformed: true, loginPerformedAt: Date.now() });
              sessions.milestone(session, 'login_performed');
            }
            await d.tapXY(t.x, t.y); // focus + raise IME (real touch)
            await new Promise((r) => setTimeout(r, 700));
            if ((args.mode ?? 'replace') === 'replace') await d.clearFocusedText(t.textLen);
            await d.inputText(args.text);
            if (args.submit) await d.pressKey('enter');
            // Never echo the typed value — it may be a password/OTP/email/token and would
            // leak into the agent transcript + artifacts (DESIGN §9.7 sensitive-mode).
            meta = { typedChars: args.text.length, redacted: true, mode: args.mode ?? 'replace', via: t.via, submit: !!args.submit };
            // Never store a secret's value in the IR — secrets become a ${VAR} at generate time.
            {
              const targetRecord = recordableTap(session, args.target, t);
              toRecord = {
                action: 'type',
                selector: targetRecord.selector,
                selectorKind: targetRecord.selectorKind,
                secret: !!t.secure,
                text: t.secure ? undefined : args.text,
                exportability: t.secure ? 'needs-human-data' : targetRecord.exportability,
                provenance: targetRecord.provenance,
              };
            }
            break;
          }
          case 'clear': {
            const native = nativeSelectorFor(args.target?.selector);
            if (native) {
              if (!d.clearBySelector) return qaError({
                what: `${native.using} selectors require backend-native clear support`,
                changedState: false,
                retrySafe: false,
                failureCode: 'BACKEND_UNSUPPORTED',
                nextSteps: ['Use a WDA-backed iOS session, or target by ref/text/id/coordinates on this backend.'],
              });
              await d.clearBySelector(native.using, native.value);
              meta = { cleared: true, via: 'native-selector', selector: args.target?.selector };
              toRecord = { action: 'clear', ...recordableNativeTarget(session, native) };
              break;
            }
            const t = await resolveTarget(session, args.target);
            if ('error' in t) return fail(t.error, false);
            await d.tapXY(t.x, t.y);
            await new Promise((r) => setTimeout(r, 400));
            await d.clearFocusedText(t.textLen);
            meta = { cleared: true, via: t.via };
            toRecord = { action: 'clear', ...recordableTap(session, args.target, t) };
            break;
          }
          case 'swipe': {
            if (!args.direction) return fail('swipe requires `direction`.', false);
            const start = args.target ? await resolveTarget(session, args.target) : null;
            const sx = start && !('error' in start) ? start.x : 0;
            const sy = start && !('error' in start) ? start.y : 0;
            const from = sx && sy ? { x: sx, y: sy } : { x: 540, y: 1200 };
            const dist = 800;
            const to = {
              up: { x: from.x, y: from.y - dist },
              down: { x: from.x, y: from.y + dist },
              left: { x: from.x - dist, y: from.y },
              right: { x: from.x + dist, y: from.y },
            }[args.direction];
            await d.swipe(from.x, from.y, to.x, to.y, 300);
            meta = { direction: args.direction };
            toRecord = { action: 'swipe', direction: args.direction, exportability: 'coordinate' };
            break;
          }
          case 'scroll': {
            if (!args.direction) return fail('scroll requires `direction`.', false);
            const max = args.maxScrolls ?? 8;
            // scroll down = swipe up; build a screen-relative gesture
            const dir = args.direction;
            let found = false;
            for (let i = 0; i < max; i++) {
              const cx = 540;
              const cy = 1200;
              const dist = 900;
              const vec = {
                down: [cx, cy + dist / 2, cx, cy - dist / 2],
                up: [cx, cy - dist / 2, cx, cy + dist / 2],
                left: [cx + dist / 2, cy, cx - dist / 2, cy],
                right: [cx - dist / 2, cy, cx + dist / 2, cy],
              }[dir] as [number, number, number, number];
              await d.swipe(vec[0], vec[1], vec[2], vec[3], 300);
              await new Promise((r) => setTimeout(r, 400));
              if (args.untilVisible) {
                const parsed = parseSnapshot(await d.dumpXml());
                const u = args.untilVisible;
                found = parsed.elements.some(
                  (e) => (u.id && e.id === u.id) || (u.text && (e.text?.toLowerCase().includes(u.text.toLowerCase()) || e.label?.toLowerCase().includes(u.text.toLowerCase()))),
                );
                if (found) break;
              }
            }
            meta = { direction: dir, untilVisibleFound: args.untilVisible ? found : undefined };
            toRecord = { action: 'scroll', direction: dir, selector: args.untilVisible?.text, exportability: args.untilVisible?.text ? 'semantic' : 'coordinate' };
            break;
          }
          case 'press': {
            if (!args.key) return fail('press requires `key`.', false);
            await d.pressKey(args.key);
            meta = { key: args.key };
            toRecord = { action: 'press', key: args.key, exportability: 'semantic' };
            break;
          }
          case 'open_url': {
            if (!args.url) return fail('open_url requires `url`.', false);
            await d.openUrl(args.url);
            meta = { url: args.url };
            toRecord = { action: 'open_url', url: args.url, exportability: 'semantic' };
            break;
          }
        }
      } catch (e) {
        const failureCode = classifyFlowDriverError(e);
        return qaError({
          what: `Action "${action}" failed: ${String(e)}`,
          changedState: true,
          retrySafe: !['WDA_SESSION_FAILED', 'UNKNOWN'].includes(failureCode),
          failureCode,
          nextSteps: failureCode === 'UNKNOWN' ? ['Confirm the device is online and re-snapshot.'] : ['Use the failureCode to choose recovery, then re-snapshot before retrying.'],
        });
      }

      // count this as an action (wait already returned earlier)
      sessions.bump(session, 'actions');
      // Record the action into the IR for qa_flow_generate (the action definitely happened here;
      // recorded now so a later post-snapshot failure doesn't lose the step).
      if (toRecord) {
        const sc = recordingScreenContext(session);
        sessions.addRecordedAction(session, { at: Date.now(), ...sc, ...toRecord });
      }

      // Post-action observation is wrapped so a settle/dump/parse failure (e.g. the
      // looping-animation case) returns a Swipium-shaped result, never a raw MCP error.
      try {
      // settle → observe → health
      let s = await settle(d, { timeoutMs: args.timeoutMs ?? 8000 });
      let post = parseSnapshot(s.xml);
      let postSigs = new Set(post.elements.map(signature));
      let changed = !setsEqual(preSigs, postSigs);

      // No-change retry (review §4.5/§4.7): an instant tap that did nothing is often the RN
      // tap quirk — retry ONCE as a longer press before believing it's blocked.
      let retriedAsPress = false;
      if (!changed && action === 'tap' && tapRetry?.instant) {
        await d.pressXY(tapRetry.x, tapRetry.y, 120);
        retriedAsPress = true;
        s = await settle(d, { timeoutMs: args.timeoutMs ?? 8000 });
        post = parseSnapshot(s.xml);
        postSigs = new Set(post.elements.map(signature));
        changed = !setsEqual(preSigs, postSigs);
      }

      session.lastSnapshot = { fullByRef: post.fullByRef, signatures: postSigs, allNodes: post.allNodes };
      const health = await checkHealth(d, session.appId, s.xml);

      // Track no-change actions for the budget / no-op-loop detector.
      if (!changed && (action === 'tap' || action === 'swipe' || action === 'scroll' || action === 'press')) {
        sessions.bump(session, 'noChangeActions');
      }
      const budgetReached = sessions.budgetStop(session);

      // Sensitive-mode present: mask secure fields + scrub known secrets AND the just-typed
      // value (covers non-secure fields like email for this immediate response).
      const redact = makeRedactor([...session.secrets, ...(action === 'type' && args.text ? [args.text] : [])]);
      const { elements: outElements, rendered } = presentElements(post.elements, redact);

      // Record non-info findings for qa_report (deterministic bug trail) + app-error screenshot.
      await recordHealthFindings(sessions, session, health.findings, d, health.foreground);

      const banner =
        `${action} ${JSON.stringify(meta)} → changed=${changed}${retriedAsPress ? ' (retried as press)' : ''} ` +
        `settled=${s.settled} quality=${post.quality.verdict} native=${health.nativeHealthy ? 'ok' : health.nativeStatus} app=${health.appStatus}` +
        (budgetReached ? `\n⏹ budget reached: ${budgetReached} — call qa_report.` : '') +
        (!changed && retriedAsPress ? `\nNo change even after a press retry — likely wrong coords / disabled element / overlay / auth wall.` : '');
      const findings = health.findings.length ? '\n' + health.findings.map((f) => `[${f.severity}] ${f.layer ?? '?'}/${f.kind}: ${f.detail}${f.evidence ? ` — "${f.evidence}"` : ''}`).join('\n') : '';

      return qaOk(
        {
          action,
          ...meta,
          changed,
          retriedAsPress,
          settled: s.settled,
          quality: post.quality.verdict,
          health,
          counters: session.counters,
          ...(budgetReached ? { budgetReached } : {}),
          elements: outElements,
        },
        `${banner}${findings}\n\n${rendered}`,
      );
      } catch (e) {
        // The action ran; observing the result failed (often a UI that never reaches idle).
        const idle = /idle|dump|hierarchy/i.test(String(e));
        if (idle) sessions.setMode(session, 'visual-fallback');
        return qaError({
          what: `Action "${action}" ran, but observing the result failed: ${String(e)}`,
          changedState: true,
          retrySafe: false,
          nextSteps: idle
            ? ['Switched to visual-fallback. Use qa_screenshot; qa_check_health still works.']
            : ['Re-check the device is online, then qa_screenshot / qa_check_health.'],
        });
      }
    },
  );
}
