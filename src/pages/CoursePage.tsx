import { useLiveQuery } from 'dexie-react-hooks';
import { useParams, useSearchParams } from 'react-router';
import { db } from '@/db/db';
import { Button, ButtonLink, Panel, Status } from '@/components/ui';
import {
  useCourse,
  useCourseLadder,
  useDueCount,
  useLessonAvailability,
  usePendingReviewCount,
} from '@/hooks/useCourseData';
import { useNowTick } from '@/hooks/useNowTick';
import { useOperation } from '@/hooks/useOperation';
import { ItemsPanel } from '@/components/course/CourseItems';
import { AddItemForm } from '@/components/course/AddItemForm';
import { PlanPanel, ProgressPanel } from '@/components/course/CourseProgress';
import { CourseSettings, LadderEditor } from '@/components/course/CourseSettings';
import { ItemTypeDesigner } from '@/components/editor/ItemTypeDesigner';
import { ItemEditor } from '@/components/editor/ItemEditor';
import { GenerateItemsPanel } from '@/components/ai/GenerateItemsPanel';
import { downloadPackage, exportCoursePackage } from '@/packages/exportPackage';
import type { Course } from '@/engine/types';

function StudyActions({ course }: { course: Course }) {
  const t = useNowTick();
  const due = useDueCount(course.id, t);
  const lessons = useLessonAvailability(course.id, t);
  return (
    <Panel title="Study now">
      <div className="flex flex-wrap items-center gap-3">
        {due ? (
          <ButtonLink to={`/review/${course.id}`} variant="primary">
            Start reviews · {due}
          </ButtonLink>
        ) : (
          <p className="text-sm text-slate-400">
            {due === undefined ? 'Checking reviews…' : 'No reviews due right now.'}
          </p>
        )}
        {!!lessons?.available && (
          <ButtonLink to={`/lessons/${course.id}`}>New lessons · {lessons.available}</ButtonLink>
        )}
      </div>
      <p className="mt-3 text-sm text-slate-500">
        Reviews strengthen what you have learned. Lessons introduce new material at your course's
        pace.
      </p>
    </Panel>
  );
}

export default function CoursePage() {
  const { courseId } = useParams<{ courseId: string }>();
  const [search, setSearch] = useSearchParams();
  const itemId = search.get('item');
  const view = itemId ? 'items' : (search.get('view') ?? 'study');
  const selectedItem = useLiveQuery(() => (itemId ? db.items.get(itemId) : undefined), [itemId]);
  const course = useCourse(courseId);
  const ladder = useCourseLadder(course);
  const pending = usePendingReviewCount(courseId ?? '') ?? 0;
  const types = useLiveQuery(
    () => (courseId ? db.itemTypes.where('courseId').equals(courseId).toArray() : []),
    [courseId],
  );
  const operation = useOperation();
  if (course === null)
    return (
      <div className="space-y-4 py-12">
        <h1 className="text-xl">This course no longer exists.</h1>
        <ButtonLink to="/">Back to Today</ButtonLink>
      </div>
    );
  if (!course || !types)
    return (
      <p role="status" className="py-12 text-slate-400">
        Loading course…
      </p>
    );
  const selectedType =
    selectedItem && selectedItem.courseId === course.id
      ? types.find((t) => t.id === selectedItem.typeId)
      : undefined;
  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="break-words text-2xl font-semibold text-slate-100">{course.name}</h1>
          <p className="mt-1 max-w-2xl text-sm text-slate-400">{course.description}</p>
        </div>
        <Button
          onClick={() =>
            void operation.run(
              async () => downloadPackage(await exportCoursePackage(course.id)),
              'Package downloaded.',
            )
          }
          disabled={operation.busy}
        >
          Export course
        </Button>
      </header>
      <Status {...operation} />
      {selectedItem && selectedType && (
        <ItemEditor
          key={selectedItem.id}
          item={selectedItem}
          itemType={selectedType}
          course={course}
          ladder={ladder ?? null}
          onClose={() => setSearch({ view: 'items' })}
        />
      )}
      <nav className="workspace-tabs" aria-label="Course sections">
        {(['study', 'items', 'settings'] as const).map((id) => (
          <button
            key={id}
            aria-current={view === id ? 'page' : undefined}
            onClick={() => setSearch(id === 'study' ? {} : { view: id })}
          >
            {id === 'study' ? 'Study' : id === 'items' ? 'Items' : 'Course settings'}
          </button>
        ))}
        <ButtonLink to={`/plan/${course.id}`}>
          Plan & drafts{pending ? ` · ${pending}` : ''}
        </ButtonLink>
      </nav>
      {view === 'items' ? (
        <div className="space-y-5">
          <ItemsPanel course={course} types={types} ladder={ladder ?? null} />
          <AddItemForm key={course.id} course={course} types={types} />
          <details>
            <summary className="cursor-pointer py-2 text-sm font-medium text-violet-300">
              Generate items with AI
            </summary>
            <GenerateItemsPanel key={course.id} courseId={course.id} types={types} />
          </details>
        </div>
      ) : view === 'settings' ? (
        <div className="space-y-5">
          <CourseSettings key={course.id} course={course} types={types} />
          <ItemTypeDesigner course={course} types={types} />
          {ladder && <LadderEditor key={ladder.updatedAt} ladder={ladder} />}
        </div>
      ) : (
        <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)]">
          <div className="space-y-5">
            <StudyActions course={course} />
            <PlanPanel course={course} />
            <Panel title="Extra practice">
              <div className="flex flex-wrap gap-2">
                <ButtonLink to={`/cram/${course.id}?scope=learned`}>Everything learned</ButtonLink>
                <ButtonLink to={`/cram/${course.id}?scope=leeches`}>Repeated misses</ButtonLink>
                <ButtonLink to={`/cram/${course.id}?scope=misses`}>Missed this week</ButtonLink>
              </div>
              <p className="mt-3 text-sm text-slate-500">
                Practice leaves your review schedule unchanged.
              </p>
            </Panel>
          </div>
          <ProgressPanel course={course} ladder={ladder ?? null} types={types} />
        </div>
      )}
    </div>
  );
}
