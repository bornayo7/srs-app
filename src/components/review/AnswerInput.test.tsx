// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { TypedInput } from './TypedInput';
import { ChoiceInput } from './ChoiceInput';
import { AnswerInput } from './AnswerInput';
import { useState } from 'react';
import userEvent from '@testing-library/user-event';
import { overrideFeedback, practiceFeedback, type Feedback, type SessionEntry } from '@/engine/question';

const choiceEntry: SessionEntry = {
  template: {
    id: 'recall', name: 'Recall', promptFieldIds: ['front'], answerFieldId: 'back',
    hintFieldIds: [], grading: { mode: 'choice', choices: 2 },
  },
  card: {
    id: 'card', generation: 'test', rev: 0, itemId: 'item', courseId: 'course',
    templateId: 'recall', state: 'new', srs: null,
    stats: { reviews: 0, correct: 0, lapses: 0 }, updatedAt: 0,
  },
  item: {
    id: 'item', generation: 'test', rev: 0, courseId: 'course', typeId: 'basic',
    level: 1, fieldValues: { front: 'Animal', back: 'cat' }, prereqIds: [],
    status: 'lesson', unlockedAt: 0, passedAt: null, synonyms: {}, blockList: {},
    guidance: {}, note: '', createdAt: 0, updatedAt: 0,
  },
  itemType: {
    id: 'basic', generation: 'test', rev: 0, courseId: 'course', name: 'Basic',
    color: '#8b5cf6', icon: '', templates: [], updatedAt: 0,
    fields: [{ id: 'front', name: 'Front', kind: 'text' }, { id: 'back', name: 'Back', kind: 'text' }],
  },
  choices: [{ text: 'cat', correct: true }, { text: 'dog', correct: false }],
};

function ChoiceAnswer({ onContinue, busy = false }: { onContinue: () => void; busy?: boolean }) {
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  return (
    <AnswerInput
      entry={choiceEntry}
      feedback={feedback}
      onSubmit={(text) => setFeedback(practiceFeedback(choiceEntry, text))}
      onOverride={(correct) => setFeedback(overrideFeedback(choiceEntry, correct))}
      onContinue={onContinue}
      busy={busy}
    />
  );
}

afterEach(cleanup);

describe('study input events', () => {
  it('keyboard overrides change either grade without advancing a choice question', async () => {
    const user = userEvent.setup();
    const next = vi.fn();
    render(<ChoiceAnswer onContinue={next} />);
    expect(screen.queryByRole('button', { name: /Mark (correct|wrong)/ })).toBeNull();
    await user.click(screen.getByRole('button', { name: /dog/ }));
    expect(screen.getByRole('status').textContent).toBe('Marked wrong');
    screen.getByRole('button', { name: 'Mark correct' }).focus();
    await user.keyboard('{Enter}');
    expect(screen.getByRole('status').textContent).toBe('Marked correct');
    expect(next).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Mark wrong' }));
    expect(screen.getByRole('status').textContent).toBe('Marked wrong');
    await user.click(screen.getByRole('button', { name: 'Continue (Enter)' }));
    expect(next).toHaveBeenCalledOnce();
  });

  it('saving disables both the override and Continue controls', () => {
    const next = vi.fn();
    const { rerender } = render(<ChoiceAnswer onContinue={next} />);
    fireEvent.click(screen.getByRole('button', { name: /cat/ }));
    rerender(<ChoiceAnswer onContinue={next} busy />);
    const override = screen.getByRole('button', { name: 'Mark wrong' });
    const continueButton = screen.getByRole('button', { name: 'Continue (Enter)' });
    expect((override as HTMLButtonElement).disabled).toBe(true);
    expect((continueButton as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(override);
    fireEvent.click(continueButton);
    fireEvent.keyDown(window, { key: 'Enter' });
    expect(screen.getByText('Marked correct')).toBeDefined();
    expect(next).not.toHaveBeenCalled();
  });

  it('held Enter or Space changes the grade only once', async () => {
    const user = userEvent.setup();
    const next = vi.fn();
    render(<ChoiceAnswer onContinue={next} />);
    await user.click(screen.getByRole('button', { name: /dog/ }));
    screen.getByRole('button', { name: 'Mark correct' }).focus();
    await user.keyboard('{Enter>4/}');
    expect(screen.getByRole('status').textContent).toBe('Marked correct');
    const override = screen.getByRole('button', { name: 'Mark wrong' });
    expect(fireEvent.keyDown(override, { key: ' ', repeat: true })).toBe(false);
    await user.keyboard('[Space>4/]');
    expect(screen.getByRole('status').textContent).toBe('Marked wrong');
    expect(next).not.toHaveBeenCalled();
  });

  it.each(['typed', 'choice'])('held Enter on %s Continue advances only once', async (mode) => {
    const user = userEvent.setup();
    const next = vi.fn();
    render(
      <AnswerInput
        entry={mode === 'choice' ? choiceEntry : { ...choiceEntry, choices: undefined }}
        feedback={overrideFeedback(choiceEntry, true)}
        onSubmit={vi.fn()}
        onContinue={next}
      />,
    );
    screen.getByRole('button', { name: 'Continue (Enter)' }).focus();
    await user.keyboard('{Enter>4/}');
    expect(next).toHaveBeenCalledOnce();
  });

  it('Enter still continues after selecting a now-disabled choice', async () => {
    const user = userEvent.setup();
    const next = vi.fn();
    render(<ChoiceAnswer onContinue={next} />);
    await user.click(screen.getByRole('button', { name: /dog/ }));
    await user.keyboard('{Enter}');
    expect(next).toHaveBeenCalledOnce();
  });

  it('native composition and held Enter never implicitly submit or advance', () => {
    const submit = vi.fn();
    const next = vi.fn();
    const { rerender } = render(
      <TypedInput feedback={null} onSubmit={submit} onContinue={next} answerLang="kana" />,
    );
    const input = screen.getByRole('textbox', { name: 'Your answer' });
    fireEvent.compositionStart(input);
    fireEvent.change(input, { target: { value: '漢字' } });
    expect(fireEvent.keyDown(input, { key: 'Enter', isComposing: true })).toBe(false);
    fireEvent.submit(input.closest('form')!);
    expect(submit).not.toHaveBeenCalled();
    fireEvent.compositionEnd(input);
    fireEvent.keyDown(input, { key: 'Enter', keyCode: 229 });
    expect(submit).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(submit).toHaveBeenCalledExactlyOnceWith('漢字');
    rerender(
      <TypedInput
        feedback={{ kind: 'correct', typo: false, toStage: 1, burned: false }}
        onSubmit={submit}
        onContinue={next}
      />,
    );
    expect(fireEvent.keyDown(input, { key: 'Enter', repeat: true })).toBe(false);
    expect(next).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(next).toHaveBeenCalledOnce();
  });

  it('busy typed inputs preserve the answer and prevent form or keyboard resubmission', () => {
    const submit = vi.fn();
    const next = vi.fn();
    const { rerender } = render(<TypedInput feedback={null} onSubmit={submit} onContinue={next} />);
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'answer' } });
    rerender(<TypedInput busy feedback={null} onSubmit={submit} onContinue={next} />);
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.submit(input.closest('form')!);
    expect(submit).not.toHaveBeenCalled();
    expect((input as HTMLInputElement).value).toBe('answer');
    expect((input as HTMLInputElement).readOnly).toBe(true);
  });

  it('choice save failures stay visible and can retry the same choice by Enter', () => {
    const options = [
      { text: 'ねこ', correct: true },
      { text: 'いぬ', correct: false },
    ];
    const submit = vi.fn();
    const next = vi.fn();
    const { rerender } = render(
      <ChoiceInput options={options} feedback={null} onSubmit={submit} onContinue={next} />,
    );
    fireEvent.click(screen.getByRole('button', { name: /ねこ/ }));
    rerender(
      <ChoiceInput options={options} feedback={null} busy onSubmit={submit} onContinue={next} />,
    );
    fireEvent.keyDown(window, { key: '2' });
    expect(submit).toHaveBeenCalledTimes(1);
    rerender(
      <ChoiceInput
        options={options}
        feedback={{ kind: 'retry', reason: 'save', message: 'Saving failed; retry.', nonce: 1 }}
        onSubmit={submit}
        onContinue={next}
      />,
    );
    expect(screen.getByRole('alert').textContent).toContain('Saving failed');
    fireEvent.keyDown(window, { key: 'Enter' });
    expect(submit).toHaveBeenLastCalledWith('ねこ');
    expect(submit).toHaveBeenCalledTimes(2);
    expect(next).not.toHaveBeenCalled();
  });
});
