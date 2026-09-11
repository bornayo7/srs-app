import { create } from 'zustand';
import {
  overrideFeedback,
  practiceFeedback,
  type Feedback,
  type QuestionProblem,
  type SessionEntry,
} from '@/engine/question';
import { prepareQuestions } from '@/services/questions';
import { studyRevision, StudyConflict } from '@/services/studyRevision';
import { mulberry32, orderEntries, reinsertIndex } from '@/engine/queue';
import { newId } from '@/engine/ids';
import { dueCards } from '@/db/repo/cards';
import { commitReview } from '@/services/commitReview';
import { undoReview } from '@/services/undo';
import { now } from '@/services/clock';
export interface CompletedReview {
  entry: SessionEntry;
  incorrectCount: number;
  fromStage: number | null;
  toStage: number | null;
  burned: boolean;
  logId: string;
  /** Prerequisite/level cascade this answer triggered. */
  itemPassed: boolean;
  unlockedCount: number;
  leveledUpTo: number | null;
}

interface SessionState {
  phase: 'idle' | 'loading' | 'active' | 'summary' | 'empty' | 'error';
  problems: QuestionProblem[];
  notice: string | null;
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
  overrideAnswer: (correct: boolean) => void;
  continueNext: () => Promise<void>;
  undo: () => Promise<void>;
  enterWrapUp: () => void;
  reset: () => void;
}

const rng = mulberry32(Date.now() & 0x7fffffff);

/**
 * Bumped by every start() and reset(). A load that is still awaiting the
 * database when a newer start/reset happens must drop its result. Otherwise
 * navigating from one course's reviews straight to another's could end with
 * the first course's cards on screen under the second course's URL.
 */
let loadGeneration = 0;

export const useSession = create<SessionState>((set, get) => ({
  phase: 'idle',
  problems: [],
  notice: null,
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
    const generation = ++loadGeneration;
    const stale = () => generation !== loadGeneration;
    set({
      phase: 'loading',
      courseId,
      sessionId: newId(),
      queue: [],
      completed: [],
      totalCards: 0,
      busy: false,
      feedback: null,
      lastCommit: null,
      incorrectCounts: {},
      wrapUp: false,
      problems: [],
      notice: null,
    });
    try {
      const cards = await dueCards(courseId, now());
      if (stale()) return;
      if (cards.length === 0) {
        set({ phase: 'empty', queue: [], totalCards: 0, completed: [] });
        return;
      }
      const sessionSeed = now() & 0x7fffffff;
      const { entries, problems } = await prepareQuestions(cards, sessionSeed);

      if (stale()) return;

      const sortable = entries.map((e) => ({
        ...e,
        itemId: e.item.id,
        typeId: e.itemType.id,
        level: e.item.level,
      }));
      const ordered = orderEntries(sortable, 'shuffle', now() & 0x7fffffff);

      set({
        phase: ordered.length ? 'active' : 'empty',
        problems,
        queue: ordered,
        totalCards: entries.length,
        completed: [],
        incorrectCounts: {},
        feedback: null,
        lastCommit: null,
        wrapUp: false,
      });
    } catch (err) {
      if (!stale())
        set({
          phase: 'error',
          notice: err instanceof Error ? err.message : 'Could not load this session.',
        });
    }
  },

  async submit(input) {
    const s = get();
    const entry = s.queue[0];
    if (
      s.phase !== 'active' ||
      !entry ||
      s.busy ||
      s.feedback?.kind === 'correct' ||
      s.feedback?.kind === 'incorrect'
    ) {
      return;
    }

    // The displayed result stays provisional until Continue. In particular, a
    // correct answer must not pass an item or unlock lessons before an override.
    set({ feedback: practiceFeedback(entry, input), notice: null });
  },

  overrideAnswer(correct) {
    const s = get();
    const entry = s.queue[0];
    if (
      s.phase !== 'active' ||
      !entry ||
      s.busy ||
      (s.feedback?.kind !== 'correct' && s.feedback?.kind !== 'incorrect')
    )
      return;
    set({
      feedback: overrideFeedback(entry, correct),
      notice: null,
    });
  },

  async continueNext() {
    const s = get();
    const [entry, ...rest] = s.queue;
    if (s.phase !== 'active' || !entry || s.busy || !s.feedback) return;
    if (s.feedback.kind === 'retry') {
      set({ feedback: null });
      return;
    }
    if (s.feedback.kind === 'incorrect') {
      // Only confirmed mistakes count. Changing this attempt back to correct
      // never removes mistakes that were already confirmed on earlier attempts.
      const idx = reinsertIndex(rest.length, rng);
      set({
        queue: [...rest.slice(0, idx), entry, ...rest.slice(idx)],
        incorrectCounts: {
          ...s.incorrectCounts,
          [entry.card.id]: (s.incorrectCounts[entry.card.id] ?? 0) + 1,
        },
        feedback: null,
        notice: null,
      });
      return;
    }

    // Commit the confirmed result once. Keep feedback while saving so a failed
    // save can retry Continue without re-grading the learner's override.
    set({ busy: true, notice: null });
    try {
      const incorrectCount = s.incorrectCounts[entry.card.id] ?? 0;
      let res;
      try {
        res = await commitReview({
          cardId: entry.card.id,
          sessionId: s.sessionId,
          outcome: { kind: 'ladder', incorrectCount },
          now: now(),
          expected: studyRevision(entry.card, entry.item, entry.itemType),
        });
      } catch (err) {
        // surface commit failures as a retryable notice instead of a silent hang
        if (get().sessionId === s.sessionId) {
          if (err instanceof StudyConflict) {
            const rest = get().queue.slice(1);
            set({
              queue: rest,
              feedback: null,
              totalCards: Math.max(0, get().totalCards - 1),
              phase: rest.length ? 'active' : get().completed.length ? 'summary' : 'empty',
              problems: [
                ...get().problems,
                { cardId: entry.card.id, itemId: entry.item.id, message: err.message },
              ],
            });
            return;
          }
          set({
            notice: `Couldn't save the answer (${(err instanceof Error ? err.message : String(err)).slice(0, 80)}). Continue again to retry.`,
          });
        }
        return;
      }
      const after = get();
      if (after.sessionId !== s.sessionId) return;
      const done: CompletedReview = {
        entry,
        incorrectCount,
        fromStage: res.fromStage,
        toStage: res.toStage,
        burned: res.burned,
        logId: res.logId,
        itemPassed: res.gating.itemPassed,
        unlockedCount: res.gating.unlockedItemIds.length,
        leveledUpTo: res.gating.leveledUpTo,
      };
      set({
        completed: [...after.completed, done],
        lastCommit: done,
        queue: after.queue.slice(1),
        feedback: null,
        phase: after.queue.length === 1 ? 'summary' : 'active',
      });
    } finally {
      if (get().sessionId === s.sessionId) set({ busy: false });
    }
  },

  async undo() {
    const s = get();
    if (s.busy) return; // never race an in-flight commit
    // Case 1: cancel the current provisional answer, leaving prior attempts.
    if (s.feedback) {
      set({ feedback: null, notice: null });
      return;
    }
    // Case 2: revert the last committed answer (single-step).
    if (!s.lastCommit) return;
    set({ busy: true });
    try {
      const restored = await undoReview(s.lastCommit.logId);
      const after = get();
      if (after.sessionId !== s.sessionId) return;
      if (!restored) {
        set({
          lastCommit: null,
          notice:
            'That change is no longer current and cannot be undone. Your newer progress was kept.',
        });
        return;
      }
      const { entry, incorrectCount } = s.lastCommit;
      const restoredEntry = { ...entry, card: restored };
      set({
        queue: [restoredEntry, ...after.queue],
        completed: after.completed.filter((c) => c.logId !== s.lastCommit!.logId),
        incorrectCounts: { ...after.incorrectCounts, [entry.card.id]: incorrectCount },
        feedback: null,
        lastCommit: null,
        phase: 'active',
      });
    } catch (err) {
      if (get().sessionId === s.sessionId)
        set({ notice: err instanceof Error ? err.message : 'Could not undo. Try again.' });
    } finally {
      if (get().sessionId === s.sessionId) set({ busy: false });
    }
  },

  enterWrapUp() {
    const s = get();
    if (s.phase !== 'active' || s.busy) return;
    const kept: SessionEntry[] = [];
    for (const e of s.queue) {
      const inProgress = (s.incorrectCounts[e.card.id] ?? 0) > 0;
      if (inProgress || kept.length < 10) kept.push(e);
    }
    // shrink the denominator so the progress bar reflects the truncated session
    set({
      queue: kept,
      wrapUp: true,
      totalCards: s.completed.length + kept.length,
    });
  },

  reset() {
    loadGeneration++; // an in-flight start() must not resurrect the session
    set({
      phase: 'idle',
      problems: [],
      notice: null,
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
