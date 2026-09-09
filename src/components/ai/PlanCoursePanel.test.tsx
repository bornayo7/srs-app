// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { PlanCoursePanel } from './PlanCoursePanel';

const mocked = vi.hoisted(() => ({ plan: vi.fn() }));
vi.mock('@/hooks/useAiReady', () => ({ useAiReady: () => true }));
vi.mock('@/ai/plan', async (original) => ({
  ...(await original<typeof import('@/ai/plan')>()),
  planCourse: mocked.plan,
}));
beforeEach(() => {
  vi.clearAllMocks();
  mocked.plan.mockResolvedValue({
    material: 'My material',
    materialTruncated: false,
    outline: {
      courseName: 'Biology',
      description: 'A course',
      itemTypes: [
        {
          name: 'Term',
          icon: '',
          fields: [{ name: 'Term' }, { name: 'Meaning' }],
          templates: [
            { name: 'Recall', promptFields: ['Term'], answerField: 'Meaning', mode: 'typed' },
          ],
        },
      ],
      units: [{ title: 'Cells', summary: '', topics: [], targetCount: 5, date: '' }],
    },
  });
});
afterEach(cleanup);

it.each(['1.5', '-1', ''])(
  'rejects invalid daily lesson count %s before requesting a paid outline, then accepts its correction',
  async (value) => {
    render(
      <MemoryRouter>
        <PlanCoursePanel onDone={() => {}} />
      </MemoryRouter>,
    );
    fireEvent.change(screen.getByLabelText('Course material'), {
      target: { value: 'My material' },
    });
    fireEvent.change(screen.getByLabelText('New lessons / day'), { target: { value } });
    fireEvent.click(screen.getByRole('button', { name: 'Plan course' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('whole numbers'));
    expect(mocked.plan).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('New lessons / day'), { target: { value: '0' } });
    fireEvent.click(screen.getByRole('button', { name: 'Plan course' }));
    await waitFor(() => expect(mocked.plan).toHaveBeenCalledOnce());
    await waitFor(() => expect(screen.getByLabelText('Course name')).toBeTruthy());
  },
);

it('shows undated scheduled units before the learner creates the course', async () => {
  render(
    <MemoryRouter>
      <PlanCoursePanel onDone={() => {}} />
    </MemoryRouter>,
  );
  fireEvent.change(screen.getByLabelText('Course material'), { target: { value: 'My material' } });
  fireEvent.change(screen.getByLabelText('Release units'), { target: { value: 'schedule' } });
  fireEvent.click(screen.getByRole('button', { name: 'Plan course' }));
  await waitFor(() =>
    expect(screen.getByRole('status').textContent).toContain(
      'Units without an opening date stay closed',
    ),
  );
});
