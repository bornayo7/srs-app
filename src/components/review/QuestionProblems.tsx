import { Link } from 'react-router';
import type { QuestionProblem } from '@/engine/question';

export function QuestionProblems({
  problems,
  courseId,
}: {
  problems: QuestionProblem[];
  courseId: string;
}) {
  if (!problems.length) return null;
  return (
    <div
      role="status"
      className="my-4 rounded-xl border border-amber-800 bg-amber-950/20 p-4 text-sm text-amber-200"
    >
      <p className="font-semibold">
        {problems.length} question{problems.length === 1 ? '' : 's'} need attention
      </p>
      <p className="mt-1">These questions were left unchanged and were not counted as completed.</p>
      <ul className="mt-2 space-y-2">
        {problems.map((p) => (
          <li key={p.cardId}>
            {p.message}{' '}
            <Link
              className="underline"
              to={`/course/${courseId}?item=${encodeURIComponent(p.itemId)}`}
            >
              Open item
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
