import { db } from '../db';
import { newId } from '@/engine/ids';
import type { CoursePlan, PlanReleaseMode, PlanUnit } from '@/engine/types';

export interface CreatePlanInput {
  courseId: string;
  title: string;
  material: string;
  materialTruncated?: boolean;
  releaseMode: PlanReleaseMode;
  /** Units in course order — levels are assigned 1..N here, never by the caller. */
  units: Omit<PlanUnit, 'level'>[];
}

/**
 * A plan's units map 1:1 onto the course's levels (unit 3 = level 3), so the
 * existing level engine — locking, lesson order, "unlocks at level N" — does
 * the progressive release without a second gating system.
 */
export async function createPlan(input: CreatePlanInput, now: number): Promise<CoursePlan> {
  if (input.units.length === 0) throw new Error('a plan needs at least one unit');
  const plan: CoursePlan = {
    id: newId(),
    courseId: input.courseId,
    title: input.title,
    material: input.material,
    materialTruncated: input.materialTruncated ?? false,
    releaseMode: input.releaseMode,
    units: input.units.map((u, i) => ({ ...u, level: i + 1 })),
    createdAt: now,
    updatedAt: now,
  };
  await db.plans.add(plan);
  return plan;
}

/** A course has at most one plan. */
export async function planForCourse(courseId: string): Promise<CoursePlan | undefined> {
  return db.plans.where('courseId').equals(courseId).first();
}

export async function updatePlan(plan: CoursePlan, now: number): Promise<void> {
  await db.plans.put({ ...plan, updatedAt: now });
}
