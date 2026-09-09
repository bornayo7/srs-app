// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { TypedInput } from './TypedInput';
import { ChoiceInput } from './ChoiceInput';

afterEach(cleanup);

describe('study input events', () => {
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
