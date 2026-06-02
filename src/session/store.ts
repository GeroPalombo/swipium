// Session + job + artifact store with DISK PERSISTENCE (DESIGN §3, M6).
// Live, non-serializable bits (driver, lastSnapshot, abort controllers) stay in memory;
// a serializable subset is written to <sessionDir>/state.json on every mutation, and a
// small registry under ~/.swipium/registry.json lets a fresh server instance reload
// prior sessions so artifacts/reports/job-status survive a server restart. (A restart does
// NOT resurrect a running child process — such jobs are marked failed on reload.)

import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import type { Driver } from '../drivers/Driver.js';
import type { RawNode } from '../snapshot/parse.js';
import type { ResponseMode } from '../lib/result.js';
import { DEFAULT_RESPONSE_MODE } from '../lib/result.js';
import { makeRedactor } from '../lib/redact.js';

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
}

export interface MutationRecord {
  id: string;
  at: number;
  tool: string;
  action: string;
  risk: 'low' | 'medium' | 'high';
  target: Record<string, unknown>;
  consent?: { required: boolean; consentId?: string; approved: boolean; payloadHash?: string };
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
  failureCode?: string; // typed failure class (PHASE3-PLAN §4.3); else derived from kind in qa_report
}

// Phase 2.2: a structured test outcome the agent records via qa_note — distinguishes a real
// app bug from a blocked precondition / missing test data / intentional skip / refused action,
// so reports stop mislabeling "no saved flight to delete" as a failure.
export type TestOutcome = 'pass' | 'fail' | 'blocked' | 'skipped' | 'not_applicable';
export type TestCategory =
  | 'app_bug'
  | 'mcp_limitation'
  | 'missing_test_data'
  | 'intentionally_skipped'
  | 'destructive_refused'
  | 'other';
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
  method?: 'visual' | 'ocr' | 'structured'; // PHASE3-PLAN §8 — how the assertion was verified
  evidenceKind?: TestEvidenceKind;
  confidence?: number;
  minConfidence?: number;
  decision?: string;
}

// Action IR (DESIGN §8 / PHASE3-PLAN §4.1): qa_act appends a tagged step here as the agent
// explores, so a successful run can be serialized into a durable flow (qa_flow_generate). The
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

// Phase 2.2 P1.4: a declared test precondition / fixture. Swipium does NOT mutate app state;
// it surfaces what a workflow needs so an unmet precondition reads as "blocked + setup guidance"
// rather than a failure. Loaded from qa_start_session { fixtures } and/or .swipium/fixtures.json.
// Phase 9 (PHASE3-PLAN §4.4): an OPT-IN, consent-gated seed spec that turns a declared
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

// Security model (REQ-02): raw secret values (generated passwords/OTPs/tokens) must never touch
// disk. In memory we keep the raw value (for same-session reuse via inputValues), but the
// serialized form sent to state.json redacts secret values while preserving all reproducibility
// metadata (varName/field/generator/secret/artifactUri/timestamps). Non-secret generated values
// (e.g. a yopmail email) stay intact for evidence.
export function serializeGeneratedValues(records: GeneratedValueRecord[]): GeneratedValueRecord[] {
  return records.map((r) => (r.secret ? { ...r, value: '<redacted>' } : r));
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
  workarounds: string[]; // resourcefulness trail (roadmap §11): safe fallbacks Swipium tried (visual fallback, build-from-source, pre-login) — surfaced in qa_report
  exploration?: ExplorationRecord; // last guided-exploration result (Phase 3.3) — surfaced in qa_report
  mode: SessionMode; // structured (uiautomator) vs visual-fallback (screenshots)
  responseMode: ResponseMode; // compact | normal | verbose — shrinks the text channel (PHASE3-PLAN §2.1)
  sensitive: boolean; // NEXT-PLAN: when true, refuse screenshots/video/logcat (no pixels/logs leave the device)
  budget: Budget;
  counters: Counters;
  screenshotCount: number;
  jobs: Map<string, JobRecord>;
  artifacts: ArtifactRecord[];
  findings: FindingRecord[];
  notes: TestNote[]; // structured test outcomes (qa_note) — Phase 2.2
  mutations: MutationRecord[]; // central mutation ledger for consent-bound side effects
  recordedActions: RecordedAction[]; // action IR for qa_flow_generate (PHASE3-PLAN §4.1)
  fixtures: Fixture[]; // declared preconditions — Phase 2.2 P1.4
  auth: AuthState; // observed auth state — Phase 2.2 P1.5
  milestones: Record<string, number>; // phase timing markers — Phase 2.2 P1.6
  budgetProfile?: string; // chosen budget class, if any
  secrets: Set<string>; // values typed into secure fields → redacted everywhere (not persisted)
  // Secure input store (hardening P0.5): user-provided inputs from a NeedsInput resume, keyed by
  // the flow variable they fill. METADATA persists (varName/secret/source) so reports can say
  // "credentials provided"; raw VALUES live only in-memory (inputValues) and never persist/log.
  inputs: InputMeta[];
  generatedValues: GeneratedValueRecord[];
  // live, not persisted:
  inputValues: Map<string, string>; // varName → raw value (for the flow runner); never serialized
  driver?: Driver;
  lastSnapshot?: LastSnapshot;
  aborts: Map<string, AbortController>;
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
    case 'screenshot': return 'screenshots';
    case 'recording': return 'videos';
    case 'logs':
    case 'logcat':
    case 'metro':
    case 'wda':
      return 'logs';
    default:
      return kind;
  }
}

function defaultSessionDir(root: string, id: string): string {
  const projectHash = createHash('sha256').update(resolve(root)).digest('hex').slice(0, 16);
  return join(REGISTRY_DIR, 'runs', projectHash, id);
}

export class SessionStore {
  private sessions = new Map<string, Session>();

  constructor() {
    this.loadRegistry();
  }

  create(root: string, budget?: Partial<Budget>, opts?: CreateSessionOptions): Session {
    const id = randomUUID().slice(0, 8);
    const dir = opts?.sessionDir ?? defaultSessionDir(root, id);
    mkdirSync(dir, { recursive: true });
    const now = Date.now();
    const s: Session = {
      id, root, dir, createdAt: now, screenshotCount: 0,
      mode: 'structured',
      responseMode: opts?.responseMode ?? DEFAULT_RESPONSE_MODE,
      sensitive: opts?.sensitive ?? false,
      budget: { ...DEFAULT_BUDGET, ...(budget ?? {}) },
      counters: { actions: 0, screenshots: 0, snapshotFailures: 0, noChangeActions: 0 },
      envChanges: [], workarounds: [],
      jobs: new Map(), artifacts: [], findings: [], notes: [], mutations: [], recordedActions: [],
      fixtures: opts?.fixtures ?? [], auth: {}, milestones: { session_start: now }, budgetProfile: opts?.budgetProfile,
      secrets: new Set(), inputs: [], generatedValues: [], inputValues: new Map(), aborts: new Map(),
    };
    this.sessions.set(id, s);
    this.appendRegistry(id, dir);
    this.persist(s);
    return s;
  }

  get(id: string): Session | undefined {
    return this.sessions.get(id);
  }
  list(): Session[] {
    return [...this.sessions.values()];
  }

  persist(s: Session): void {
    try {
      const state = {
        id: s.id, root: s.root, dir: s.dir, createdAt: s.createdAt,
        device: s.device, appId: s.appId, headless: s.headless, metroPid: s.metroPid, screenshotCount: s.screenshotCount,
        network: s.network, envChanges: s.envChanges, workarounds: s.workarounds,
        mode: s.mode, responseMode: s.responseMode, sensitive: s.sensitive, budget: s.budget, counters: s.counters,
        jobs: [...s.jobs.values()], artifacts: s.artifacts, findings: s.findings, notes: s.notes, mutations: s.mutations, recordedActions: s.recordedActions,
        fixtures: s.fixtures, auth: s.auth, milestones: s.milestones, budgetProfile: s.budgetProfile,
        inputs: s.inputs, // METADATA only — never the values
        generatedValues: serializeGeneratedValues(s.generatedValues), // secret raw values redacted before disk
        exploration: s.exploration,
      };
      writeFileSync(join(s.dir, 'state.json'), JSON.stringify(state, null, 2));
    } catch {
      /* best-effort */
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
    if (c.noChangeActions >= b.maxNoChangeActions) return `repeated no-change actions (${c.noChangeActions}/${b.maxNoChangeActions}) — likely wrong coords / disabled element / auth wall`;
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
  /** Record a safe fallback Swipium chose (roadmap §11 "workarounds attempted"). De-duped. */
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
    const rec: MutationRecord = { id: randomUUID().slice(0, 8), at: Date.now(), ...mutation };
    s.mutations.push(rec);
    if (s.mutations.length > 500) s.mutations.splice(0, s.mutations.length - 500);
    this.persist(s);
    return rec;
  }
  /** Append an action-IR step (bounded) for qa_flow_generate. */
  addRecordedAction(s: Session, ra: RecordedAction): void {
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
   *  added to the redaction set. Persists metadata so reports can say it was provided. */
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
  /** Record the latest guided-exploration result (Phase 3.3) for qa_report. */
  setExploration(s: Session, rec: ExplorationRecord): void {
    s.exploration = rec;
    this.persist(s);
  }
  saveArtifact(s: Session, kind: string, name: string, data: Buffer | string, mime: string, label?: string): string {
    const sub = join(s.dir, artifactDirectoryName(kind));
    mkdirSync(sub, { recursive: true });
    const path = join(sub, name);
    const redact = makeRedactor(s.secrets);
    const storedData = typeof data === 'string' && isTextArtifactMime(mime) ? (redact(data) ?? '') : data;
    const storedLabel = label ? redact(label) : label;
    writeFileSync(path, storedData);
    const uri = `swipium://session/${s.id}/${kind}/${name}`;
    s.artifacts.push({ uri, path, mime, kind, createdAt: Date.now(), label: storedLabel });
    this.persist(s);
    return uri;
  }
  findArtifact(uri: string): { session: Session; rec: ArtifactRecord } | undefined {
    for (const s of this.sessions.values()) {
      const rec = s.artifacts.find((a) => a.uri === uri);
      if (rec) return { session: s, rec };
    }
    return undefined;
  }

  // ---- persistence reload ----
  private loadRegistry(): void {
    try {
      if (!existsSync(REGISTRY)) return;
      const reg = JSON.parse(readFileSync(REGISTRY, 'utf8')) as Array<{ id: string; dir: string }>;
      for (const { dir } of reg) {
        const sp = join(dir, 'state.json');
        if (!existsSync(sp)) continue;
        try {
          const st = JSON.parse(readFileSync(sp, 'utf8'));
          const jobs = new Map<string, JobRecord>((st.jobs ?? []).map((j: JobRecord) => [j.jobId, j]));
          for (const j of jobs.values()) {
            if (j.status === 'running') {
              j.status = 'failed';
              j.error = 'server restarted while job was running (child process gone)';
            }
          }
          const s: Session = {
            id: st.id, root: st.root, dir: st.dir, createdAt: st.createdAt,
            device: st.device, appId: st.appId, headless: st.headless, metroPid: st.metroPid, screenshotCount: st.screenshotCount ?? 0,
            network: st.network, envChanges: st.envChanges ?? [], workarounds: st.workarounds ?? [],
            mode: st.mode ?? 'structured',
            responseMode: st.responseMode ?? DEFAULT_RESPONSE_MODE,
            sensitive: st.sensitive ?? false,
            budget: { ...DEFAULT_BUDGET, ...(st.budget ?? {}) },
            counters: { actions: 0, screenshots: 0, snapshotFailures: 0, noChangeActions: 0, ...(st.counters ?? {}) },
            jobs, artifacts: st.artifacts ?? [], findings: st.findings ?? [], notes: st.notes ?? [], mutations: st.mutations ?? [], recordedActions: st.recordedActions ?? [],
            fixtures: st.fixtures ?? [], auth: st.auth ?? {}, milestones: st.milestones ?? { session_start: st.createdAt }, budgetProfile: st.budgetProfile,
            secrets: new Set(), inputs: st.inputs ?? [], generatedValues: st.generatedValues ?? [], inputValues: new Map(), exploration: st.exploration, aborts: new Map(),
          };
          this.sessions.set(s.id, s);
        } catch {
          /* skip a corrupt session */
        }
      }
    } catch {
      /* no registry */
    }
  }
  private appendRegistry(id: string, dir: string): void {
    try {
      mkdirSync(REGISTRY_DIR, { recursive: true });
      const reg: Array<{ id: string; dir: string }> = existsSync(REGISTRY) ? JSON.parse(readFileSync(REGISTRY, 'utf8')) : [];
      reg.push({ id, dir });
      writeFileSync(REGISTRY, JSON.stringify(reg.slice(-200), null, 2));
    } catch {
      /* best-effort */
    }
  }
}
