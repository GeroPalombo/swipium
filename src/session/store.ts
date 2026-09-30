// Session + job + artifact store with DISK PERSISTENCE.
// Live, non-serializable bits (driver, lastSnapshot, abort controllers) stay in memory;
// a serializable subset is written to <sessionDir>/state.json on mutation (debounced;
// synchronous for the mutation ledger + session creation + shutdown flush), and a small
// registry under ~/.swipium/registry.json — lock-guarded, lazily loaded on first access —
// lets a fresh server instance reload prior sessions so artifacts/reports/job-status survive
// a server restart. (A restart does NOT resurrect a running child process — such jobs are
// marked failed on reload, and orphaned Metro pids are verified via `ps` and reaped.)

import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import type { Driver } from '../drivers/Driver.js';
import type { RawNode } from '../snapshot/parse.js';
import type { ResponseMode } from '../lib/result.js';
import { DEFAULT_RESPONSE_MODE } from '../lib/result.js';
import { makeRedactor, redactDeep, redactStructuredText, structuredKindOf, type Redactor } from '../lib/redact.js';
import {
  generatedOutputRedactor,
  inputBindings,
  inputPlaceholderFor,
  secretSafeActions,
  secretSafeNotes,
  swipiumVarName,
} from '../suite/secretGuard.js';
import { withFileLock, writeFileAtomicSync } from '../lib/lockfile.js';
import { log } from '../lib/logger.js';
import { pidOwnedByLiveServer, reclaimPid } from './processRegistry.js';
import { fixtureMetadata, rehydrateFixtures } from '../fixtures/load.js';
import { scheduleStartupPrune } from './retention.js';
import { approvalMechanismFor, type ApprovalMechanism } from '../consent/consent.js';

export type JobStatus = 'running' | 'done' | 'failed' | 'cancelled';

// Progress model (hardening P1.1) — a consistent shape for long ops (build, boot, WDA, Metro,
// AAB conversion, suite run, exploration) so an agent can relay status without reading raw logs.
export interface ProgressModel {
  phase: string; // e.g. 'building_android' | 'booting_emulator' | 'converting_aab'
  startedAt: number;
  updatedAt: number;
  statusText: string; // user-facing one-liner
  lastEvent?: string; // most recent meaningful log line/event
  nextExpected?: string; // what should happen next
  logUri?: string; // artifact URI for the full log
  userActionRequired: boolean;
}

export interface JobRecord {
  jobId: string;
  kind: string;
  status: JobStatus;
  startedAt: number;
  endedAt?: number;
  progress?: string;
  progressDetail?: ProgressModel; // P1.1 structured progress
  error?: string;
  resultText?: string; // human summary when done
  result?: Record<string, unknown>; // structured payload when done
  artifactUris: string[];
}

export interface ArtifactRecord {
  uri: string;
  path: string;
  mime: string;
  kind: string;
  createdAt: number;
  label?: string; // optional human reason/label (e.g. why a screenshot was taken)
  /** Whether secret redaction was applied to the stored bytes. Text artifacts get the session
   * redactor ('applied'); binary artifacts (screenshots/recordings) CANNOT be redacted and are
   * tagged 'not-applied' so consumers know pixels may contain visible sensitive content.
   * 'partial': text was redacted but some registered secrets were too short (< 3 chars) to be
   * matched safely and were NOT scrubbed — see `redactionNote`. */
  redaction?: 'applied' | 'partial' | 'not-applied';
  redactionNote?: string;
}

export interface MutationRecord {
  id: string;
  at: number;
  tool: string;
  action: string;
  risk: 'low' | 'medium' | 'high';
  target: Record<string, unknown>;
  consent?: {
    required: boolean;
    consentId?: string;
    approved: boolean;
    payloadHash?: string;
    /** THREAT_MODEL: HOW the approval happened — a real out-of-band user prompt (MCP
     * elicitation) vs. the client asserting approval by re-calling with the consentId. */
    approvalMechanism?: ApprovalMechanism;
  };
  status: 'requested' | 'approved' | 'executed' | 'refused' | 'blocked' | 'restored';
  ledgerUri?: string;
  detail?: string;
}

export interface FindingRecord {
  at: number;
  severity: string;
  kind: string;
  detail: string;
  layer?: 'native' | 'app'; // Phase 2.2: which health layer the finding belongs to
  evidence?: string; // the visible on-screen text that matched
  screen?: string; // source screen (foreground owner) when the finding fired
  screenshotUri?: string; // evidence screenshot, when captured
  failureCode?: string; // typed failure class; else derived from kind in qa_report
}

// Phase 2.2: a structured test outcome the agent records via qa_note — distinguishes a real
// app bug from a blocked precondition / missing test data / intentional skip / refused action,
// so reports stop mislabeling "no saved flight to delete" as a failure.
export type TestOutcome = 'pass' | 'fail' | 'blocked' | 'skipped' | 'not_applicable';
export type TestCategory = 'app_bug' | 'mcp_limitation' | 'missing_test_data' | 'intentionally_skipped' | 'destructive_refused' | 'other';
export type TestEvidenceKind = 'structured_locator' | 'ocr_locator' | 'visual_match' | 'ai_visual_evidence' | 'manual_review' | 'ocr_text';

export interface TestNote {
  at: number;
  workflow: string;
  outcome: TestOutcome;
  category?: TestCategory;
  reason?: string;
  missingPrecondition?: string;
  requiredState?: string;
  recommendedSetup?: string;
  artifactUris?: string[];
  verifiedVisually?: boolean; // Phase 2.2: passed via screenshot evidence (animated/canvas screen)
  method?: 'visual' | 'ocr' | 'structured'; // How the assertion was verified
  evidenceKind?: TestEvidenceKind;
  confidence?: number;
  minConfidence?: number;
  decision?: string;
}

// Action IR: qa_act appends a tagged step here as the agent
// explores, so a successful run can be serialized into a durable flow (qa_generate target:"flow"). The
// exportability tag drives the durability grade: semantic (text/id) replays anywhere;
// coordinate is brittle; needs-human-data is a credential that must become a ${VAR}.
export type Exportability = 'semantic' | 'coordinate' | 'needs-human-data';
export interface SelectorProvenance {
  originalScreenSignature?: string;
  elementRole?: string;
  className?: string;
  text?: string;
  accessibilityLabel?: string;
  resourceId?: string;
  boundsBucket?: string;
  screenshotUri?: string;
  selectorKind?: string;
  selectorValue?: string;
  visual?: {
    screenshotCrop?: { x: number; y: number; width: number; height: number };
    ocrText?: string;
    confidence?: number;
    locale?: string;
    theme?: string;
    density?: number | null;
    orientation?: string;
    fallbackSelector?: string;
  };
}
export interface RecordedAction {
  at: number;
  action: string; // tap | type | clear | swipe | scroll | press | open_url | assert_visual
  selector?: string; // replayable text/label (taps/scrollTo)
  selectorKind?: 'text' | 'accessibility_id' | 'resource_id' | 'name' | 'predicate' | 'class_chain' | 'coords';
  x?: number;
  y?: number;
  text?: string; // literal typed text (non-secret) or a ${VAR} placeholder (secret)
  secret?: boolean;
  direction?: string;
  key?: string;
  url?: string;
  assertion?: string;
  exportability: Exportability;
  screen?: string; // visible screen title or foreground owner when recorded
  screenSig?: string; // stable per-screen signature used by generated POM suites
  warning?: string;
  provenance?: SelectorProvenance;
}

/** A Swipium tool call that returned an error for this session (WDA 404, UNKNOWN, driver failure…).
 *  qa_report derives its TOOL status from these — so a run full of tool errors is never "Tool
 *  status: PASS". Tool health only: these never change the APP verdict. */
export interface ToolErrorRecord {
  at: number;
  tool: string;
  failureCode: string;
  message: string;
}

// Phase 2.2 P1.4: a declared test precondition / fixture. Swipium does NOT mutate app state;
// it surfaces what a workflow needs so an unmet precondition reads as "blocked + setup guidance"
// rather than a failure. Loaded from qa_start_session { fixtures } and/or .swipium/fixtures.json.
// Phase 9: an OPT-IN, consent-gated seed spec that turns a declared
// precondition into one Swipium can actually create. Mutating; runs only on explicit consent.
export interface FixtureSeedAction {
  type: 'deeplink' | 'script' | 'api';
  url?: string; // deeplink: a deep link that sets up state
  command?: string | string[]; // script: argv array preferred; string is deprecated
  method?: string; // api: HTTP method (default POST)
  body?: string; // api: request body
  headers?: Record<string, string>; // api: request headers
}

export interface FixtureSeed extends FixtureSeedAction {
  idempotent?: boolean; // true when re-running the seed safely converges to the same state
  cleanup?: FixtureSeedAction; // optional teardown/rollback action for state-profile transactions
}

export interface Fixture {
  name: string;
  description?: string;
  requiredState?: string;
  recommendedSetup?: string;
  testAccount?: string; // a label only — never a secret
  apkPath?: string;
  value?: string; // non-secret safe test input (e.g. a flight number/search term) for exploration text entry
  disposable?: boolean; // true when the fixture/account/data can be safely destroyed during QA
  environment?: 'test' | 'staging' | 'production' | string;
  fields?: Record<string, { value?: string; var?: string; secret?: boolean; generator?: string; role?: string; inputType?: string }>;
  seed?: FixtureSeed; // Phase 9 — how to create this precondition (consent-gated)
}

// Phase 2.2 P1.5: observed auth state across the run (no credentials stored here).
export interface AuthState {
  authedAtStart?: boolean; // first screen looked authenticated (no login screen)
  loginScreenSeen?: boolean;
  loginScreenSeenAt?: number;
  loginPerformed?: boolean; // a password/secure field was typed into
  loginPerformedAt?: number;
}

// Phase 2.2 P1.6: budget classes (minutes) keyed by workflow ambition.
export const BUDGET_PROFILES: Record<string, number> = {
  guardrail: 8, // guardrail/setup validation
  login_smoke: 10, // login + one workflow
  full_smoke: 15, // full authenticated smoke
  install_smoke: 20, // install/boot/rebuild involved
};

// Secure input metadata (hardening P0.5). Never carries the value — only that one was provided,
// which flow variable it fills, whether it is secret, and where it came from.
export interface InputMeta {
  varName: string; // e.g. SWIPIUM_TEST_PASSWORD
  secret: boolean;
  source: string; // e.g. 'needs_input:credentials'
  at: number;
}

export interface GeneratedValueRecord {
  at: number;
  fixture: string;
  field: string;
  varName: string;
  generator: string;
  value: string;
  secret: boolean;
  artifactUri?: string;
}

// Security model: raw secret values (generated passwords/OTPs/tokens) must never touch
// disk. In memory we keep the raw value (for same-session reuse via inputValues), but the
// serialized form sent to state.json redacts secret values while preserving all reproducibility
// metadata (varName/field/generator/secret/artifactUri/timestamps). Non-secret generated values
// (e.g. a yopmail email) stay intact for evidence.
export function serializeGeneratedValues(records: GeneratedValueRecord[]): GeneratedValueRecord[] {
  return records.map((r) => (r.secret ? { ...r, value: '<redacted>' } : r));
}

/** state.json form of the session's free-text records: raw registered secret values never touch
 *  disk. Recorded actions go through the same rewrite the generators use (a secret literal typed into
 *  a non-secure field becomes a secret step with no text); note/finding prose is redacted. URIs,
 *  paths and numbers are left alone. */
export function serializeSecretSafe(
  s: Pick<Session, 'secrets' | 'recordedActions' | 'notes' | 'findings' | 'toolErrors'> &
    Partial<Pick<Session, 'jobs' | 'envChanges' | 'mutations' | 'fixtures'>>,
): {
  recordedActions: RecordedAction[];
  notes: TestNote[];
  findings: FindingRecord[];
  toolErrors: ToolErrorRecord[];
  jobs: JobRecord[];
  envChanges: string[];
  mutations: MutationRecord[];
  fixtures: Fixture[];
} {
  const toolErrors = s.toolErrors ?? [];
  const jobs = [...(s.jobs?.values() ?? [])];
  const envChanges = s.envChanges ?? [];
  const mutations = s.mutations ?? [];
  // Fixture values and seed specs are live config, never persisted (not even redacted): a
  // rehydrated session re-reads them from .swipium/fixtures.json (see fixtures/load.ts).
  const fixtures = fixtureMetadata(s.fixtures ?? []);
  if (!s.secrets.size)
    return { recordedActions: s.recordedActions, notes: s.notes, findings: s.findings, toolErrors, jobs, envChanges, mutations, fixtures };
  const redact: Redactor = makeRedactor(s.secrets);
  const r = (v?: string) => (v ? (redact(v) ?? v) : v);
  // Structured records (job results, mutation targets, fixtures): strong secrets scrubbed anywhere,
  // weak (dictionary-like) ones only as a whole value — package ids / selectors stay intact.
  const structured = generatedOutputRedactor(s.secrets);
  return {
    recordedActions: secretSafeActions(s.recordedActions, s.secrets).actions,
    notes: secretSafeNotes(s.notes, s.secrets),
    findings: s.findings.map((f) => ({ ...f, detail: r(f.detail) ?? f.detail, evidence: r(f.evidence) })),
    toolErrors: toolErrors.map((t) => ({ ...t, message: r(t.message) ?? t.message })),
    jobs: jobs.map((j) => ({ ...redactDeep(j, structured), error: r(j.error), progress: r(j.progress), resultText: r(j.resultText) })),
    envChanges: envChanges.map((e) => r(e) ?? e),
    mutations: mutations.map((m) => ({ ...redactDeep(m, structured), detail: r(m.detail) })),
    fixtures: redactDeep(fixtures, structured),
  };
}

// Guided-exploration result summary (Phase 3.3) stored on the session for qa_report.
export interface ExplorationRecord {
  at: number;
  graphUri?: string;
  graphMdUri?: string;
  state: 'completed' | 'blocked' | 'needs_input';
  stoppedReason: string;
  summary: {
    screensVisited: number;
    actionsTried: number;
    workflowsFound: number;
    blockers: number;
    appErrors: number;
    visualOnlyScreens: number;
    unsafeActionsSkipped: number;
    featureCoverage?: Record<string, string>;
    destructiveCandidates?: number;
  };
}

export interface LastSnapshot {
  fullByRef: Map<string, RawNode>;
  signatures: Set<string>;
  allNodes: RawNode[]; // full tree for overlay/obstruction checks (not persisted)
}

export type SessionMode = 'structured' | 'visual-fallback';

export interface Budget {
  maxMinutes: number;
  maxActions: number;
  maxScreenshots: number;
  maxSnapshotFailures: number;
  maxNoChangeActions: number;
}

export const DEFAULT_BUDGET: Budget = {
  maxMinutes: 8,
  maxActions: 20,
  maxScreenshots: 8,
  maxSnapshotFailures: 3,
  maxNoChangeActions: 3,
};

export interface Counters {
  actions: number;
  screenshots: number;
  snapshotFailures: number;
  noChangeActions: number;
}

export interface Session {
  id: string;
  root: string;
  dir: string;
  createdAt: number;
  device?: string;
  appId?: string;
  headless?: boolean; // emulator display mode (if we booted it)
  metroPid?: number; // PID of a Metro dev server we started.
  network?: { changed: boolean; originalAirplane: boolean }; // for auto-restore + report
  envChanges: string[]; // human log of env/lifecycle changes (network, clear_data, force_stop…) for qa_report
  /** App directory the user explicitly chose (monorepo_target resume / explicit projectRoot) —
   *  qa_test_this must not re-ask the monorepo question for this root. */
  chosenTarget?: string;
  /** The ORIGINAL qa_test_this arguments of this session's last run (goal, goalText, flags), so a
   *  resume / re-run can replay the user's intent. Persisted (secret values redacted) + rehydrated. */
  lastTestThisArgs?: TestThisArgsRecord;
  workarounds: string[]; // resourcefulness trail: safe fallbacks Swipium tried (visual fallback, build-from-source, pre-login) — surfaced in qa_report
  exploration?: ExplorationRecord; // last guided-exploration result (Phase 3.3) — surfaced in qa_report
  mode: SessionMode; // structured (uiautomator) vs visual-fallback (screenshots)
  responseMode: ResponseMode; // compact | normal | verbose — shrinks the text channel
  sensitive: boolean; // When true, refuse screenshots/video/logcat (no pixels/logs leave the device)
  budget: Budget;
  counters: Counters;
  screenshotCount: number;
  jobs: Map<string, JobRecord>;
  artifacts: ArtifactRecord[];
  findings: FindingRecord[];
  notes: TestNote[]; // structured test outcomes (qa_note) — Phase 2.2
  mutations: MutationRecord[]; // central mutation ledger for consent-bound side effects
  recordedActions: RecordedAction[]; // action IR for qa_generate target:"flow"
  toolErrors?: ToolErrorRecord[]; // tool calls that returned an error (bounded) — qa_report tool status
  fixtures: Fixture[]; // declared preconditions — Phase 2.2 P1.4
  auth: AuthState; // observed auth state — Phase 2.2 P1.5
  milestones: Record<string, number>; // phase timing markers — Phase 2.2 P1.6
  budgetProfile?: string; // chosen budget class, if any
  secrets: Set<string>; // values typed into secure fields → redacted everywhere (not persisted)
  // True on rehydrated sessions whose persisted state shows prior secret-bearing
  // activity — secrets are (deliberately) never persisted, so after a restart the redaction
  // set is empty and NEW artifacts are no longer scrubbed. Disclosed in qa_report; recomputed
  // on every reload, never written to state.json.
  redactionDegraded?: boolean;
  // Secure input store (hardening P0.5): user-provided inputs from a NeedsInput resume, keyed by
  // the flow variable they fill. METADATA persists (varName/secret/source) so reports can say
  // "credentials provided"; raw VALUES live only in-memory (inputValues) and never persist/log.
  inputs: InputMeta[];
  generatedValues: GeneratedValueRecord[];
  /** Transport the session last had attached (driver.kind) and, for WDA, its base URL. Persisted
   *  as PLAIN fields so a rehydrate re-binds the same transport (session/attach.ts) instead of
   *  guessing from the device-id shape / mutation ledger. Never a live driver. */
  driverKind?: Driver['kind'];
  wdaUrl?: string;
  // live, not persisted:
  /** Set while a session whose persisted transport is WDA runs on a FALLBACK driver (simctl) because
   *  WDA was unreachable at rehydrate. The persisted driverKind/wdaUrl are NOT overwritten while this
   *  is set (a brief WDA outage must not permanently downgrade the session), and getDriver retries
   *  WDA on later calls (session/attach.ts). */
  transportFallback?: { wanted: 'wda'; wdaUrl: string; since: number; lastProbeAt: number };
  inputValues: Map<string, string>; // varName → raw value (for the flow runner); never serialized
  driver?: Driver;
  lastSnapshot?: LastSnapshot;
  aborts: Map<string, AbortController>;
}

/** Original qa_test_this arguments kept on the session (see Session.lastTestThisArgs). */
export interface TestThisArgsRecord {
  goal?: string;
  goalText?: string;
  flags?: Record<string, unknown>;
  at?: number;
}

export interface CreateSessionOptions {
  fixtures?: Fixture[];
  budgetProfile?: string;
  responseMode?: ResponseMode;
  sensitive?: boolean;
  sessionDir?: string;
}

const REGISTRY_DIR = join(homedir(), '.swipium');
const REGISTRY = join(REGISTRY_DIR, 'registry.json');

const TEXT_MIME_RE = /^(text\/[^;]+|application\/(json|xml|yaml|x-yaml|javascript|x-ndjson)|[^;]+\+(json|xml|yaml))(?:$|;)/i;

export function isTextArtifactMime(mime: string): boolean {
  return TEXT_MIME_RE.test(mime);
}

export function artifactDirectoryName(kind: string): string {
  switch (kind) {
    case 'screenshot':
      return 'screenshots';
    case 'recording':
      return 'videos';
    case 'logs':
    case 'logcat':
    case 'metro':
    case 'wda':
      return 'logs';
    default:
      return kind;
  }
}

/** Filesystem-safe artifact file name (review B5): path separators, NUL/control chars and `..`
 * runs are replaced, so a caller-supplied name (e.g. a visual baseline name) can never escape
 * the session directory. Long names are truncated, keeping the extension. */
export function safeArtifactName(name: string): string {
  let n = String(name)
    // eslint-disable-next-line no-control-regex
    .replace(/[\\/\x00-\x1f]/g, '_')
    .replace(/\.{2,}/g, '_')
    .trim();
  if (!n || n === '.') n = 'artifact';
  if (n.length > 180) {
    const ext = extname(n).slice(0, 16);
    n = n.slice(0, 180 - ext.length) + ext;
  }
  return n;
}

/** Percent-encode the characters that would stop a URI segment from matching the
 * swipium:// resource templates (`/`, `,`, space, `%`, `?`, `#`, non-ASCII…). Readable ids such as
 * `feature:login` stay as-is; pair with decodeUriSegment on the read side. */
export function encodeUriSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9\-._~:@!$&'()*+;=]/gu, (c) => encodeURIComponent(c));
}

/** Inverse of encodeUriSegment; returns the input unchanged if it is not valid percent-encoding. */
export function decodeUriSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** Canonical form of a swipium:// URI for equality: every path segment decoded. */
function canonicalUri(uri: string): string {
  return uri.split('/').map(decodeUriSegment).join('/');
}

/** True when `child` is `parent` or lies inside it (both resolved). */
export function isWithinRoot(child: string, parent: string): boolean {
  const c = resolve(child);
  const p = resolve(parent);
  return c === p || c.startsWith(p.endsWith(sep) ? p : p + sep);
}

/** Owner-only permissions for ~/.swipium/runs session data (dirs 0700, files 0600). POSIX only;
 *  best-effort (a chmod failure never breaks a write). */
export const PRIVATE_DIR_MODE = 0o700;
export const PRIVATE_FILE_MODE = 0o600;
function restrictFile(path: string): void {
  if (process.platform === 'win32') return;
  try {
    chmodSync(path, PRIVATE_FILE_MODE);
  } catch {
    /* best-effort */
  }
}
function mkdirPrivate(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: PRIVATE_DIR_MODE });
  if (process.platform === 'win32') return;
  try {
    chmodSync(dir, PRIVATE_DIR_MODE); // mode above only applies to NEWLY created dirs (and umask)
  } catch {
    /* best-effort */
  }
}

function defaultSessionDir(root: string, id: string): string {
  const projectHash = createHash('sha256').update(resolve(root)).digest('hex').slice(0, 16);
  return join(REGISTRY_DIR, 'runs', projectHash, id);
}

/** Trailing debounce for state.json writes (P2 write amplification): every mutator used to
 * rewrite the full file synchronously. Correctness-critical writes (session creation, the
 * mutation ledger, shutdown) still flush synchronously via persistNow()/flushAll(). */
const PERSIST_DEBOUNCE_MS = 150;

export class SessionStore {
  private sessions = new Map<string, Session>();
  // Lazy prior-session loading (P2 startup cost): the registry of up to 200 prior sessions is
  // read on first access (get/list/find/create), not in the constructor.
  private registryLoaded = false;
  private dirty = new Set<Session>();
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  // Sessions created or looked up by id in THIS process (see activeRoots).
  private activeIds = new Set<string>();

  private ensureRegistryLoaded(): void {
    if (this.registryLoaded) return;
    this.registryLoaded = true;
    this.loadRegistry();
    // Retention (session/retention.ts): one non-blocking background prune of old ~/.swipium/runs
    // session dirs per process — never a registered or live session. SWIPIUM_RETENTION_DAYS=off disables.
    scheduleStartupPrune(() => [...this.sessions.values()].map((x) => x.dir));
  }

  create(root: string, budget?: Partial<Budget>, opts?: CreateSessionOptions): Session {
    this.ensureRegistryLoaded();
    const id = randomUUID().slice(0, 8);
    const dir = opts?.sessionDir ?? defaultSessionDir(root, id);
    mkdirPrivate(dir);
    const now = Date.now();
    const s: Session = {
      id,
      root,
      dir,
      createdAt: now,
      screenshotCount: 0,
      mode: 'structured',
      responseMode: opts?.responseMode ?? DEFAULT_RESPONSE_MODE,
      sensitive: opts?.sensitive ?? false,
      budget: { ...DEFAULT_BUDGET, ...(budget ?? {}) },
      counters: { actions: 0, screenshots: 0, snapshotFailures: 0, noChangeActions: 0 },
      envChanges: [],
      workarounds: [],
      jobs: new Map(),
      artifacts: [],
      findings: [],
      notes: [],
      mutations: [],
      recordedActions: [],
      toolErrors: [],
      fixtures: opts?.fixtures ?? [],
      auth: {},
      milestones: { session_start: now },
      budgetProfile: opts?.budgetProfile,
      secrets: new Set(),
      inputs: [],
      generatedValues: [],
      inputValues: new Map(),
      aborts: new Map(),
    };
    this.sessions.set(id, s);
    this.activeIds.add(id);
    this.appendRegistry(id, dir);
    this.persistNow(s); // synchronous: a concurrent instance / crash must see the new session
    return s;
  }

  get(id: string): Session | undefined {
    this.ensureRegistryLoaded();
    const s = this.sessions.get(id);
    if (s) this.activeIds.add(id);
    return s;
  }
  list(): Session[] {
    this.ensureRegistryLoaded();
    return [...this.sessions.values()];
  }

  /** Schedule a state.json write (trailing debounce). Mutators call this on every change;
   * the actual write happens at most once per PERSIST_DEBOUNCE_MS per burst. Use
   * persistNow()/flushAll() where a synchronous write is required for correctness. */
  persist(s: Session): void {
    this.dirty.add(s);
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => this.flushDirty(), PERSIST_DEBOUNCE_MS);
    this.flushTimer.unref?.(); // never keep the process alive just for a pending flush
  }

  /** Write this session's state.json immediately (and drop any pending debounce for it). */
  persistNow(s: Session): void {
    this.dirty.delete(s);
    this.writeState(s);
  }

  /** Flush every dirty session synchronously. Called on shutdown / process exit so a graceful
   * stop never loses debounced state. */
  flushAll(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    for (const s of [...this.dirty]) {
      this.dirty.delete(s);
      this.writeState(s);
    }
  }

  private flushDirty(): void {
    this.flushTimer = undefined;
    for (const s of [...this.dirty]) {
      this.dirty.delete(s);
      this.writeState(s);
    }
  }

  private writeState(s: Session): void {
    try {
      const safe = serializeSecretSafe(s); // registered secret values never reach state.json
      // Keep the plain transport fields in sync with the live driver (duck-typed: no driver import) —
      // except while the live driver is a fallback for an unreachable WDA: the persisted 'wda'
      // transport stays authoritative so a later restart retries it.
      if (s.driver && !(s.transportFallback && s.driver.kind === 'simulator')) {
        s.driverKind = s.driver.kind;
        const baseUrl = (s.driver as { baseUrl?: unknown }).baseUrl;
        if (s.driver.kind === 'wda' && typeof baseUrl === 'string') s.wdaUrl = baseUrl;
      }
      const state = {
        id: s.id,
        root: s.root,
        dir: s.dir,
        createdAt: s.createdAt,
        device: s.device,
        driverKind: s.driverKind,
        wdaUrl: s.wdaUrl,
        appId: s.appId,
        headless: s.headless,
        metroPid: s.metroPid,
        screenshotCount: s.screenshotCount,
        network: s.network,
        envChanges: safe.envChanges,
        workarounds: s.workarounds,
        chosenTarget: s.chosenTarget,
        lastTestThisArgs:
          s.lastTestThisArgs && s.secrets.size ? redactDeep(s.lastTestThisArgs, makeRedactor(s.secrets)) : s.lastTestThisArgs,
        mode: s.mode,
        responseMode: s.responseMode,
        sensitive: s.sensitive,
        budget: s.budget,
        counters: s.counters,
        jobs: safe.jobs,
        artifacts: s.artifacts,
        findings: safe.findings,
        notes: safe.notes,
        mutations: safe.mutations,
        recordedActions: safe.recordedActions,
        toolErrors: safe.toolErrors,
        fixtures: safe.fixtures,
        auth: s.auth,
        milestones: s.milestones,
        budgetProfile: s.budgetProfile,
        inputs: s.inputs, // METADATA only — never the values
        generatedValues: serializeGeneratedValues(s.generatedValues), // secret raw values redacted before disk
        exploration: s.exploration,
      };
      // Atomic write (tmp + rename) so a crash mid-write never leaves a truncated state.json.
      const target = join(s.dir, 'state.json');
      writeFileAtomicSync(target, JSON.stringify(state, null, 2));
      restrictFile(target); // owner-only: state.json carries run history / paths
    } catch (e) {
      // A silent failure here means session state (jobs/artifacts/findings) is lost on restart.
      log('error', 'failed to persist session state.json — this session will not survive a server restart', {
        sessionId: s.id,
        dir: s.dir,
        err: String(e),
      });
    }
  }

  // ---- jobs ----
  createJob(s: Session, kind: string): JobRecord {
    const job: JobRecord = { jobId: randomUUID().slice(0, 8), kind, status: 'running', startedAt: Date.now(), artifactUris: [] };
    s.jobs.set(job.jobId, job);
    s.aborts.set(job.jobId, new AbortController());
    this.persist(s);
    return job;
  }
  abortSignal(s: Session, jobId: string): AbortSignal | undefined {
    return s.aborts.get(jobId)?.signal;
  }

  // ---- mode + budget + counters (Phase 1) ----
  setMode(s: Session, mode: SessionMode): void {
    s.mode = mode;
    this.persist(s);
  }
  /**
   * A structured UI dump just succeeded on this session: visual-fallback is per-screen, never
   * permanent — switch back to 'structured' and restart the consecutive-failure count. Returns
   * true when the session was in visual-fallback (the caller may tell the agent it recovered).
   */
  noteStructuredDump(s: Session): boolean {
    const recovered = s.mode === 'visual-fallback';
    if (!recovered && s.counters.snapshotFailures === 0) return false;
    s.mode = 'structured';
    s.counters.snapshotFailures = 0;
    this.persist(s);
    return recovered;
  }
  bump(s: Session, key: keyof Counters, by = 1): void {
    s.counters[key] += by;
    this.persist(s);
  }
  /** Returns a stop reason if any budget is exhausted, else null. */
  budgetStop(s: Session): string | null {
    const c = s.counters;
    const b = s.budget;
    const mins = (Date.now() - s.createdAt) / 60000;
    if (mins >= b.maxMinutes) return `time budget reached (${mins.toFixed(1)}/${b.maxMinutes} min)`;
    if (c.actions >= b.maxActions) return `action budget reached (${c.actions}/${b.maxActions})`;
    if (c.screenshots >= b.maxScreenshots) return `screenshot budget reached (${c.screenshots}/${b.maxScreenshots})`;
    if (c.noChangeActions >= b.maxNoChangeActions)
      return `repeated no-change actions (${c.noChangeActions}/${b.maxNoChangeActions}) — likely wrong coords / disabled element / auth wall`;
    return null;
  }
  updateJob(s: Session, job: JobRecord, patch: Partial<JobRecord>): void {
    Object.assign(job, patch);
    this.persist(s);
  }
  /** Apply a patch ONLY while the job is still running — so a cancelled (or otherwise
   *  terminal) job is never overwritten back to done/failed by a racing worker. */
  updateJobIfRunning(s: Session, job: JobRecord, patch: Partial<JobRecord>): boolean {
    const cur = s.jobs.get(job.jobId);
    if (!cur || cur.status !== 'running') return false;
    Object.assign(cur, patch);
    this.persist(s);
    return true;
  }
  cancelJob(s: Session, jobId: string): boolean {
    const j = s.jobs.get(jobId);
    if (!j || j.status !== 'running') return false;
    s.aborts.get(jobId)?.abort();
    j.status = 'cancelled';
    j.endedAt = Date.now();
    this.persist(s);
    return true;
  }

  // ---- findings + artifacts ----
  addFinding(s: Session, f: FindingRecord): void {
    s.findings.push(f);
    this.persist(s);
  }
  addEnvChange(s: Session, note: string): void {
    s.envChanges.push(`${new Date().toISOString()} ${note}`);
    this.persist(s);
  }
  /** Record a safe fallback Swipium chose. De-duped. */
  addWorkaround(s: Session, note: string): void {
    if (!s.workarounds.includes(note)) {
      s.workarounds.push(note);
      this.persist(s);
    }
  }
  addNote(s: Session, note: TestNote): void {
    s.notes.push(note);
    this.persist(s);
  }
  recordMutation(s: Session, mutation: Omit<MutationRecord, 'id' | 'at'>): MutationRecord {
    // Audit trail (THREAT_MODEL): stamp HOW a consented action was approved (elicitation vs
    // client re-call assertion) from the consent module, so every call site gets it for free.
    let consent = mutation.consent;
    if (consent?.approved && consent.consentId && !consent.approvalMechanism) {
      const mechanism = approvalMechanismFor(consent.consentId);
      if (mechanism) consent = { ...consent, approvalMechanism: mechanism };
    }
    const rec: MutationRecord = { id: randomUUID().slice(0, 8), at: Date.now(), ...mutation, ...(consent ? { consent } : {}) };
    s.mutations.push(rec);
    if (s.mutations.length > 500) s.mutations.splice(0, s.mutations.length - 500);
    this.persistNow(s); // the mutation ledger is an audit trail — never leave it debounce-only
    return rec;
  }
  /** Record a tool call that returned an error for this session (bounded to the last 200). */
  recordToolError(s: Session, rec: Omit<ToolErrorRecord, 'at'> & { at?: number }): void {
    if (rec.failureCode === 'CANCELLED') return; // cancelled work is not a tool error
    const list = (s.toolErrors ??= []);
    list.push({ at: rec.at ?? Date.now(), tool: rec.tool, failureCode: rec.failureCode, message: rec.message.slice(0, 500) });
    if (list.length > 200) list.splice(0, list.length - 200);
    this.persist(s);
  }
  /** Append an action-IR step (bounded) for qa_generate target:"flow". */
  addRecordedAction(s: Session, ra: RecordedAction): void {
    // Typed text equal to a stored session input (e.g. the email from qa_continue_from_blocker) is
    // recorded as that input's ${VAR} placeholder, never the literal (generators do this too).
    const bound = ra.action === 'type' ? inputPlaceholderFor(ra.text, inputBindings(s)) : undefined;
    if (bound) {
      ra = {
        ...ra,
        text: `\${${swipiumVarName(bound.varName)}}`,
        ...(bound.secret ? { secret: true, exportability: 'needs-human-data' as const } : {}),
      };
    }
    s.recordedActions.push(ra);
    if (s.recordedActions.length > 300) s.recordedActions.splice(0, s.recordedActions.length - 300);
    this.persist(s);
  }
  /** Record a phase-timing marker the first time it happens (Phase 2.2 P1.6). */
  milestone(s: Session, key: string): void {
    if (s.milestones[key] == null) {
      s.milestones[key] = Date.now();
      this.persist(s);
    }
  }
  /** Add an accumulated duration marker in milliseconds for report timing diagnostics. */
  addMilestoneDuration(s: Session, key: string, ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) return;
    s.milestones[key] = (s.milestones[key] ?? 0) + ms;
    this.persist(s);
  }
  /** Merge an auth-state observation (Phase 2.2 P1.5). */
  markAuth(s: Session, patch: Partial<AuthState>): void {
    s.auth = { ...s.auth, ...patch };
    this.persist(s);
  }
  /** Store a user-provided input (hardening P0.5). The VALUE stays in-memory only; secrets are
   *  added to the redaction set. Persists metadata so reports can say it was provided.
   *  Secrets of 3+ characters are redacted (short ones as whole tokens); 1–2 character values are
   *  not matched and are reported as partial redaction (src/lib/redact.ts). */
  setInput(s: Session, varName: string, value: string, secret: boolean, source: string): void {
    s.inputValues.set(varName, value);
    if (secret) s.secrets.add(value);
    const existing = s.inputs.find((i) => i.varName === varName);
    if (existing) {
      existing.secret = secret;
      existing.source = source;
      existing.at = Date.now();
    } else {
      s.inputs.push({ varName, secret, source, at: Date.now() });
    }
    this.persist(s);
  }
  /** Variable map (varName → value) for the flow runner. In-memory values only. */
  inputVariables(s: Session): Record<string, string> {
    return Object.fromEntries(s.inputValues);
  }
  /** Clear all stored input values (e.g. session close). Metadata is left for the report. */
  clearInputValues(s: Session): void {
    s.inputValues.clear();
  }
  /** Remember the ORIGINAL qa_test_this arguments (goal, goalText, flags) of this session's run. */
  setLastTestThisArgs(s: Session, args: TestThisArgsRecord): void {
    s.lastTestThisArgs = { ...args, at: args.at ?? Date.now() };
    this.persist(s);
  }
  /** Record the latest guided-exploration result (Phase 3.3) for qa_report. */
  setExploration(s: Session, rec: ExplorationRecord): void {
    s.exploration = rec;
    this.persist(s);
  }
  saveArtifact(s: Session, kind: string, name: string, data: Buffer | string, mime: string, label?: string): string {
    // B5: never trust kind/name as path components — sanitize, then verify containment.
    kind = safeArtifactName(kind);
    name = safeArtifactName(name);
    const sub = join(s.dir, artifactDirectoryName(kind));
    const path = join(sub, name);
    if (!isWithinRoot(path, s.dir) || resolve(path) === resolve(s.dir)) {
      throw new Error(`Refusing to write artifact outside the session directory: ${kind}/${name}`);
    }
    mkdirPrivate(sub);
    const redact = makeRedactor(s.secrets);
    const isRedactableText = typeof data === 'string' && isTextArtifactMime(mime);
    // JSON/XML artifacts are redacted structurally (string values / attribute values / text
    // nodes only) so a short numeric secret (CVV "123") can never rewrite `{"actions":123}`.
    const storedData = isRedactableText ? redactStructuredText(data, structuredKindOf(mime, name), redact) : data;
    const storedLabel = label ? redact(label) : label;
    const skipped = redact.skippedShortSecrets ?? 0;
    writeFileSync(path, storedData, { mode: PRIVATE_FILE_MODE });
    restrictFile(path); // an overwritten artifact keeps its old mode otherwise
    const uri = `swipium://session/${encodeUriSegment(s.id)}/${encodeUriSegment(kind)}/${encodeUriSegment(name)}`;
    // Binary artifacts (screenshots/recordings) cannot be redacted — tag them explicitly so
    // consumers (qa_get_artifact, reports) know pixels may show sensitive on-screen content.
    s.artifacts.push({
      uri,
      path,
      mime,
      kind,
      createdAt: Date.now(),
      label: storedLabel,
      redaction: !isRedactableText ? 'not-applied' : skipped > 0 ? 'partial' : 'applied',
      ...(isRedactableText && skipped > 0
        ? {
            redactionNote: `${skipped} secret value(s) shorter than 3 characters were not redacted (matching them would corrupt ordinary text).`,
          }
        : {}),
    });
    this.persist(s);
    return uri;
  }
  findArtifact(uri: string): { session: Session; rec: ArtifactRecord } | undefined {
    this.ensureRegistryLoaded();
    for (const s of this.sessions.values()) {
      const rec = s.artifacts.find((a) => a.uri === uri);
      if (rec) return { session: s, rec };
    }
    // Encoding-insensitive fallback: a client (or URL normalisation) may percent-encode a URI
    // that was stored raw (pre-1.6 records), or vice versa.
    const want = canonicalUri(uri);
    for (const s of this.sessions.values()) {
      const rec = s.artifacts.find((a) => canonicalUri(a.uri) === want);
      if (rec) return { session: s, rec };
    }
    return undefined;
  }
  /** Project roots this server process is actively working on: roots of sessions created here
   * or touched by a tool call (get) since start — NOT every prior session reloaded from the
   * machine-wide registry. Used to scope resources/list to the current project(s). */
  activeRoots(): string[] {
    this.ensureRegistryLoaded();
    const roots = new Set<string>();
    for (const id of this.activeIds) {
      const s = this.sessions.get(id);
      if (s) roots.add(s.root);
    }
    return [...roots];
  }

  // ---- persistence reload (lazy — triggered by the first get/list/find/create) ----
  private loadRegistry(): void {
    try {
      if (!existsSync(REGISTRY)) return;
      const reg = JSON.parse(readFileSync(REGISTRY, 'utf8')) as Array<{ id: string; dir: string }>;
      for (const { dir } of reg) {
        const sp = join(dir, 'state.json');
        if (!existsSync(sp)) continue;
        try {
          const st = JSON.parse(readFileSync(sp, 'utf8'));
          // Never clobber a LIVE session created by this process (lazy load can run after create()).
          if (typeof st.id === 'string' && this.sessions.has(st.id)) continue;
          const jobs = new Map<string, JobRecord>((st.jobs ?? []).map((j: JobRecord) => [j.jobId, j]));
          for (const j of jobs.values()) {
            if (j.status === 'running') {
              j.status = 'failed';
              j.error = 'server restarted while job was running (child process gone)';
            }
          }
          // Orphaned-process handling: a prior server persisted its Metro pid. If no live
          // server instance owns that pid, reclaimPid (processRegistry) reaps it ONLY when the
          // registry's recorded fingerprint (start time + full command) still matches — a
          // recycled or unverifiable pid is never signalled, and a process group is signalled
          // only when Swipium spawned the child as a group leader. Either way the reloaded
          // session drops the pid — it is not ours to manage (or stop) anymore.
          if (typeof st.metroPid === 'number' && st.metroPid > 0) {
            if (!pidOwnedByLiveServer(st.metroPid)) {
              const outcome = reclaimPid(st.metroPid, 'metro');
              if (outcome === 'killed')
                log('warn', 'reaped orphaned Metro bundler from a previous server run', { pid: st.metroPid, sessionId: st.id });
            }
            st.metroPid = undefined; // reaped, gone, recycled, or another live server's — never ours
          }
          // Raw secret values never touch disk, so a rehydrated session cannot rebuild
          // its redaction set. If the persisted state shows prior secret-bearing activity
          // (secret inputs, secret generated values, or a performed login), flag the session so
          // qa_report discloses that artifacts written after the restart are no longer scrubbed.
          const priorSecrets =
            (st.inputs ?? []).some((i: InputMeta) => i.secret) ||
            (st.generatedValues ?? []).some((g: GeneratedValueRecord) => g.secret) ||
            st.auth?.loginPerformed === true;
          const s: Session = {
            id: st.id,
            root: st.root,
            dir: st.dir,
            createdAt: st.createdAt,
            device: st.device,
            appId: st.appId,
            headless: st.headless,
            metroPid: st.metroPid,
            screenshotCount: st.screenshotCount ?? 0,
            network: st.network,
            envChanges: st.envChanges ?? [],
            workarounds: st.workarounds ?? [],
            chosenTarget: typeof st.chosenTarget === 'string' ? st.chosenTarget : undefined,
            lastTestThisArgs:
              st.lastTestThisArgs && typeof st.lastTestThisArgs === 'object' && !Array.isArray(st.lastTestThisArgs)
                ? (st.lastTestThisArgs as TestThisArgsRecord)
                : undefined,
            mode: st.mode ?? 'structured',
            responseMode: st.responseMode ?? DEFAULT_RESPONSE_MODE,
            sensitive: st.sensitive ?? false,
            budget: { ...DEFAULT_BUDGET, ...(st.budget ?? {}) },
            counters: { actions: 0, screenshots: 0, snapshotFailures: 0, noChangeActions: 0, ...(st.counters ?? {}) },
            jobs,
            artifacts: st.artifacts ?? [],
            findings: st.findings ?? [],
            notes: st.notes ?? [],
            mutations: st.mutations ?? [],
            recordedActions: st.recordedActions ?? [],
            toolErrors: st.toolErrors ?? [],
            driverKind: typeof st.driverKind === 'string' ? st.driverKind : undefined,
            wdaUrl: typeof st.wdaUrl === 'string' ? st.wdaUrl : undefined,
            // Live fixture values come from the project's fixtures.json (+ SWIPIUM_* env at use),
            // never from state.json — which only holds value-less metadata.
            fixtures: rehydrateFixtures(st.root, st.fixtures),
            auth: st.auth ?? {},
            milestones: st.milestones ?? { session_start: st.createdAt },
            budgetProfile: st.budgetProfile,
            secrets: new Set(),
            redactionDegraded: priorSecrets || undefined,
            inputs: st.inputs ?? [],
            generatedValues: st.generatedValues ?? [],
            inputValues: new Map(),
            exploration: st.exploration,
            aborts: new Map(),
          };
          this.sessions.set(s.id, s);
        } catch (e) {
          // Skip a corrupt session, but say so — otherwise prior artifacts/reports vanish silently.
          log('warn', 'skipping corrupt prior session state.json on reload', { dir, err: String(e) });
        }
      }
    } catch (e) {
      log('warn', 'session registry unreadable — prior sessions will not be reloaded', { registry: REGISTRY, err: String(e) });
    }
  }
  /** Append this session to the shared ~/.swipium/registry.json. Guarded by an advisory
   * lockfile + atomic rename so two concurrent server instances (common with multiple MCP
   * clients) never clobber each other's read-modify-write. */
  private appendRegistry(id: string, dir: string): void {
    try {
      mkdirSync(REGISTRY_DIR, { recursive: true });
      withFileLock(`${REGISTRY}.lock`, () => {
        let reg: Array<{ id: string; dir: string }> = [];
        if (existsSync(REGISTRY)) {
          try {
            const parsed: unknown = JSON.parse(readFileSync(REGISTRY, 'utf8'));
            if (Array.isArray(parsed)) reg = parsed;
          } catch (e) {
            log('warn', 'registry.json corrupt — rebuilding it (prior sessions may need re-registration)', {
              registry: REGISTRY,
              err: String(e),
            });
          }
        }
        reg.push({ id, dir });
        writeFileAtomicSync(REGISTRY, JSON.stringify(reg.slice(-200), null, 2)); // atomic on the same filesystem
      });
    } catch (e) {
      log('error', 'failed to append session to registry — it will not be reloadable after a restart', { id, dir, err: String(e) });
    }
  }
}
