import { beforeEach, expect, it } from 'vitest';
import { db, ensurePresets } from '@/db/db';
import { importInboxEntry, scanInbox } from './exchange';

/** Browser-file adapter double. Only the operations exercised by exchange are implemented. */
interface MemoryFolder {
  handle: FileSystemDirectoryHandle;
  files: Map<string, string>;
  folders: Map<string, MemoryFolder>;
  setRemovalFailure(value: boolean): void;
}
function memoryFolder(name: string): MemoryFolder {
  const files = new Map<string, string>();
  const folders = new Map<string, MemoryFolder>();
  let failRemoval = false;
  const missing = () => new DOMException('File not found', 'NotFoundError');
  const fileHandle = (fileName: string) => ({
    kind: 'file' as const,
    name: fileName,
    getFile: async () => new File([files.get(fileName) ?? ''], fileName),
    createWritable: async () => {
      let pending = '';
      return {
        write: async (text: string) => {
          pending = text;
        },
        close: async () => {
          files.set(fileName, pending);
        },
      };
    },
  });
  const handle = {
    kind: 'directory',
    name,
    getDirectoryHandle: async (child: string, opts?: { create?: boolean }) => {
      if (!folders.has(child) && opts?.create) folders.set(child, memoryFolder(child));
      if (!folders.has(child)) throw missing();
      return folders.get(child)!.handle;
    },
    getFileHandle: async (fileName: string, opts?: { create?: boolean }) => {
      if (!files.has(fileName) && opts?.create) files.set(fileName, '');
      if (!files.has(fileName)) throw missing();
      return fileHandle(fileName);
    },
    removeEntry: async (fileName: string) => {
      if (failRemoval) throw new DOMException('Removal denied', 'NotAllowedError');
      files.delete(fileName);
    },
    async *values() {
      for (const fileName of files.keys()) yield fileHandle(fileName);
    },
  } as FileSystemDirectoryHandle;
  return {
    handle,
    files,
    folders,
    setRemovalFailure(value: boolean) {
      failRemoval = value;
    },
  };
}

beforeEach(async () => {
  await Promise.all(db.tables.map((table) => table.clear()));
  await ensurePresets();
});

it('retries archive cleanup without applying an imported packet twice', async () => {
  const folder = memoryFolder('exchange');
  await folder.handle.getDirectoryHandle('inbox', { create: true });
  const inbox = folder.folders.get('inbox')!;
  inbox.files.set(
    'delivery.json',
    JSON.stringify({
      format: 'srs-packet',
      version: 2,
      id: 'archive-retry',
      kind: 'create-course',
      course: { name: 'Archive retry' },
      itemTypes: [
        {
          name: 'Term',
          fields: [{ name: 'Front' }, { name: 'Back' }],
          templates: [{ name: 'Recall', promptFields: ['Front'], answerField: 'Back' }],
        },
      ],
      items: [{ fields: { Front: 'Question', Back: 'Answer' } }],
    }),
  );
  inbox.setRemovalFailure(true);
  expect(await importInboxEntry(folder.handle, 'delivery.json', 100)).toMatchObject({
    archiveError: 'Removal denied',
  });
  expect(await db.items.count()).toBe(1);
  expect((await scanInbox(folder.handle))[0].alreadyImported).toBe(true);
  expect(inbox.files.has('delivery.json')).toBe(true);
  inbox.setRemovalFailure(false);
  expect(await importInboxEntry(folder.handle, 'delivery.json', 101)).toMatchObject({
    alreadyImported: true,
  });
  expect(await db.items.count()).toBe(1);
  expect(await db.packetReceipts.count()).toBe(1);
  expect(inbox.files.has('delivery.json')).toBe(false);
  expect(inbox.folders.get('done')!.files.has('delivery.json')).toBe(true);
});
