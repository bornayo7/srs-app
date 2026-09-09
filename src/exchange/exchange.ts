import { db } from '@/db/db';
import { parsePacket, type Packet } from '@/packages/schema';
import { buildSnapshot } from './snapshot';
import { applyPacket, type ImportResult } from '@/packages/importPacket';
import { contentDigest } from '@/packages/receipts';

/**
 * The exchange folder bridges the browser app and the srs-mcp server:
 *   <folder>/snapshot.json  — written by the app (courses, schemas, stats)
 *   <folder>/inbox/*.json   — packets written by MCP clients, imported here
 *   <folder>/inbox/done/    — packets moved after import
 * Uses the File System Access API (Chromium) with a persisted handle in meta.
 */

const HANDLE_KEY = 'exchange:dirHandle';

export function exchangeSupported(): boolean {
  return typeof window !== 'undefined' && 'showDirectoryPicker' in window;
}

export async function getSavedHandle(): Promise<FileSystemDirectoryHandle | null> {
  const row = await db.meta.get(HANDLE_KEY);
  const value = row?.value as FileSystemDirectoryHandle | undefined;
  // Defensive: an old/foreign backup could have restored a plain object here.
  if (!value || typeof value.queryPermission !== 'function') {
    if (row) await db.meta.delete(HANDLE_KEY);
    return null;
  }
  return value;
}

export type ExchangePermission = 'granted' | 'prompt' | 'denied';

export async function checkPermission(
  handle: FileSystemDirectoryHandle,
): Promise<ExchangePermission> {
  try {
    return (await handle.queryPermission({ mode: 'readwrite' })) as ExchangePermission;
  } catch {
    return 'denied';
  }
}

/** Must be called from a user gesture when permission is 'prompt'. */
export async function reRequestPermission(
  handle: FileSystemDirectoryHandle,
): Promise<ExchangePermission> {
  try {
    return (await handle.requestPermission({ mode: 'readwrite' })) as ExchangePermission;
  } catch {
    return 'denied';
  }
}

/** Pick the folder (user gesture required), create subdirs, persist the handle. */
export async function connectExchange(): Promise<FileSystemDirectoryHandle> {
  const handle = await window.showDirectoryPicker({ id: 'srs-exchange', mode: 'readwrite' });
  const inbox = await handle.getDirectoryHandle('inbox', { create: true });
  await inbox.getDirectoryHandle('done', { create: true });
  await db.meta.put({ key: HANDLE_KEY, value: handle });
  return handle;
}

export async function disconnectExchange(): Promise<void> {
  await db.meta.delete(HANDLE_KEY);
}

async function writeFile(
  dir: FileSystemDirectoryHandle,
  name: string,
  content: string,
): Promise<void> {
  const file = await dir.getFileHandle(name, { create: true });
  const writable = await file.createWritable();
  await writable.write(content);
  await writable.close();
}

export async function writeSnapshot(handle: FileSystemDirectoryHandle, now: number): Promise<void> {
  const snapshot = await buildSnapshot(now);
  await writeFile(handle, 'snapshot.json', JSON.stringify(snapshot, null, 2));
}

export interface InboxEntry {
  fileName: string;
  packet?: Packet;
  error?: string;
  alreadyImported?: boolean;
}

/** List pending packets in inbox/ (excluding done/). */
export async function scanInbox(handle: FileSystemDirectoryHandle): Promise<InboxEntry[]> {
  const inbox = await handle.getDirectoryHandle('inbox', { create: true });
  const entries: InboxEntry[] = [];
  for await (const entry of inbox.values()) {
    if (entry.kind !== 'file' || !entry.name.toLowerCase().endsWith('.json')) continue;
    try {
      const file = await (entry as FileSystemFileHandle).getFile();
      const packet = parsePacket(JSON.parse(await file.text()));
      const digest = await contentDigest(JSON.stringify(packet));
      const receipt = await db.packetReceipts.get(
        packet.id ? `packet:${packet.id}` : `legacy:${digest}`,
      );
      entries.push({ fileName: entry.name, packet, alreadyImported: receipt?.digest === digest });
    } catch (err) {
      entries.push({ fileName: entry.name, error: (err as Error).message });
    }
  }
  return entries.sort((a, b) => a.fileName.localeCompare(b.fileName));
}

/** Move a processed packet into inbox/done/ (copy + delete). */
export async function archivePacket(
  handle: FileSystemDirectoryHandle,
  fileName: string,
  expectedDigest?: string,
): Promise<void> {
  const inbox = await handle.getDirectoryHandle('inbox');
  const done = await inbox.getDirectoryHandle('done', { create: true });
  const source = await inbox.getFileHandle(fileName);
  const content = await (await source.getFile()).text();
  const digest = await contentDigest(JSON.stringify(parsePacket(JSON.parse(content))));
  if (expectedDigest && digest !== expectedDigest)
    throw new Error('The inbox file changed after import. Rescan before processing it.');
  // Never replace a different archived delivery with the same legacy filename.
  let destination = fileName;
  try {
    const archived = await done.getFileHandle(destination);
    if ((await (await archived.getFile()).text()) !== content)
      destination = `${digest}-${fileName}`;
  } catch (error) {
    if (!(error instanceof DOMException) || error.name !== 'NotFoundError') throw error;
  }
  await writeFile(done, destination, content);
  if ((await (await source.getFile()).text()) !== content)
    throw new Error('The inbox file changed while archiving. Rescan before processing it.');
  await inbox.removeEntry(fileName);
}

/** A receipt and imported rows commit together; archiving can be safely retried. */
export async function importInboxEntry(
  handle: FileSystemDirectoryHandle,
  fileName: string,
  now: number,
): Promise<ImportResult & { archiveError?: string }> {
  const inbox = await handle.getDirectoryHandle('inbox');
  const source = await inbox.getFileHandle(fileName);
  const packet = parsePacket(JSON.parse(await (await source.getFile()).text()));
  const digest = await contentDigest(JSON.stringify(packet));
  const result = await applyPacket(packet, now, { receiptKey: `legacy:${digest}`, digest });
  try {
    await archivePacket(handle, fileName, digest);
  } catch (error) {
    return { ...result, archiveError: error instanceof Error ? error.message : String(error) };
  }
  return result;
}

/**
 * Best-effort snapshot refresh — silently no-ops when the exchange isn't
 * connected or permission has lapsed. Safe to call after any data change.
 */
export async function maybeRefreshSnapshot(now: number): Promise<void> {
  try {
    if (!exchangeSupported()) return;
    const handle = await getSavedHandle();
    if (!handle) return;
    if ((await checkPermission(handle)) !== 'granted') return;
    await writeSnapshot(handle, now);
  } catch {
    // never let snapshot writing break app flows
  }
}
