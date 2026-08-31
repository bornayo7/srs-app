import type { SrsLadder, SrsStage } from '../types';

const H = 60; // minutes
const D = 24 * H;

function stages(defs: [string, number][]): SrsStage[] {
  return defs.map(([name, intervalMinutes], i) => ({
    id: `s${i}-${name.toLowerCase().replace(/\s+/g, '-')}`,
    name,
    intervalMinutes,
  }));
}

/**
 * Built-in ladder presets, seeded as rows with isPreset: true, courseId: null.
 * Adopting one COPIES it to the course (copy-on-assign; no shared mutation).
 * Classic uses WaniKani's real values — the −1h on day-scale intervals keeps
 * daily reviews at a stable local time instead of drifting later each day.
 */
export const LADDER_PRESETS: SrsLadder[] = [
  {
    id: 'preset-classic',
    courseId: null,
    isPreset: true,
    name: 'Classic (WaniKani)',
    stages: stages([
      ['Apprentice I', 4 * H],
      ['Apprentice II', 8 * H],
      ['Apprentice III', 23 * H],
      ['Apprentice IV', 47 * H],
      ['Guru I', 167 * H],
      ['Guru II', 335 * H],
      ['Master', 719 * H],
      ['Enlightened', 2879 * H],
    ]),
    passesAtIndex: 4,
    burnEnabled: true,
    updatedAt: 0,
  },
  {
    id: 'preset-gentle',
    courseId: null,
    isPreset: true,
    name: 'Gentle (daily life)',
    stages: stages([
      ['Seed', 8 * H],
      ['Sprout', 1 * D],
      ['Sapling', 3 * D],
      ['Rooted', 7 * D],
      ['Grown', 21 * D],
      ['Deep', 60 * D],
      ['Lifelong', 180 * D],
    ]),
    passesAtIndex: 3,
    burnEnabled: false,
    updatedAt: 0,
  },
  {
    id: 'preset-bunpro',
    courseId: null,
    isPreset: true,
    name: 'Bunpro-like (gradual)',
    stages: stages([
      ['Stage 1', 4 * H],
      ['Stage 2', 8 * H],
      ['Stage 3', 1 * D],
      ['Stage 4', 2 * D],
      ['Stage 5', 4 * D],
      ['Stage 6', 8 * D],
      ['Stage 7', 14 * D],
      ['Stage 8', 30 * D],
      ['Stage 9', 60 * D],
      ['Stage 10', 120 * D],
      ['Stage 11', 180 * D],
    ]),
    passesAtIndex: 5,
    burnEnabled: true,
    updatedAt: 0,
  },
  {
    // P5: the drill ladder ghost cards run on. Burning a ghost = graduation (deletion).
    id: 'preset-ghost',
    courseId: null,
    isPreset: true,
    name: 'Ghost drill',
    stages: stages([
      ['Ghost I', 1 * H],
      ['Ghost II', 4 * H],
      ['Ghost III', 8 * H],
      ['Ghost IV', 1 * D],
    ]),
    passesAtIndex: 4,
    burnEnabled: true,
    updatedAt: 0,
  },
];

export const DEFAULT_PRESET_ID = 'preset-classic';
