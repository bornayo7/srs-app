// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { db, ensurePresets } from '@/db/db';
import { createCourseWithType } from '@/services/contentCommands';
import { addProposals } from '@/db/repo/proposals';
import { acceptProposals } from '@/services/proposals';
import type { Course, CoursePlan, ItemType } from '@/engine/types';
import PlanPage from './PlanPage';

vi.mock('@/hooks/useAiReady', () => ({ useAiReady: () => false }));

let course: Course;
let type: ItemType;
beforeEach(async () => {
  await Promise.all(db.tables.map((table) => table.clear()));
  await ensurePresets();
  course = await createCourseWithType(
    { name: 'Coursework', ladderPresetId: 'preset-classic' },
    1000,
  );
  type = (await db.itemTypes.where('courseId').equals(course.id).toArray())[0];
});
afterEach(cleanup);

function renderPlan() {
  return render(
    <MemoryRouter initialEntries={[`/course/${course.id}/plan`]}>
      <Routes>
        <Route path="/course/:courseId/plan" element={<PlanPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

function plan(): CoursePlan {
  return {
    id: 'test-plan',
    courseId: course.id,
    title: 'Coursework plan',
    material: '',
    materialTruncated: false,
    releaseMode: 'schedule',
    createdAt: 1000,
    updatedAt: 1000,
    units: [
      {
        level: 1,
        title: 'First unit',
        summary: '',
        topics: [],
        targetCount: 10,
        releaseAt: Date.UTC(2099, 0, 1),
      },
    ],
  };
}

it('shows and accepts drafts in a course without a plan, then retains off-plan groups', async () => {
  const [proposal] = await addProposals(
    course.id,
    null,
    'manual',
    [
      {
        level: 3,
        item: {
          type: type.name,
          fields: Object.fromEntries(
            type.fields.map((field, i) => [
              field.name,
              i === 0 ? 'What is entropy?' : 'A measure of possible microstates',
            ]),
          ),
        },
        error: null,
        duplicateOf: null,
      },
    ],
    1000,
  );
  renderPlan();
  await screen.findByText('Level 3 drafts');
  expect(screen.getByText('What is entropy?')).toBeTruthy();
  expect(screen.getByText('A measure of possible microstates')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Accept' }));
  await waitFor(async () => expect((await db.proposals.get(proposal.id))?.status).toBe('accepted'));
  expect(await db.items.count()).toBe(1);
  await act(async () => {
    await db.plans.add(plan());
  });
  await screen.findByText('Outside the plan · level 3');
  expect(screen.getByRole('button', { name: 'Accepted · 1' })).toBeTruthy();
});

it('does not persist a release date until the explicit save action', async () => {
  const stored = plan();
  await db.plans.add(stored);
  renderPlan();
  const date = await screen.findByLabelText('Opens on');
  fireEvent.change(date, { target: { value: '2099-02-28' } });
  expect((await db.plans.get(stored.id))?.units[0].releaseAt).toBe(Date.UTC(2099, 0, 1));
  fireEvent.click(screen.getByRole('button', { name: 'Save date' }));
  await waitFor(async () =>
    expect((await db.plans.get(stored.id))?.units[0].releaseAt).toBe(Date.UTC(2099, 1, 28)),
  );
});

it.each(['Accept', 'Accept all valid'])(
  '%s rechecks a stale prerequisite hint and accepts the now-valid child without editing it',
  async (action) => {
    const rows = await addProposals(
      course.id,
      null,
      'manual',
      [
        {
          level: 1,
          item: {
            key: 'foundation',
            type: type.name,
            fields: { Front: 'Foundation', Back: 'Parent answer' },
          },
          error: null,
          duplicateOf: null,
        },
        {
          level: 1,
          item: {
            key: 'advanced',
            type: type.name,
            fields: { Front: 'Advanced', Back: 'Child answer' },
            prereqs: ['foundation'],
          },
          error: null,
          duplicateOf: null,
        },
      ],
      1000,
    );
    await acceptProposals([rows[1].id], 1001);
    expect((await db.proposals.get(rows[1].id))?.error).toContain("hasn't been accepted yet");
    await acceptProposals([rows[0].id], 1002);
    renderPlan();
    const button = await screen.findByRole('button', { name: action });
    expect((button as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(button);
    await waitFor(async () =>
      expect((await db.proposals.get(rows[1].id))?.status).toBe('accepted'),
    );
    const parent = await db.proposals.get(rows[0].id);
    const child = await db.proposals.get(rows[1].id);
    expect((await db.items.get(child!.acceptedItemId!))?.prereqIds).toEqual([
      parent!.acceptedItemId,
    ]);
    expect(await db.items.count()).toBe(2);
  },
);
