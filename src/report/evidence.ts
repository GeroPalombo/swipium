export type EvidenceKind = 'structured_locator' | 'ocr_locator' | 'visual_match' | 'ai_visual_evidence' | 'manual_review';
export type EvidenceAuthority = 'deterministic' | 'probabilistic' | 'manual';
export type EvidenceMethod = 'structured' | 'ocr' | 'visual';

export interface EvidenceNote {
  workflow: string;
  outcome?: string;
  method?: EvidenceMethod;
  verifiedVisually?: boolean;
  artifactUris?: string[];
  evidenceKind?: EvidenceKind | 'ocr_text';
  confidence?: number;
  minConfidence?: number;
  decision?: string;
  /** Who wrote the note (2.4.0+). Older notes have none and fall back to heuristics. */
  origin?: string;
  /** A flow verdict that came from a visual step. */
  visualStep?: boolean;
  source?: string;
  reason?: string;
}

export interface EvidenceAssessment {
  workflow: string;
  outcome?: string;
  kind: EvidenceKind;
  authority: EvidenceAuthority;
  method: EvidenceMethod | 'unlabeled';
  artifactUris: string[];
  confidence?: number;
  minConfidence?: number;
  decision?: string;
  warning?: string;
}

export interface EvidenceTaxonomy {
  schema: 'swipium.evidence.taxonomy.v1';
  counts: Record<EvidenceKind, number>;
  byAuthority: Record<EvidenceAuthority, number>;
  assessments: EvidenceAssessment[];
  calibration: {
    status: 'not_required' | 'required_missing';
    requiredCorpus?: string;
    note: string;
  };
}

const EVIDENCE_KINDS: EvidenceKind[] = ['structured_locator', 'ocr_locator', 'visual_match', 'ai_visual_evidence', 'manual_review'];
const AUTHORITIES: EvidenceAuthority[] = ['deterministic', 'probabilistic', 'manual'];

function emptyCounts(): Record<EvidenceKind, number> {
  return Object.fromEntries(EVIDENCE_KINDS.map((kind) => [kind, 0])) as Record<EvidenceKind, number>;
}

function emptyAuthorityCounts(): Record<EvidenceAuthority, number> {
  return Object.fromEntries(AUTHORITIES.map((authority) => [authority, 0])) as Record<EvidenceAuthority, number>;
}

function isAiVisualWorkflow(workflow: string): boolean {
  return /(^|[_:\-\s])ai[_:\-\s]?visual/i.test(workflow);
}

/** The label the note's own fields give it (method / evidenceKind / verifiedVisually). This is the
 *  whole rule for agent notes; Swipium's own notes are labeled by origin first. */
function labelFromFields(note: EvidenceNote): EvidenceKind {
  if (note.evidenceKind === 'structured_locator' || note.method === 'structured') return 'structured_locator';
  if (note.evidenceKind === 'ai_visual_evidence') return 'ai_visual_evidence';
  // An explicit manual_review (qa_visual assert: an agent-asserted screenshot) stays manual
  // even though it carries method:'visual' / verifiedVisually; it is not a visual match.
  if (note.evidenceKind === 'manual_review') return 'manual_review';
  if (note.evidenceKind === 'ocr_locator' || note.evidenceKind === 'ocr_text' || note.method === 'ocr') return 'ocr_locator';
  if (note.evidenceKind === 'visual_match' || note.method === 'visual' || note.verifiedVisually)
    return isAiVisualWorkflow(note.workflow) ? 'ai_visual_evidence' : 'visual_match';
  if (isAiVisualWorkflow(note.workflow)) return 'ai_visual_evidence';
  return 'manual_review';
}

/** Pre-2.4.0 notes carry no origin: recognise Swipium's own checks by their shape. */
function looksSwipiumRun(note: EvidenceNote): boolean {
  return note.workflow === 'launch_smoke' || /^qa_flow_run\b/.test(note.reason ?? '') || /:note$/.test(note.workflow);
}

export function evidenceKindForNote(note: EvidenceNote): EvidenceKind {
  switch (note.origin) {
    case 'flow':
    case 'flow_note':
      return note.visualStep ? 'visual_match' : 'structured_locator';
    case 'smoke':
      // A visual-only smoke (no UI tree) judged a screenshot, not the tree.
      return note.method === 'visual' ? labelFromFields(note) : 'structured_locator';
    case 'explore':
      return 'structured_locator';
    case 'agent':
      return labelFromFields(note);
  }
  const fromFields = labelFromFields(note);
  // Old Swipium notes were filed as manual_review only because nothing labeled them. The heuristic
  // only lifts them to structured; it never claims a visual match it can't see.
  if (fromFields === 'manual_review' && note.source !== 'qa_note' && looksSwipiumRun(note)) return 'structured_locator';
  return fromFields;
}

export function evidenceAuthority(kind: EvidenceKind): EvidenceAuthority {
  if (kind === 'structured_locator') return 'deterministic';
  if (kind === 'manual_review') return 'manual';
  return 'probabilistic';
}

function warningForKind(kind: EvidenceKind): string | undefined {
  if (kind === 'ocr_locator') return 'OCR evidence is probabilistic; use structured locators before CI promotion.';
  if (kind === 'visual_match') return 'Visual screenshot evidence is probabilistic; keep it separate from structured assertions.';
  if (kind === 'ai_visual_evidence') return 'AI visual evidence is probabilistic and requires calibration against a dogfood corpus.';
  if (kind === 'manual_review') return 'No structured, OCR, or visual method label was recorded; review this evidence manually.';
  return undefined;
}

export function evidenceAssessmentForNote(note: EvidenceNote): EvidenceAssessment {
  const kind = evidenceKindForNote(note);
  return {
    workflow: note.workflow,
    outcome: note.outcome,
    kind,
    authority: evidenceAuthority(kind),
    method: note.method ?? 'unlabeled',
    artifactUris: note.artifactUris ?? [],
    confidence: note.confidence,
    minConfidence: note.minConfidence,
    decision: note.decision,
    warning: warningForKind(kind),
  };
}

export function evidenceTaxonomyForNotes(notes: EvidenceNote[]): EvidenceTaxonomy {
  const assessments = notes.map(evidenceAssessmentForNote);
  const counts = emptyCounts();
  const byAuthority = emptyAuthorityCounts();
  for (const assessment of assessments) {
    counts[assessment.kind]++;
    byAuthority[assessment.authority]++;
  }
  const hasProbabilistic = byAuthority.probabilistic > 0;
  return {
    schema: 'swipium.evidence.taxonomy.v1',
    counts,
    byAuthority,
    assessments,
    calibration: hasProbabilistic
      ? {
          status: 'required_missing',
          requiredCorpus: 'dogfood-nightly',
          note: 'Probabilistic visual/OCR/AI visual evidence requires confidence calibration in the dogfood corpus before it can be used as a release authority.',
        }
      : {
          status: 'not_required',
          note: 'No probabilistic visual/OCR/AI visual evidence was recorded in this report.',
        },
  };
}
