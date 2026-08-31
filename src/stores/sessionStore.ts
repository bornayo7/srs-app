import { create } from 'zustand';
import type { Card, CardTemplate, Item, ItemType } from '@/engine/types';
import { matchTypedAnswer, type MatchVerdict } from '@/engine/grading/match';
import { buildMatchContext } from '@/engine/grading/context';
import { mulberry32, orderEntries, reinsertIndex } from '@/engine/queue';
import { newId } from '@/engine/ids';
import { db } from '@/db/db';
import { dueCards } from '@/db/repo/cards';
import { commitReview } from '@/services/commitReview';
import { undoReview } from '@/services/undo';
import { now } from '@/services/clock';

export interface SessionEntry {
  card: Card; // snapshot at session load
  item: Item;
  itemType: ItemType;
  template: CardTemplate;
}

export interface CompletedReview {
  entry: SessionEntry;
  incorrectCount: number;
  fromStage: number | null;
  toStage: number | null;
  burned: boolean;
  logId: string;
}

export type Feedback =
  | { kind: 'correct'; typo: boolean; toStage: number | null; burned: boolean }
  | { kind: 'incorrect'; accepted: string[] }
  | { kind: 'retry'; reason: string; message?: string; nonce: number };

interface SessionState {
  phase: 'idle' | 'loading' | 'active' | 'summary' | 'empty';
  courseId: string | null;
  sessionId: string;
  queue: SessionEntry[];
  totalCards: number;
  completed: CompletedReview[];
  incorrectCounts: Record<string, number>;
  feedback: Feedback | null;
  lastCommit: CompletedReview | null;
  wrapUp: boolean;
  /** true while a commit/undo transaction is in flight — gates re-entry. */
  busy: boolean;

  start: (courseId: string) => Promise<void>;
  submit: (input: string) => Promise<void>;
  continueNext: () => void;
  undo: () => Promise<void>;
  enterWrapUp: () => void;
  reset: () => void;
}

const rng = mulberry32(Date.now() & 0x7fffffff);

export const useSession = create<SessionState>((set, get) => ({
  phase: 'idle',
  courseId: null,
  sessionId: '',
  queue: [],
  totalCards: 0,
  completed: [],
  incorrectCounts: {},
  feedback: null,
  lastCommit: null,
  wrapUp: false,
  busy: false,

  async start(courseId) {
    set({ phase: 'loading', courseId });
    const cards = await dueCards(courseId, now());
    if (cards.length === 0) {
      set({ phase: 'empty', queue: [], totalCards: 0, completed: [] });
      return;
    }
    const items = new Map(
      (await db.items.bulkGet([...new Set(cards.map((c) => c.itemId))]))
        .filter((i): i is Item => !!i)
        .map((i) => [i.id, i]),
    );
    const types = new Map(
      (await db.itemTypes.bulkGet([...new Set([...items.values()].map((i) => i.typeId))]))
        .filter((t): t is ItemType => !!t)
        .map((t) => [t.id, t]),
    );

    const entries: SessionEntry[] = [];
    for (const card of cards) {
      const item = items.get(card.itemId);
      const itemType = item && types.get(item.typeId);
      const template = itemType?.templates.find((t) => t.id === card.templateId);
      if (item && itemType && template) entries.push({ card, item, itemType, template });
    }

    const sortable = entries.map((e) => ({
      ...e,
      itemId: e.item.id,
      typeId: e.itemType.id,
      level: e.item.level,
    }));
    const ordered = orderEntries(sortable, 'shuffle', now() & 0x7fffffff);

    set({
      phase: 'active',
      sessionId: newId(),
      queue: ordered,
      totalCards: entries.length,
      completed: [],
      incorrectCounts: {},
      feedback: null,
      lastCommit: null,
      wrapUp: false,
    });
  },

  async submit(input) {
    const s = get();
    const entry = s.queue[0];
    if (!entry || s.busy || s.feedback?.kind === 'correct' || s.feedback?.kind === 'incorrect') {
      return;
    }

    const ctx = buildMatchContext(entry.item, entry.itemType, entry.template);
    const verdict: MatchVerdict = matchTypedAnswer(input, ctx);

    if (verdict.verdict === 'retry') {
      set({
        feedback: {
          kind: 'retry',
          reason: verdict.reason,
          message: verdict.message,
          nonce: Date.now(),
        },
      });
      return;
    }

    if (verdict.verdict === 'incorrect') {
      set({
        incorrectCounts: {
          ...s.incorrectCounts,
          [entry.card.id]: (s.incorrectCounts[entry.card.id] ?? 0) + 1,
        },
        feedback: { kind: 'incorrect', accepted: ctx.accepted },
      });
      return;
    }

    // correct or correctWithTypo → commit with the accumulated wrong tries.
    // busy gates double-Enter (a second submit during the transaction would
    // otherwise commit the same card twice); the sessionId check discards the
    // continuation if the session was reset/replaced while awaiting.
    set({ busy: true });
    try {
      const incorrectCount = s.incorrectCounts[entry.card.id] ?? 0;
      const res = await commitReview({
        cardId: entry.card.id,
        sessionId: s.sessionId,
        outcome: { kind: 'ladder', incorrectCount },
        now: now(),
      });
      const after = get();
      if (after.sessionId !== s.sessionId) return;
      const done: CompletedReview = {
        entry,
        incorrectCount,
        fromStage: res.fromStage,
        toStage: res.toStage,
        burned: res.burned,
        logId: res.logId,
      };
      set({
        completed: [...after.completed, done],
        lastCommit: done,
        feedback: {
          kind: 'correct',
          typo: verdict.verdict === 'correctWithTypo',
          toStage: res.toStage,
          burned: res.burned,
        },
      });
    } finally {
      if (get().sessionId === s.sessionId) set({ busy: false });
    }
  },

  continueNext() {
    const s = get();
    if (!s.feedback) return;
    if (s.feedback.kind === 'retry') {
      set({ feedback: null });
      return;
    }
    const [current, ...rest] = s.queue;
    if (s.feedback.kind === 'correct') {
      set({
        queue: rest,
        feedback: null,
        phase: rest.length === 0 ? 'summary' : 'active',
      });
      return;
    }
    // incorrect → reinsert 4–8 ahead and ask again later
    const idx = reinsertIndex(rest.length, rng);
    const requeued = [...rest.slice(0, idx), current, ...rest.slice(idx)];
    set({ queue: requeued, feedback: null });
  },

  async undo() {
    const s = get();
    if (s.busy) return; // never race an in-flight commit
    // Case 1: a wrong answer is on screen but not yet committed — cancel the mark.
    if (s.feedback?.kind === 'incorrect') {
      const entry = s.queue[0];
      const counts = { ...s.incorrectCounts };
      if (entry) counts[entry.card.id] = Math.max(0, (counts[entry.card.id] ?? 0) - 1);
      set({ incorrectCounts: counts, feedback: null });
      return;
    }
    // Case 2: revert the last committed answer (single-step).
    if (!s.lastCommit) return;
    set({ busy: true });
    try {
      const restored = await undoReview(s.lastCommit.logId);
      const after = get();
      if (after.sessionId !== s.sessionId) return;
      if (!restored) return;
      const { entry, incorrectCount } = s.lastCommit;
      const stillQueued = after.feedback?.kind === 'correct'; // haven't advanced yet
      set({
        queue: stillQueued ? after.queue : [entry, ...after.queue],
        completed: after.completed.filter((c) => c.logId !== s.lastCommit!.logId),
        incorrectCounts: { ...after.incorrectCounts, [entry.card.id]: incorrectCount },
        feedback: null,
        lastCommit: null,
        phase: 'active',
      });
    } finally {
      if (get().sessionId === s.sessionId) set({ busy: false });
    }
  },

  enterWrapUp() {
    const s = get();
    if (s.phase !== 'active') return;
    const kept: SessionEntry[] = [];
    for (const e of s.queue) {
      const inProgress = (s.incorrectCounts[e.card.id] ?? 0) > 0;
      if (inProgress || kept.length < 10) kept.push(e);
    }
    // shrink the denominator so the progress bar reflects the truncated session
    set({ queue: kept, wrapUp: true, totalCards: s.completed.length + kept.length });
  },

  reset() {
    set({
      phase: 'idle',
      courseId: null,
      sessionId: '',
      queue: [],
      totalCards: 0,
      completed: [],
      incorrectCounts: {},
      feedback: null,
      lastCommit: null,
      wrapUp: false,
      busy: false,
    });
  },
}));
