// Screen graph (Phase 3.3 Milestone B) — model exploration as nodes (screens) + edges (actions),
// not free-form notes. Nodes dedupe by signature so revisiting Home collapses to one node while a
// modal/sheet becomes a distinct node. PURE: serialization only; the runner drives it.

export type ScreenMode = 'structured' | 'visual';
export type Platform = 'android' | 'ios';

export interface LocatorInfo {
  strategy: 'accessibility' | 'id' | 'text' | 'class' | 'coordinate' | 'image' | 'ocr_text' | 'visual_region';
  value: string;
  durability: 'high' | 'medium' | 'low';
}

export interface ExploreElement {
  ref?: string;
  candidateSignature?: string;
  label?: string;
  role?: string;
  bounds?: { x: number; y: number; w: number; h: number };
  locator?: LocatorInfo;
  actionType: 'tap' | 'type' | 'toggle' | 'scroll' | 'back' | 'assert_visual';
  secure?: boolean; // password / secure-text field (SWIPIUM-REQ-02 input planning)
  risk: 'safe' | 'unknown' | 'destructive';
  riskClass?: string;
  stepUp?: boolean;
  requiresTwoStepConfirmation?: boolean;
  reason: string;
}

export interface ScreenNode {
  id: string;
  signature: string;
  title?: string;
  urlOrRoute?: string;
  mode: ScreenMode;
  platform: Platform;
  screenshotUri?: string;
  dumpUri?: string;
  health: { native: 'OK' | 'error'; app: 'OK' | 'degraded' | 'error' };
  authState?: string;
  visualOnlyReason?: string;
  locatorQuality?: { grade: 'A' | 'B' | 'C' | 'D'; missingStableLocators: number; coordinateOnlyTargets: number };
  elements: ExploreElement[];
  visits: number;
}

export type EdgeOutcome = 'changed_screen' | 'same_screen' | 'blocked' | 'app_error' | 'native_error' | 'unsafe_refused';

export interface ExploreEdge {
  from: string;
  to?: string;
  action: { type: 'tap' | 'type' | 'scroll' | 'back' | 'deep_link' | 'wait'; targetDescription: string; locator?: Record<string, unknown> };
  outcome: EdgeOutcome;
  evidenceUris: string[];
  noteId?: string;
  riskDecision?: string;
  preActionState?: string;
  postActionState?: string;
  oracle?: string;
}

export type FeatureKey =
  | 'navigation'
  | 'auth'
  | 'search'
  | 'create'
  | 'edit'
  | 'delete'
  | 'share/send'
  | 'settings'
  | 'media'
  | 'map/location'
  | 'purchase'
  | 'profile'
  | 'notifications';

export type FeatureStatus = 'covered' | 'blocked' | 'unsafe' | 'not_found' | 'needs_fixture';

export interface ExploreTask {
  id: string;
  title: string;
  feature: FeatureKey;
  preconditions: string[];
  risk: 'safe' | 'unknown' | 'destructive';
  status: 'proposed' | 'completed' | 'blocked' | 'unsafe' | 'not_applicable';
  evidence?: string;
}

export interface CoverageClaim {
  feature: FeatureKey;
  status: FeatureStatus;
  evidence: string[];
  reason: string;
}

export interface ReflectionResult {
  shallowLoops: string[];
  repeatedSameScreenActions: number;
  lowLocatorReadinessScreens: string[];
  promotedPathCandidate?: string;
  suiteReadiness: 'none' | 'candidate' | 'rejected';
  reasons: string[];
}

export interface SerializedGraph {
  schemaVersion: 2;
  generatedAt: string;
  platform: Platform;
  nodes: ScreenNode[];
  edges: ExploreEdge[];
  rootId?: string;
  tasks: ExploreTask[];
  hypotheses: string[];
  coverageClaims: CoverageClaim[];
  blockedPreconditions: string[];
  reflection?: ReflectionResult;
}

export class ExploreGraph {
  private nodes = new Map<string, ScreenNode>(); // by signature
  private order: string[] = []; // insertion order of signatures
  private edges: ExploreEdge[] = [];
  private tasks: ExploreTask[] = [];
  private hypotheses: string[] = [];
  private coverageClaims: CoverageClaim[] = [];
  private blockedPreconditions: string[] = [];
  private reflection?: ReflectionResult;
  rootId?: string;

  constructor(private platform: Platform) {}

  /** Add a node if its signature is new, else bump the existing node's visit count. Returns the node. */
  upsert(node: Omit<ScreenNode, 'id' | 'visits'>): { node: ScreenNode; isNew: boolean } {
    const existing = this.nodes.get(node.signature);
    if (existing) {
      existing.visits++;
      // Refresh evidence/health on revisit (latest wins) without losing identity.
      if (node.screenshotUri) existing.screenshotUri = node.screenshotUri;
      existing.health = node.health;
      return { node: existing, isNew: false };
    }
    const id = `s${this.order.length + 1}`;
    const full: ScreenNode = { ...node, id, visits: 1 };
    this.nodes.set(node.signature, full);
    this.order.push(node.signature);
    if (!this.rootId) this.rootId = id;
    return { node: full, isNew: true };
  }

  /** Look up a node by its current signature (for "did the screen change?"). */
  bySignature(signature: string): ScreenNode | undefined {
    return this.nodes.get(signature);
  }

  addEdge(edge: ExploreEdge): void {
    this.edges.push(edge);
  }

  nodeCount(): number {
    return this.nodes.size;
  }
  edgeCount(): number {
    return this.edges.length;
  }
  allNodes(): ScreenNode[] {
    return this.order.map((sig) => this.nodes.get(sig)!);
  }
  allEdges(): ExploreEdge[] {
    return [...this.edges];
  }
  setTasks(tasks: ExploreTask[]): void {
    this.tasks = tasks;
  }
  setHypotheses(hypotheses: string[]): void {
    this.hypotheses = hypotheses;
  }
  setCoverageClaims(claims: CoverageClaim[]): void {
    this.coverageClaims = claims;
  }
  setBlockedPreconditions(blocked: string[]): void {
    this.blockedPreconditions = blocked;
  }
  setReflection(reflection: ReflectionResult): void {
    this.reflection = reflection;
  }

  serialize(generatedAt: string): SerializedGraph {
    return {
      schemaVersion: 2,
      generatedAt,
      platform: this.platform,
      nodes: this.allNodes(),
      edges: this.edges,
      rootId: this.rootId,
      tasks: this.tasks,
      hypotheses: this.hypotheses,
      coverageClaims: this.coverageClaims,
      blockedPreconditions: this.blockedPreconditions,
      reflection: this.reflection,
    };
  }

  /** Human-readable Markdown summary of the graph. */
  toMarkdown(generatedAt: string): string {
    const out: string[] = [
      `# Exploration Screen Graph`,
      ``,
      `Generated: ${generatedAt} · platform: ${this.platform} · ${this.nodes.size} screens / ${this.edges.length} actions`,
      ``,
    ];
    for (const n of this.allNodes()) {
      out.push(
        `## ${n.id}${n.title ? ` — ${n.title}` : ''} (${n.mode})`,
        `- signature: \`${n.signature}\``,
        `- health: native ${n.health.native} · app ${n.health.app}${n.authState ? ` · auth ${n.authState}` : ''}`,
        ...(n.visualOnlyReason ? [`- visual-only: ${n.visualOnlyReason}`] : []),
        ...(n.locatorQuality
          ? [
              `- locator readiness: ${n.locatorQuality.grade} (${n.locatorQuality.missingStableLocators} missing stable, ${n.locatorQuality.coordinateOnlyTargets} coordinate-only)`,
            ]
          : []),
        ...(n.screenshotUri ? [`- screenshot: ${n.screenshotUri}`] : []),
        `- elements: ${n.elements.length} (${n.elements.filter((e) => e.risk === 'safe').length} safe, ${n.elements.filter((e) => e.risk === 'destructive').length} destructive)`,
        ``,
      );
    }
    if (this.edges.length) {
      out.push(`## Transitions`, ``);
      for (const e of this.edges) {
        out.push(`- ${e.from} —[${e.action.type} ${e.action.targetDescription}]→ ${e.to ?? '?'} (${e.outcome})`);
      }
    }
    if (this.tasks.length) {
      out.push('', '## Tasks', '');
      for (const t of this.tasks) out.push(`- ${t.id}: ${t.title} [${t.feature}] — ${t.status}`);
    }
    if (this.coverageClaims.length) {
      out.push('', '## Feature Coverage', '');
      for (const c of this.coverageClaims) out.push(`- ${c.feature}: ${c.status} — ${c.reason}`);
    }
    if (this.reflection) {
      out.push('', '## Reflection', '');
      for (const r of this.reflection.reasons) out.push(`- ${r}`);
    }
    return out.join('\n');
  }
}
