// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router';
import { db, ensurePresets } from '@/db/db';
import { createCourse } from '@/db/repo/courses';
import { createItem } from '@/db/repo/items';
import { basicTypeSpec, createItemType } from '@/db/repo/itemTypes';
import { completeLessonBatch, lessonAvailability, nextLessonBatch } from '@/services/lessons';
import { teachItems } from '@/test/study';
import LessonPage from './LessonPage';
import CramPage from './CramPage';

vi.mock('@/services/lessons', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/services/lessons')>();
  return {
    ...real,
    nextLessonBatch: vi.fn(real.nextLessonBatch),
    completeLessonBatch: vi.fn(real.completeLessonBatch),
    lessonAvailability: vi.fn(real.lessonAvailability),
  };
});

const NOW = new Date(2026, 8, 8, 10).getTime();
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { resolve, promise };
}
async function seed(name: string, count = 1) {
  const course = await createCourse({ name, ladderPresetId: 'preset-classic', batchSize: 1 }, NOW);
  const spec = basicTypeSpec();
  spec.fields[0].kind = 'richtext';
  const type = await createItemType(course.id, spec, NOW);
  const items = [];
  for (let i = 0; i < count; i++)
    items.push(
      await createItem(
        {
          courseId: course.id,
          typeId: type.id,
          fieldValues: {
            [type.fields[0].id]: `**${name} prompt ${i}**`,
            [type.fields[1].id]: `answer${i}`,
          },
        },
        NOW + i,
      ),
    );
  return { course, items };
}
function Move({ to }: { to: string }) {
  const navigate = useNavigate();
  return <button onClick={() => navigate(to)}>Switch course</button>;
}
function submit(text: string) {
  const input = screen.getByRole('textbox', { name: 'Your answer' });
  fireEvent.change(input, { target: { value: text } });
  fireEvent.keyDown(input, { key: 'Enter' });
}
function next() {
  fireEvent.keyDown(screen.getByRole('textbox', { name: 'Your answer' }), { key: 'Enter' });
}

beforeEach(async () => {
  const real = await vi.importActual<typeof import('@/services/lessons')>('@/services/lessons');
  vi.mocked(nextLessonBatch).mockReset().mockImplementation(real.nextLessonBatch);
  vi.mocked(completeLessonBatch).mockReset().mockImplementation(real.completeLessonBatch);
  vi.mocked(lessonAvailability).mockReset().mockImplementation(real.lessonAvailability);
  await Promise.all(db.tables.map((t) => t.clear()));
  await ensurePresets();
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('study-page continuations', () => {
  it('lesson overrides control retries and keep activation provisional until Continue', async () => {
    const { course } = await seed('Override lesson');
    render(
      <MemoryRouter initialEntries={[`/lesson/${course.id}`]}>
        <Routes>
          <Route path="/lesson/:courseId" element={<LessonPage />} />
        </Routes>
      </MemoryRouter>,
    );
    await screen.findByText('Override lesson prompt 0');
    fireEvent.click(screen.getByRole('button', { name: 'Quiz the batch' }));
    submit('answer0');
    fireEvent.click(screen.getByRole('button', { name: 'Mark wrong' }));
    expect(screen.getByText('Marked wrong')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Continue (Enter)' }));
    expect((screen.getByRole('textbox') as HTMLInputElement).readOnly).toBe(false);
    expect(await db.reviewLogs.count()).toBe(0);
    expect((await db.cards.toArray())[0].state).toBe('new');
    submit('another phrasing');
    fireEvent.click(screen.getByRole('button', { name: 'Mark correct' }));
    expect(await db.reviewLogs.count()).toBe(0);
    fireEvent.click(screen.getByRole('button', { name: 'Continue (Enter)' }));
    await screen.findByText('Batch complete');
    expect(await db.reviewLogs.count()).toBe(1);
    expect((await db.cards.toArray())[0].state).toBe('review');
  });

  it('cram only counts the final confirmed grade and never changes scheduling', async () => {
    const { course, items } = await seed('Override cram');
    await teachItems([items[0].id], 'lesson', NOW);
    const before = await db.cards.toArray();
    const logs = await db.reviewLogs.toArray();
    render(
      <MemoryRouter initialEntries={[`/cram/${course.id}`]}>
        <Routes>
          <Route path="/cram/:courseId" element={<CramPage />} />
        </Routes>
      </MemoryRouter>,
    );
    await screen.findByText('Override cram prompt 0');
    submit('another phrasing');
    fireEvent.click(screen.getByRole('button', { name: 'Mark correct' }));
    fireEvent.click(screen.getByRole('button', { name: 'Continue (Enter)' }));
    expect(screen.getByText(/Crammed 1 card — 0 needed retries/)).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Again' }));
    await screen.findByText('Override cram prompt 0');
    submit('answer0');
    fireEvent.click(screen.getByRole('button', { name: 'Mark wrong' }));
    fireEvent.click(screen.getByRole('button', { name: 'Continue (Enter)' }));
    submit('another phrasing');
    fireEvent.click(screen.getByRole('button', { name: 'Mark correct' }));
    fireEvent.click(screen.getByRole('button', { name: 'Continue (Enter)' }));
    expect(screen.getByText(/Crammed 1 card — 1 needed retries/)).toBeDefined();
    expect(await db.cards.toArray()).toEqual(before);
    expect(await db.reviewLogs.toArray()).toEqual(logs);
  });

  it('late lesson loading cannot replace the newly selected course', async () => {
    const a = await seed('Old');
    const b = await seed('New');
    const release = deferred<typeof a.items>();
    vi.mocked(nextLessonBatch).mockImplementationOnce(() => release.promise);
    render(
      <MemoryRouter initialEntries={[`/lesson/${a.course.id}`]}>
        <Move to={`/lesson/${b.course.id}`} />
        <Routes>
          <Route path="/lesson/:courseId" element={<LessonPage />} />
        </Routes>
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Switch course' }));
    await screen.findByText('New prompt 0');
    await act(async () => {
      release.resolve(a.items);
      await release.promise;
    });
    expect(screen.queryByText('Old prompt 0')).toBeNull();
    expect(screen.getByText('New prompt 0').tagName).toBe('STRONG');
  });

  it('rapid final Enter commits once, and a fresh batch starts at the next item', async () => {
    const { course, items } = await seed('Batch', 2);
    const saved = deferred<void>();
    const release = deferred<void>();
    const real = vi.mocked(completeLessonBatch).getMockImplementation()!;
    vi.mocked(completeLessonBatch).mockImplementationOnce(async (...args) => {
      await real(...args);
      saved.resolve();
      await release.promise;
    });
    render(
      <MemoryRouter initialEntries={[`/lesson/${course.id}`]}>
        <Routes>
          <Route path="/lesson/:courseId" element={<LessonPage />} />
        </Routes>
      </MemoryRouter>,
    );
    await screen.findByText('Batch prompt 0');
    fireEvent.click(screen.getByRole('button', { name: 'Quiz the batch' }));
    submit('answer0');
    next();
    next();
    await saved.promise;
    expect(await db.reviewLogs.count()).toBe(1);
    expect((screen.getByRole('button', { name: 'Mark wrong' }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => {
      release.resolve();
      await release.promise;
    });
    await screen.findByText('Batch complete');
    fireEvent.click(await screen.findByRole('button', { name: /Next batch/ }));
    await screen.findByText('Batch prompt 1');
    expect(screen.queryByText('Batch prompt 0')).toBeNull();
    expect((await db.cards.where('itemId').equals(items[1].id).first())!.state).toBe('new');
  });

  it('a saved batch remains complete when the next-allowance refresh fails', async () => {
    const { course } = await seed('Refresh');
    vi.mocked(lessonAvailability).mockRejectedValueOnce(new Error('Read failed'));
    render(
      <MemoryRouter initialEntries={[`/lesson/${course.id}`]}>
        <Routes>
          <Route path="/lesson/:courseId" element={<LessonPage />} />
        </Routes>
      </MemoryRouter>,
    );
    await screen.findByText('Refresh prompt 0');
    fireEvent.click(screen.getByRole('button', { name: 'Quiz the batch' }));
    submit('answer0');
    next();
    await screen.findByText('Batch complete');
    expect(await screen.findByText(/Your batch was saved/)).toBeDefined();
    expect(await db.reviewLogs.count()).toBe(1);
  });

  it('cram counts a repeatedly missed card once and preserves scheduling', async () => {
    const { course, items } = await seed('Cram');
    await teachItems([items[0].id], 'lesson', NOW);
    const before = await db.cards.toArray();
    const logs = await db.reviewLogs.toArray();
    render(
      <MemoryRouter initialEntries={[`/cram/${course.id}`]}>
        <Routes>
          <Route path="/cram/:courseId" element={<CramPage />} />
        </Routes>
      </MemoryRouter>,
    );
    await screen.findByText('Cram prompt 0');
    submit('wrong');
    next();
    submit('wrong again');
    next();
    submit('answer0');
    next();
    await waitFor(() =>
      expect(screen.getByText(/Crammed 1 card — 1 needed retries/)).toBeDefined(),
    );
    expect(await db.cards.toArray()).toEqual(before);
    expect(await db.reviewLogs.toArray()).toEqual(logs);
  });
});
