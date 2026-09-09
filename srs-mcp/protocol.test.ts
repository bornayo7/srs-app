import { afterEach, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parsePacket, PACKET_FORMAT, PACKET_VERSION } from '../src/packages/schema';
import { db, ensurePresets } from '../src/db/db';
import { applyPacket } from '../src/packages/importPacket';
import { acceptAllValid } from '../src/services/proposals';
import { buildSnapshot } from '../src/exchange/snapshot';

let temporary: string | undefined;
let client: Client | undefined;
afterEach(async () => {
  await client?.close();
  // Only a directory returned by mkdtemp for this test is removed.
  if (temporary) await fs.rm(temporary, { recursive: true, force: true });
});

it('publishes and imports a multi-type plan through the actual stdio MCP client', async () => {
  await Promise.all(db.tables.map((table) => table.clear()));
  await ensurePresets();
  temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'srs-mcp-protocol-'));
  await fs.writeFile(
    path.join(temporary, 'snapshot.json'),
    JSON.stringify(await buildSnapshot(Date.now())),
  );
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', 'tsx', path.resolve('srs-mcp/index.ts')],
    env: { ...env, SRS_EXCHANGE: temporary },
    stderr: 'pipe',
  });
  client = new Client({ name: 'srs-acceptance', version: '1.0.0' });
  await client.connect(transport);
  const tools = await client.listTools();
  expect(tools.tools.some((tool) => tool.name === 'propose_course_plan')).toBe(true);
  const result = await client.callTool({
    name: 'propose_course_plan',
    arguments: {
      name: 'Protocol acceptance',
      releaseMode: 'manual',
      itemTypes: ['Term', 'Question'].map((name) => ({
        name,
        fields: ['Front', 'Back'],
        templates: [{ name: 'Recall', promptFields: ['Front'], answerField: 'Back' }],
      })),
      units: [
        {
          title: 'First unit',
          targetCount: 2,
          items: [
            { type: 'Term', fields: { Front: 'Cell', Back: 'Unit of life' } },
            { type: 'Question', fields: { Front: 'Carries genes?', Back: 'DNA' } },
          ],
        },
      ],
    },
  });
  expect(result.isError).not.toBe(true);
  const files = (await fs.readdir(path.join(temporary, 'inbox'))).filter((file) =>
    file.endsWith('.json'),
  );
  expect(files).toHaveLength(1);
  const packet = parsePacket(
    JSON.parse(await fs.readFile(path.join(temporary, 'inbox', files[0]), 'utf8')),
  );
  expect(packet).toMatchObject({
    format: PACKET_FORMAT,
    version: PACKET_VERSION,
    kind: 'course-plan',
    id: expect.any(String),
  });
  const imported = await applyPacket(packet, Date.now());
  await acceptAllValid(imported.courseId, Date.now());
  expect(await db.items.count()).toBe(2);
  expect(new Set((await db.items.toArray()).map((item) => item.typeId)).size).toBe(2);
}, 15000);
