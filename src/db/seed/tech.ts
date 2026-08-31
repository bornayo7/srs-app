import type { SeedCourse } from './index';

/** CS terminology sample — Classic (WaniKani) ladder, shows off synonyms. */
export const techSeed: SeedCourse = {
  key: 'cs-terms-v1',
  name: 'CS Terms',
  description: 'Sample course of computer-science terminology on the classic WaniKani ladder.',
  ladderPresetId: 'preset-classic',
  newPerDay: 15,
  batchSize: 5,
  types: [
    {
      name: 'Term',
      color: '#0ea5e9',
      icon: '💻',
      fields: [
        { name: 'Definition', kind: 'text' },
        { name: 'Term', kind: 'text' },
      ],
      templates: [
        {
          name: 'Term',
          promptFieldNames: ['Definition'],
          answerFieldName: 'Term',
          grading: { mode: 'typed', answerLang: 'latin', typoTolerance: true },
        },
      ],
    },
  ],
  items: [
    {
      fields: {
        Definition: 'Last-in, first-out data structure',
        Term: 'stack',
      },
    },
    {
      fields: {
        Definition: 'First-in, first-out data structure',
        Term: 'queue',
      },
    },
    {
      fields: {
        Definition: 'Time complexity of binary search',
        Term: 'o(log n)',
      },
      synonyms: { Term: ['log n', 'logn', 'logarithmic'] },
    },
    {
      fields: {
        Definition: 'Worst-case time complexity of quicksort',
        Term: 'o(n^2)',
      },
      synonyms: { Term: ['n^2', 'n squared', 'quadratic'] },
    },
    {
      fields: {
        Definition: 'Transport protocol with reliable, ordered delivery',
        Term: 'tcp',
      },
    },
    {
      fields: {
        Definition: 'Transaction guarantees acronym in databases',
        Term: 'acid',
      },
    },
    {
      fields: {
        Definition: 'Map keys to array slots via a function; O(1) average lookup',
        Term: 'hash table',
      },
      synonyms: { Term: ['hashmap', 'hash map', 'dictionary'] },
    },
    {
      fields: {
        Definition: 'Graph traversal that explores neighbors level by level',
        Term: 'bfs',
      },
      synonyms: { Term: ['breadth first search', 'breadth-first search'] },
    },
    {
      fields: {
        Definition: 'Graph traversal that goes as deep as possible first',
        Term: 'dfs',
      },
      synonyms: { Term: ['depth first search', 'depth-first search'] },
    },
    {
      fields: {
        Definition: 'Function that calls itself with a smaller subproblem',
        Term: 'recursion',
      },
    },
    {
      fields: {
        Definition: 'Caching results of pure function calls to avoid recomputation',
        Term: 'memoization',
      },
      synonyms: { Term: ['memoisation'] },
    },
    {
      fields: {
        Definition: 'Design principle: one class, one reason to change',
        Term: 'single responsibility',
      },
      synonyms: { Term: ['single responsibility principle', 'srp'] },
    },
  ],
};
