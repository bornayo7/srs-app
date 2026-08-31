import type { SeedCourse } from './index';

/**
 * WaniKani-shaped Japanese course — the full Phase 2 feature set in one deck:
 * three item types, radical→kanji→vocab prerequisites, two levels with kanji
 * as the level gate, and kana-typed reading cards (romaji is converted as you
 * type, and readings are graded exact).
 *
 * Kanji and vocab each generate TWO cards (meaning + reading), so an item only
 * passes once BOTH have reached Guru — exactly WaniKani's rule.
 */
export const japaneseSeed: SeedCourse = {
  key: 'japanese-v1',
  name: 'Japanese: Radicals → Kanji → Vocab',
  description:
    'WaniKani-style sample: radicals unlock kanji, kanji unlock vocabulary, and passing 90% of a level’s kanji advances the level.',
  ladderPresetId: 'preset-classic',
  newPerDay: 15,
  batchSize: 5,
  levels: { gateTypeNames: ['Kanji'], passPercent: 90 },
  types: [
    {
      name: 'Radical',
      color: '#0ea5e9',
      icon: '⛩️',
      fields: [
        { name: 'Radical', kind: 'text' },
        { name: 'Meaning', kind: 'text' },
      ],
      templates: [
        {
          name: 'Meaning',
          promptFieldNames: ['Radical'],
          answerFieldName: 'Meaning',
          grading: { mode: 'typed', answerLang: 'latin', typoTolerance: true },
        },
      ],
    },
    {
      name: 'Kanji',
      color: '#ec4899',
      icon: '🈶',
      fields: [
        { name: 'Kanji', kind: 'text' },
        { name: 'Meaning', kind: 'text' },
        { name: 'Reading', kind: 'text' },
      ],
      templates: [
        {
          name: 'Meaning',
          promptFieldNames: ['Kanji'],
          answerFieldName: 'Meaning',
          grading: { mode: 'typed', answerLang: 'latin', typoTolerance: true },
        },
        {
          name: 'Reading',
          promptFieldNames: ['Kanji'],
          answerFieldName: 'Reading',
          grading: { mode: 'typed', answerLang: 'kana', typoTolerance: false },
        },
      ],
    },
    {
      name: 'Vocab',
      color: '#8b5cf6',
      icon: '🗣️',
      fields: [
        { name: 'Word', kind: 'text' },
        { name: 'Meaning', kind: 'text' },
        { name: 'Reading', kind: 'text' },
      ],
      templates: [
        {
          name: 'Meaning',
          promptFieldNames: ['Word'],
          answerFieldName: 'Meaning',
          grading: { mode: 'typed', answerLang: 'latin', typoTolerance: true },
        },
        {
          name: 'Reading',
          promptFieldNames: ['Word'],
          answerFieldName: 'Reading',
          grading: { mode: 'typed', answerLang: 'kana', typoTolerance: false },
        },
      ],
    },
  ],
  items: [
    // ---------- Level 1 ----------
    { type: 'Radical', key: 'r-person', level: 1, fields: { Radical: '人', Meaning: 'person' } },
    { type: 'Radical', key: 'r-tree', level: 1, fields: { Radical: '木', Meaning: 'tree' } },
    { type: 'Radical', key: 'r-mouth', level: 1, fields: { Radical: '口', Meaning: 'mouth' } },
    { type: 'Radical', key: 'r-sun', level: 1, fields: { Radical: '日', Meaning: 'sun' } },
    { type: 'Radical', key: 'r-moon', level: 1, fields: { Radical: '月', Meaning: 'moon' } },

    {
      type: 'Kanji',
      key: 'k-person',
      level: 1,
      prereqs: ['r-person'],
      fields: { Kanji: '人', Meaning: 'person', Reading: 'じん' },
      synonyms: { Meaning: ['human'], Reading: ['にん'] },
      note: 'The radical IS the kanji here — a person walking on two legs.',
    },
    {
      type: 'Kanji',
      key: 'k-tree',
      level: 1,
      prereqs: ['r-tree'],
      fields: { Kanji: '木', Meaning: 'tree', Reading: 'もく' },
      synonyms: { Meaning: ['wood'] },
    },
    {
      type: 'Kanji',
      key: 'k-mouth',
      level: 1,
      prereqs: ['r-mouth'],
      fields: { Kanji: '口', Meaning: 'mouth', Reading: 'こう' },
    },
    {
      type: 'Kanji',
      key: 'k-sun',
      level: 1,
      prereqs: ['r-sun'],
      fields: { Kanji: '日', Meaning: 'sun', Reading: 'にち' },
      synonyms: { Meaning: ['day'] },
    },

    {
      type: 'Vocab',
      key: 'v-person',
      level: 1,
      prereqs: ['k-person'],
      fields: { Word: '一人', Meaning: 'one person', Reading: 'ひとり' },
      synonyms: { Meaning: ['alone', 'by oneself'] },
      note: 'One (一) person (人) — hitori, all by yourself.',
    },
    {
      type: 'Vocab',
      key: 'v-tree',
      level: 1,
      prereqs: ['k-tree'],
      fields: { Word: '木曜日', Meaning: 'thursday', Reading: 'もくようび' },
    },
    {
      type: 'Vocab',
      key: 'v-entrance',
      level: 1,
      prereqs: ['k-mouth'],
      fields: { Word: '入口', Meaning: 'entrance', Reading: 'いりぐち' },
    },
    {
      type: 'Vocab',
      key: 'v-sun',
      level: 1,
      prereqs: ['k-sun'],
      fields: { Word: '日本', Meaning: 'japan', Reading: 'にほん' },
    },

    // ---------- Level 2 (locked until 90% of level-1 kanji pass) ----------
    { type: 'Radical', key: 'r-water', level: 2, fields: { Radical: '氵', Meaning: 'water' } },
    { type: 'Radical', key: 'r-fire', level: 2, fields: { Radical: '火', Meaning: 'fire' } },

    {
      type: 'Kanji',
      key: 'k-moon',
      level: 2,
      prereqs: ['r-moon'],
      fields: { Kanji: '月', Meaning: 'moon', Reading: 'げつ' },
      synonyms: { Meaning: ['month'] },
    },
    {
      type: 'Kanji',
      key: 'k-fire',
      level: 2,
      prereqs: ['r-fire'],
      fields: { Kanji: '火', Meaning: 'fire', Reading: 'か' },
    },
    {
      type: 'Kanji',
      key: 'k-sea',
      level: 2,
      prereqs: ['r-water', 'r-person'],
      fields: { Kanji: '海', Meaning: 'sea', Reading: 'かい' },
      synonyms: { Meaning: ['ocean'] },
      note: 'Water (氵) beside a person — the sea is where people meet water.',
    },

    {
      type: 'Vocab',
      key: 'v-moon',
      level: 2,
      prereqs: ['k-moon'],
      fields: { Word: '月曜日', Meaning: 'monday', Reading: 'げつようび' },
    },
    {
      type: 'Vocab',
      key: 'v-volcano',
      level: 2,
      prereqs: ['k-fire'],
      fields: { Word: '火山', Meaning: 'volcano', Reading: 'かざん' },
    },
    {
      type: 'Vocab',
      key: 'v-sea',
      level: 2,
      prereqs: ['k-sea'],
      fields: { Word: '海外', Meaning: 'overseas', Reading: 'かいがい' },
      synonyms: { Meaning: ['abroad', 'foreign'] },
    },
  ],
};
