import { db } from '@/db/db';
import { planForCourse, updatePlan } from '@/db/repo/plans';
import { DEFAULT_PASS_PERCENT } from '@/engine/levels';
import type { Course, CoursePlan, PlanReleaseMode, PlanUnit } from '@/engine/types';
import { applyPacket } from '@/packages/importPacket';
import { PACKET_FORMAT, PACKET_VERSION, parsePacket } from '@/packages/schema';
import type { CoursePlanPacket, PacketItem } from '@/packages/schema';
import { recomputeUnlocks } from './gating';

/**
 * Course plans: a syllabus split into ordered units, each unit one course
 * level. Release is the only new mechanism — everything else (locking, lesson
 * order, "unlocks at level N") is the existing level engine.
 */

export interface PlannedCourseInput {
  name: string;
  description?: string;
  ladderPreset?: 'classic' | 'gentle' | 'bunpro';
  newPerDay?: number;
  batchSize?: number;
  passPercent?: number;
  releaseMode: PlanReleaseMode;
  itemTypes: CoursePlanPacket['itemTypes'];
  units: {
    title: string;
    summary?: string;
    topics?: string[];
    targetCount?: number;
    releaseAt?: number;
    items?: PacketItem[];
  }[];
  material: string;
  materialTruncated?: boolean;
}

/** In-app path (the AI planner): same packet, same import, source 'ai'. */
export async function createPlannedCourse(
  input: PlannedCourseInput,
  now: number,
): Promise<{ courseId: string; planId: string; proposalsAdded: number; warnings: string[] }> {
  const packet = parsePacket({
    format: PACKET_FORMAT,
    version: PACKET_VERSION,
    kind: 'course-plan',
    course: {
      name: input.name,
      description: input.description,
      ladderPreset: input.ladderPreset,
      newPerDay: input.newPerDay,
      batchSize: input.batchSize,
      passPercent: input.passPercent,
      releaseMode: input.releaseMode,
    },
    itemTypes: input.itemTypes,
    units: input.units,
    material: input.material,
  });
  const res = await applyPacket(packet, now, { source: 'ai' });
  const plan = await planForCourse(res.courseId);
  if (!plan) throw new Error('plan was not created');
  if (input.materialTruncated) await updatePlan({ ...plan, materialTruncated: true }, now);
  return {
    courseId: res.courseId,
    planId: plan.id,
    proposalsAdded: res.proposalsAdded,
    warnings: res.warnings,
  };
}

async function requirePlan(courseId: string): Promise<{ course: Course; plan: CoursePlan }> {
  const course = await db.courses.get(courseId);
  if (!course) throw new Error(`course not found: ${courseId}`);
  const plan = await planForCourse(courseId);
  if (!plan) throw new Error('this course has no plan');
  return { course, plan };
}

/**
 * Raise the course to `level` (never lowers, never past the last unit) and
 * open whatever that unlocks. Returns the new level, or null if nothing moved.
 */
export async function releaseUnit(
  courseId: string,
  level: number,
  now: number,
): Promise<number | null> {
  const { course, plan } = await requirePlan(courseId);
  const target = Math.min(Math.max(1, Math.floor(level)), plan.units.length);
  if (target <= course.currentLevel) return null;
  await db.courses.put({ ...course, currentLevel: target, updatedAt: now });
  await recomputeUnlocks(courseId, now);
  return target;
}

/** The manual-mode button. */
export async function releaseNextUnit(courseId: string, now: number): Promise<number | null> {
  const { course } = await requirePlan(courseId);
  return releaseUnit(courseId, course.currentLevel + 1, now);
}

/**
 * Schedule mode: the level floor follows the calendar. Cheap enough to run on
 * every app load. Returns the new level, or null if nothing was due.
 */
export async function syncScheduledRelease(courseId: string, now: number): Promise<number | null> {
  const plan = await planForCourse(courseId);
  if (!plan || plan.releaseMode !== 'schedule') return null;
  const due = plan.units.filter((u) => u.releaseAt !== undefined && u.releaseAt <= now);
  if (due.length === 0) return null;
  return releaseUnit(courseId, Math.max(...due.map((u) => u.level)), now);
}

export async function syncAllScheduledReleases(
  now: number,
): Promise<{ courseId: string; level: number }[]> {
  const out: { courseId: string; level: number }[] = [];
  for (const plan of await db.plans.toArray()) {
    if (plan.releaseMode !== 'schedule') continue;
    try {
      const level = await syncScheduledRelease(plan.courseId, now);
      if (level !== null) out.push({ courseId: plan.courseId, level });
    } catch {
      // one broken plan must not block the others (or startup)
    }
  }
  return out;
}

/**
 * Change who owns the level. progress hands it to the level engine (and
 * settles a threshold that may already be met); schedule and manual take it
 * back — schedule also catches up with the calendar immediately.
 */
export async function setReleaseMode(
  courseId: string,
  mode: PlanReleaseMode,
  now: number,
): Promise<void> {
  const { course, plan } = await requirePlan(courseId);
  await updatePlan({ ...plan, releaseMode: mode }, now);
  await db.courses.put({
    ...course,
    levelMode: 'levels',
    levelConfig: {
      gateTypeIds: course.levelConfig?.gateTypeIds ?? [],
      passPercent: course.levelConfig?.passPercent ?? DEFAULT_PASS_PERCENT,
      autoAdvance: mode === 'progress',
    },
    updatedAt: now,
  });
  if (mode === 'progress') await recomputeUnlocks(courseId, now);
  if (mode === 'schedule') await syncScheduledRelease(courseId, now);
}

export async function updateUnit(
  courseId: string,
  level: number,
  patch: Partial<Omit<PlanUnit, 'level'>>,
  now: number,
): Promise<PlanUnit> {
  const { plan } = await requirePlan(courseId);
  const idx = plan.units.findIndex((u) => u.level === level);
  if (idx < 0) throw new Error(`no unit at level ${level}`);
  const next: PlanUnit = { ...plan.units[idx], ...patch, level };
  if (patch.releaseAt === undefined && 'releaseAt' in patch) delete next.releaseAt;
  const units = plan.units.map((u, i) => (i === idx ? next : u));
  await updatePlan({ ...plan, units }, now);
  // a date edit may make a unit due right now
  if (plan.releaseMode === 'schedule') await syncScheduledRelease(courseId, now);
  return next;
}

/** Add a unit at the end — it becomes the next level. Reordering is not supported. */
export async function appendUnit(
  courseId: string,
  unit: Omit<PlanUnit, 'level'>,
  now: number,
): Promise<PlanUnit> {
  const { plan } = await requirePlan(courseId);
  const next: PlanUnit = { ...unit, level: plan.units.length + 1 };
  await updatePlan({ ...plan, units: [...plan.units, next] }, now);
  return next;
}

export interface UnitProgress {
  level: number;
  title: string;
  summary: string;
  topics: string[];
  targetCount: number;
  releaseAt?: number;
  generatedAt?: number;
  released: boolean;
  current: boolean;
  pending: number;
  accepted: number;
  rejected: number;
  /** Real items sitting at this level, and how many have passed. */
  items: number;
  passed: number;
}

export interface PlanProgress {
  plan: CoursePlan;
  course: Course;
  units: UnitProgress[];
  pendingTotal: number;
}

/** Everything the plan page needs in one read. */
export async function planProgress(courseId: string): Promise<PlanProgress | null> {
  const course = await db.courses.get(courseId);
  const plan = await planForCourse(courseId);
  if (!course || !plan) return null;
  const proposals = await db.proposals.where('courseId').equals(courseId).toArray();
  const items = await db.items.where('courseId').equals(courseId).toArray();

  const units = plan.units.map((u): UnitProgress => {
    const mine = proposals.filter((p) => p.level === u.level);
    const levelItems = items.filter((i) => i.level === u.level);
    return {
      ...u,
      released: u.level <= course.currentLevel,
      current: u.level === course.currentLevel,
      pending: mine.filter((p) => p.status === 'pending').length,
      accepted: mine.filter((p) => p.status === 'accepted').length,
      rejected: mine.filter((p) => p.status === 'rejected').length,
      items: levelItems.length,
      passed: levelItems.filter((i) => i.passedAt !== null).length,
    };
  });
  return {
    plan,
    course,
    units,
    pendingTotal: proposals.filter((p) => p.status === 'pending').length,
  };
}
