// Domain types shared across the whole app. Pure types — no runtime imports.

// ---------- Fields & templates ----------

export type FieldKind =
  | 'text'
  | 'richtext'
  | 'image'
  | 'audio'
  | 'list'
  | 'clozeSentences'; // P5: [{text with ⟦blank⟧ markers, translation?, hint?}]

export interface ClozeSentence {
  text: string; // e.g. "私はりんご⟦を⟧食べる"
  translation?: string;
  hint?: string;
}

export interface FieldDef {
  id: string;
  name: string;
  kind: FieldKind;
}

export type GradingSpec =
  | { mode: 'typed'; answerLang: 'latin' | 'kana'; typoTolerance: boolean }
  | { mode: 'self' } // P5 (FSRS / reveal style)
  | { mode: 'choice'; choices: number } // P5
  | { mode: 'cloze' } // P5
  | { mode: 'sentenceCloze'; sentencesFieldId: string; rotation: 'random' | 'sequential' }; // P5

export interface CardTemplate {
  id: string;
  name: string; // "Meaning", "Reading", …
  promptFieldIds: string[];
  answerFieldId: string;
  hintFieldIds: string[]; // P5: progressive hints
  grading: GradingSpec;
}

export interface ItemType {
  id: string;
  courseId: string;
  name: string;
  color: string; // css color for the prompt header
  icon: string; // emoji
  fields: FieldDef[];
  templates: CardTemplate[];
  updatedAt: number;
}

// ---------- SRS ladders ----------

export interface SrsStage {
  id: string;
  name: string;
  intervalMinutes: number;
}

export interface SrsLadder {
  id: string;
  courseId: string | null; // null = preset template (copied on assignment)
  isPreset: boolean;
  name: string;
  stages: SrsStage[]; // ordered; cards reference stages by index
  passesAtIndex: number; // reaching this index = "passed" (Guru-equivalent)
  burnEnabled: boolean; // false → repeat the last interval forever
  updatedAt: number;
}

// ---------- Courses ----------

export type Scheduling =
  | { kind: 'ladder'; ladderId: string }
  | {
      kind: 'fsrs'; // P5
      params: { requestRetention: number; maximumIntervalDays: number; w?: number[] };
      passIntervalDays: number; // Guru-equivalent for gating
    };

export interface Course {
  id: string;
  name: string;
  description: string;
  scheduling: Scheduling;
  lessons: { newPerDay: number; batchSize: number };
  ghosts: 'off' | 'minimal' | 'on'; // P5, Bunpro-style
  answerStyle: 'perTemplate' | 'reveal'; // P5, Bunpro-style
  levelMode: 'levels' | 'flat';
  levelConfig?: {
    gateTypeIds: string[];
    passPercent: number;
    /** false = the level never advances on its own; a plan's manual/scheduled release owns it (P4). Default true. */
    autoAdvance?: boolean;
  }; // P2
  currentLevel: number;
  createdAt: number;
  updatedAt: number;
}

// ---------- Items & cards ----------

export type FieldValue = string | string[] | ClozeSentence[];

export type ItemStatus = 'locked' | 'lesson' | 'active';

export interface GuidanceAnswer {
  text: string;
  message: string; // shown on retry, e.g. "Almost — try the casual form"
}

export interface Item {
  id: string;
  courseId: string;
  typeId: string;
  level: number; // 1 in flat courses
  fieldValues: Record<string, FieldValue>; // keyed by FieldDef.id
  prereqIds: string[]; // DAG edges (multiEntry-indexed)
  status: ItemStatus;
  unlockedAt: number | null;
  passedAt: number | null; // sticky — stage drops never clear it
  synonyms: Record<string, string[]>; // templateId → extra accepted answers
  blockList: Record<string, string[]>; // templateId → never-accept answers
  guidance: Record<string, GuidanceAnswer[]>; // templateId → retry-with-message answers (P5)
  note: string; // personal note
  createdAt: number;
  updatedAt: number;
}

export type SrsState =
  | { kind: 'ladder'; stageIndex: number }
  | {
      kind: 'fsrs'; // P5; mirrors ts-fsrs Card with epoch-ms dates
      due: number;
      stability: number;
      difficulty: number;
      elapsed_days: number;
      scheduled_days: number;
      reps: number;
      lapses: number;
      state: 0 | 1 | 2 | 3;
      last_review?: number;
    };

export type CardLifecycle = 'new' | 'review' | 'burned' | 'suspended';

export interface CardStats {
  reviews: number;
  correct: number;
  lapses: number;
}

export interface Card {
  id: string;
  itemId: string;
  courseId: string; // denormalized for compound indexes
  templateId: string;
  state: CardLifecycle;
  isGhost?: boolean; // P5: ghost drill cards — invisible to gating
  parentCardId?: string;
  srs: SrsState | null; // null while 'new'
  dueAt?: number; // ONLY present when state === 'review' (hoisted for indexing)
  stats: CardStats;
  updatedAt: number;
}

// ---------- Review outcomes & logs ----------

export type ReviewOutcome =
  | { kind: 'ladder'; incorrectCount: number } // wrong tries before the final correct answer
  | { kind: 'fsrs'; rating: 1 | 2 | 3 | 4 }; // Again / Hard / Good / Easy

export interface CardSnapshot {
  state: CardLifecycle;
  srs: SrsState | null;
  dueAt?: number;
  stats: CardStats;
}

export interface ReviewLog {
  id: string;
  cardId: string;
  itemId: string;
  courseId: string;
  ts: number;
  sessionId: string;
  kind: 'review' | 'lesson' | 'migration' | 'manual';
  outcome?:
    | { kind: 'ladder'; incorrectCount: number; fromStage: number; toStage: number }
    | { kind: 'fsrs'; rating: 1 | 2 | 3 | 4; elapsedDays: number; scheduledDays: number };
  prev: CardSnapshot; // full snapshot → O(1) undo, auditability
  /** Enough card identity to resurrect a deleted ghost card on undo. */
  cardMeta?: { templateId: string; isGhost?: boolean; parentCardId?: string };
}

// ---------- Misc ----------

export interface MediaAsset {
  id: string;
  blob: Blob;
  mimeType: string;
  name: string;
  createdAt: number;
}

export interface MetaRow {
  key: string;
  value: unknown;
}

/** Quick-capture note — jotted in seconds, converted to a real item later. */
export interface Capture {
  id: string;
  text: string;
  createdAt: number;
}

// ---------- Course plans (P4: progressive AI courses) ----------

/**
 * How a plan releases its units. Units map 1:1 onto course levels, so
 * "release unit N" means "raise currentLevel to N".
 * - progress: the level engine advances when enough of the unit passes
 * - schedule: each unit carries a date; the level floor follows the calendar
 * - manual: only the "Release next unit" action moves it
 */
export type PlanReleaseMode = 'progress' | 'schedule' | 'manual';

export interface PlanUnit {
  level: number; // 1-based; equals the course level this unit occupies
  title: string;
  summary: string;
  topics: string[];
  targetCount: number; // suggested item count, drives generation
  releaseAt?: number; // epoch ms — schedule mode
  generatedAt?: number; // last AI generation for this unit
}

export interface CoursePlan {
  id: string;
  courseId: string;
  title: string;
  /** The pasted course material — kept so later units generate from the same source. */
  material: string;
  materialTruncated: boolean;
  releaseMode: PlanReleaseMode;
  units: PlanUnit[];
  createdAt: number;
  updatedAt: number;
}

/** An item awaiting review — structurally identical to PacketItem (packages/schema). */
export interface ProposalItem {
  type?: string;
  key?: string;
  prereqs?: string[];
  fields: Record<string, FieldValue>;
  synonyms?: string[] | Record<string, string[]>;
  note?: string;
  level?: number;
}

export type ProposalStatus = 'pending' | 'accepted' | 'rejected';
export type ProposalSource = 'ai' | 'mcp' | 'manual';

/**
 * The review queue row: an AI/MCP-drafted item that a human accepts, edits, or
 * rejects before it becomes a real item. Persisted so a generation is never
 * lost by closing a panel, and so rejections (with reasons) can steer the
 * next generation.
 */
export interface Proposal {
  id: string;
  courseId: string;
  planId: string | null;
  level: number; // the unit (level) the item would enter
  item: ProposalItem;
  source: ProposalSource;
  status: ProposalStatus;
  /** Why it can't be accepted as-is (dry-run against the course's types). */
  error: string | null;
  /** Existing item this looks like a duplicate of. */
  duplicateOf: string | null;
  rejectReason: string | null;
  acceptedItemId: string | null;
  createdAt: number;
  decidedAt: number | null;
  updatedAt: number;
}
