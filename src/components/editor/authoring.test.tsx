// @vitest-environment jsdom
import { useState } from 'react';
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db, ensurePresets } from '@/db/db';
import { createCourseWithType } from '@/services/contentCommands';
import { createItem } from '@/db/repo/items';
import type { Course, ItemType, MediaAsset } from '@/engine/types';
import { AddItemForm } from '@/components/course/AddItemForm';
import { Button, Field } from '@/components/ui';
import { ItemEditor } from './ItemEditor';
import { FieldValueInput } from './FieldValueInput';
import { useFieldDraft } from './useFieldDraft';
import { useMediaUrl } from '@/hooks/useMediaUrl';

const mocked = vi.hoisted(() => ({ mnemonic: vi.fn(), image: vi.fn(), url: vi.fn() }));
vi.mock('@/ai/generate', () => ({ generateMnemonicForContent: mocked.mnemonic }));
vi.mock('@/hooks/useAiReady', () => ({ useAiReady: () => true }));
vi.mock('@/services/media', async (original) => ({
  ...(await original<typeof import('@/services/media')>()),
  ingestImage: mocked.image,
  mediaUrl: mocked.url,
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

let course: Course;
beforeEach(async () => {
  vi.clearAllMocks();
  mocked.url.mockResolvedValue(null);
  let urlSequence = 0;
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    value: vi.fn(() => `blob:${++urlSequence}`),
  });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
  await Promise.all(db.tables.map((table) => table.clear()));
  await ensurePresets();
  course = await createCourseWithType(
    { name: 'Study fixture', ladderPresetId: 'preset-classic' },
    1000,
  );
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute('open');
  };
});
afterEach(cleanup);

function clozeType(): ItemType {
  return {
    rev: 0,
    generation: 'legacy',
    id: 'cloze-type',
    courseId: course.id,
    name: 'Cloze type',
    color: '#175f60',
    icon: '',
    updatedAt: 1000,
    fields: [
      { id: 'prompt', name: 'Prompt', kind: 'text' },
      { id: 'a', name: 'Sentence A', kind: 'clozeSentences' },
      { id: 'b', name: 'Sentence B', kind: 'clozeSentences' },
    ],
    templates: [
      {
        id: 'cloze-card',
        name: 'Recall',
        promptFieldIds: ['prompt'],
        answerFieldId: 'a',
        hintFieldIds: [],
        grading: { mode: 'sentenceCloze', sentencesFieldId: 'a', rotation: 'random' },
      },
    ],
  };
}

describe('draft integrity through the authoring interface', () => {
  it('blocks an invalid-after-valid sentence even when a second field becomes valid, then saves the correction', async () => {
    const type = clozeType();
    await db.itemTypes.add(type);
    render(<AddItemForm course={course} types={[type]} />);
    fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'A preposition' } });
    fireEvent.change(screen.getByLabelText('Sentence A'), { target: { value: 'Meet ⟦at⟧ noon.' } });
    fireEvent.change(screen.getByLabelText('Sentence A'), { target: { value: 'Meet at noon.' } });
    fireEvent.change(screen.getByLabelText('Sentence B'), { target: { value: 'Wait ⟦at⟧ home.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add item' }));
    await waitFor(() => expect(screen.getAllByRole('alert').length).toBeGreaterThan(0));
    expect(await db.items.count()).toBe(0);
    expect((screen.getByLabelText('Sentence A') as HTMLTextAreaElement).value).toBe(
      'Meet at noon.',
    );
    fireEvent.change(screen.getByLabelText('Sentence A'), {
      target: { value: 'Meet ⟦after⟧ lunch.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add item' }));
    await waitFor(async () => expect(await db.items.count()).toBe(1));
    expect((await db.items.toArray())[0].fieldValues.a).toEqual([{ text: 'Meet ⟦after⟧ lunch.' }]);
  });

  it('allows a required text field to be corrected after submission validation', async () => {
    const type = (await db.itemTypes.where('courseId').equals(course.id).toArray())[0];
    render(<AddItemForm course={course} types={[type]} />);
    fireEvent.click(screen.getByRole('button', { name: 'Add item' }));
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    for (const field of type.fields)
      fireEvent.change(screen.getByLabelText(field.name), {
        target: { value: `${field.name} value` },
      });
    fireEvent.click(screen.getByRole('button', { name: 'Add item' }));
    await waitFor(async () => expect(await db.items.count()).toBe(1));
  });

  function MediaDraft({ type }: { type: ItemType }) {
    const draft = useFieldDraft(type);
    const [saved, setSaved] = useState('');
    return (
      <>
        <div key={draft.generation}>
          {type.fields.map((field) => (
            <Field key={field.id} label={field.name}>
              <FieldValueInput {...draft.fieldProps(field)} />
            </Field>
          ))}
        </div>
        <Button disabled={draft.busy} onClick={() => setSaved(JSON.stringify(draft.validate()))}>
          Save draft
        </Button>
        <Button onClick={() => draft.reset()}>Reset draft</Button>
        <output>{saved}</output>
      </>
    );
  }

  async function mediaType() {
    const basic = (await db.itemTypes.where('courseId').equals(course.id).toArray())[0];
    return {
      ...basic,
      fields: [...basic.fields, { id: 'picture', name: 'Picture', kind: 'image' as const }],
    };
  }

  it('preserves text edited while an attachment resolves and prevents saving mid-upload', async () => {
    const type = await mediaType();
    const request = deferred<MediaAsset>();
    mocked.image.mockReturnValue(request.promise);
    render(<MediaDraft type={type} />);
    for (const field of type.fields.filter((f) => f.kind === 'text'))
      fireEvent.change(screen.getByLabelText(field.name), { target: { value: 'original' } });
    fireEvent.change(screen.getByLabelText('Picture'), {
      target: { files: [new File(['image'], 'image.png', { type: 'image/png' })] },
    });
    expect((screen.getByRole('button', { name: 'Save draft' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    fireEvent.change(screen.getByLabelText(type.fields[0].name), {
      target: { value: 'edited during upload' },
    });
    await act(async () =>
      request.resolve({
        id: 'media-result',
        blob: new Blob(),
        name: 'image.png',
        mimeType: 'image/png',
        createdAt: 1000,
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    const result = JSON.parse(screen.getByRole('status').textContent ?? '{}');
    expect(result[type.fields[0].id]).toBe('edited during upload');
    expect(result.picture).toBe('media-result');
  });

  it('ignores completion from the previous draft after reset', async () => {
    const type = await mediaType();
    const request = deferred<MediaAsset>();
    mocked.image.mockReturnValue(request.promise);
    render(<MediaDraft type={type} />);
    fireEvent.change(screen.getByLabelText('Picture'), {
      target: { files: [new File(['image'], 'image.png', { type: 'image/png' })] },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Reset draft' }));
    await act(async () =>
      request.resolve({
        id: 'previous-media',
        blob: new Blob(),
        name: 'image.png',
        mimeType: 'image/png',
        createdAt: 1000,
      }),
    );
    expect(screen.queryByRole('button', { name: 'Replace image' })).toBeNull();
    expect((screen.getByRole('button', { name: 'Save draft' }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  });

  it('lets a failed optional attachment be dismissed without losing the rest of the draft', async () => {
    const type = await mediaType();
    mocked.image.mockRejectedValue(new Error('This image could not be decoded.'));
    render(<MediaDraft type={type} />);
    for (const field of type.fields.filter((f) => f.kind === 'text'))
      fireEvent.change(screen.getByLabelText(field.name), { target: { value: 'Keep my writing' } });
    fireEvent.change(screen.getByLabelText('Picture'), {
      target: { files: [new File(['broken'], 'broken.png', { type: 'image/png' })] },
    });
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toContain('could not be decoded'),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Continue without attachment' }));
    expect(screen.queryByRole('alert')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    const result = JSON.parse(screen.getByRole('status').textContent ?? '{}');
    expect(result[type.fields[0].id]).toBe('Keep my writing');
    expect(result.picture).toBeUndefined();
  });

  it('retries a failed replacement and can retain the previously selected attachment', async () => {
    const type = await mediaType();
    mocked.image
      .mockResolvedValueOnce({ id: 'existing-image' })
      .mockRejectedValueOnce(new Error('Replacement failed.'))
      .mockResolvedValueOnce({ id: 'retry-image' });
    render(<MediaDraft type={type} />);
    for (const field of type.fields.filter((f) => f.kind === 'text'))
      fireEvent.change(screen.getByLabelText(field.name), { target: { value: 'Keep my writing' } });
    const upload = () =>
      fireEvent.change(screen.getByLabelText('Picture'), {
        target: { files: [new File(['image'], 'image.png', { type: 'image/png' })] },
      });
    upload();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Replace image' })).toBeTruthy());
    upload();
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toContain('Replacement failed'),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Keep current attachment' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    expect(JSON.parse(screen.getByRole('status').textContent ?? '{}').picture).toBe(
      'existing-image',
    );
    upload();
    await waitFor(() =>
      expect(
        (screen.getByRole('button', { name: 'Save draft' }) as HTMLButtonElement).disabled,
      ).toBe(false),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    expect(JSON.parse(screen.getByRole('status').textContent ?? '{}').picture).toBe('retry-image');
  });

  it('keeps content edited during mnemonic generation and restores dialog focus', async () => {
    const type = (await db.itemTypes.where('courseId').equals(course.id).toArray())[0];
    const item = await createItem(
      {
        courseId: course.id,
        typeId: type.id,
        fieldValues: Object.fromEntries(type.fields.map((field) => [field.id, 'original'])),
      },
      1000,
    );
    const request = deferred<string>();
    mocked.mnemonic.mockReturnValue(request.promise);
    function Editor() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <Button onClick={() => setOpen(true)}>Open item</Button>
          {open && (
            <ItemEditor
              item={item}
              itemType={type}
              course={course}
              ladder={null}
              onClose={() => setOpen(false)}
            />
          )}
        </>
      );
    }
    render(<Editor />);
    const user = userEvent.setup();
    const trigger = screen.getByRole('button', { name: 'Open item' });
    await user.click(trigger);
    expect(screen.getByRole('dialog').getAttribute('aria-modal')).toBe('true');
    const prompt = screen.getByLabelText(`${type.fields[0].name} · text`);
    expect(document.activeElement).toBe(prompt);
    fireEvent.change(prompt, { target: { value: 'draft before generation' } });
    await user.click(screen.getByRole('button', { name: /Write a mnemonic with AI/ }));
    expect(mocked.mnemonic.mock.calls[0][1][type.fields[0].id]).toBe('draft before generation');
    fireEvent.change(prompt, { target: { value: 'new content' } });
    await act(async () => request.resolve('A new mnemonic'));
    expect((prompt as HTMLInputElement).value).toBe('new content');
    expect((screen.getByLabelText('Note / mnemonic') as HTMLTextAreaElement).value).toBe('');
    await user.click(screen.getByRole('button', { name: 'Use generated mnemonic' }));
    expect((screen.getByLabelText('Note / mnemonic') as HTMLTextAreaElement).value).toBe(
      'A new mnemonic',
    );
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});

it('never returns the previous media URL for a different current item', async () => {
  await db.media.bulkAdd([
    {
      id: 'first',
      blob: new Blob(['a']),
      name: 'first.png',
      mimeType: 'image/png',
      createdAt: 1000,
    },
    {
      id: 'second',
      blob: new Blob(['bb']),
      name: 'second.png',
      mimeType: 'image/png',
      createdAt: 1000,
    },
  ]);
  const { result, rerender } = renderHook(({ id }) => useMediaUrl(id), {
    initialProps: { id: 'first' },
  });
  await waitFor(() => expect(result.current).toBe('blob:1'));
  rerender({ id: 'second' });
  expect(result.current).toBeNull();
  await waitFor(() => expect(result.current).toBe('blob:2'));
  expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:1');
});

it('refreshes same-id media after committed replacement and clears deleted media', async () => {
  const asset = {
    id: 'restored-image',
    blob: new Blob(['a']),
    name: 'image.png',
    mimeType: 'image/png',
    createdAt: 1000,
  };
  await db.media.add(asset);
  const { result } = renderHook(() => useMediaUrl(asset.id));
  await waitFor(() => expect(result.current).toBe('blob:1'));
  await act(async () => {
    await db.media.put({ ...asset, blob: new Blob(['replacement']) });
  });
  await waitFor(() => expect(result.current).toBe('blob:2'));
  await act(async () => {
    await db.media.delete(asset.id);
  });
  await waitFor(() => expect(result.current).toBeNull());
  expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:2');
});

it('keeps the editor version captured when it opened after a same-id restore updates props', async () => {
  const type = (await db.itemTypes.where('courseId').equals(course.id).toArray())[0];
  const item = await createItem(
    {
      courseId: course.id,
      typeId: type.id,
      fieldValues: Object.fromEntries(type.fields.map((field) => [field.id, 'original'])),
    },
    1000,
  );
  const close = vi.fn();
  const { rerender } = render(
    <ItemEditor item={item} itemType={type} course={course} ladder={null} onClose={close} />,
  );
  fireEvent.change(screen.getByLabelText('Note / mnemonic'), {
    target: { value: 'Unsaved old draft' },
  });
  const restored = { ...item, generation: 'new-dataset', note: 'Restored content' };
  await act(async () => {
    await db.items.put(restored);
  });
  rerender(
    <ItemEditor item={restored} itemType={type} course={course} ladder={null} onClose={close} />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Save item' }));
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('changed elsewhere'));
  expect((await db.items.get(item.id))?.note).toBe('Restored content');
  expect(close).not.toHaveBeenCalled();
  expect((screen.getByLabelText('Note / mnemonic') as HTMLTextAreaElement).value).toBe(
    'Unsaved old draft',
  );
});
