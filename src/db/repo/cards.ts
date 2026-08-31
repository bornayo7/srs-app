import { db } from '../db';
import type { Card } from '@/engine/types';

/** Cards due for review in a course (dueAt <= now). */
export async function dueCards(courseId: string, now: number): Promise<Card[]> {
  return db.cards
    .where('[courseId+state+dueAt]')
    .between([courseId, 'review', 0], [courseId, 'review', now], true, true)
    .toArray();
}

export async function dueCount(courseId: string, now: number): Promise<number> {
  return db.cards
    .where('[courseId+state+dueAt]')
    .between([courseId, 'review', 0], [courseId, 'review', now], true, true)
    .count();
}

/** All scheduled (review-state) cards of a course — forecast input. */
export async function scheduledCards(courseId: string): Promise<Card[]> {
  return db.cards
    .where('[courseId+state+dueAt]')
    .between([courseId, 'review', 0], [courseId, 'review', Infinity], true, true)
    .toArray();
}

export async function cardsForItem(itemId: string): Promise<Card[]> {
  return db.cards.where('itemId').equals(itemId).toArray();
}
