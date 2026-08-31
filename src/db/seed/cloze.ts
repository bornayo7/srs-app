import type { SeedCourse } from './index';

/**
 * Sentence-cloze demo (Bunpro-style): each item is an English preposition with
 * rotating example sentences; reviews mask the ⟦blank⟧ and you type it.
 */
export const clozeSeed: SeedCourse = {
  key: 'cloze-demo-v1',
  name: 'Prepositions in Context',
  description:
    'Sample sentence-cloze course — every review shows a different example sentence with the blank masked.',
  ladderPresetId: 'preset-bunpro',
  newPerDay: 10,
  batchSize: 5,
  type: {
    name: 'Preposition',
    color: '#f59e0b',
    icon: '🧩',
    fields: [
      { name: 'Word', kind: 'text' },
      { name: 'Meaning', kind: 'text' },
      { name: 'Sentences', kind: 'clozeSentences' },
    ],
    templates: [
      {
        name: 'Cloze',
        promptFieldNames: ['Meaning'],
        answerFieldName: 'Sentences',
        grading: { mode: 'sentenceCloze', sentencesFieldId: '', rotation: 'random' },
      },
    ],
  },
  items: [
    {
      fields: {
        Word: 'on',
        Meaning: 'touching a surface; a scheduled day',
        Sentences: [
          { text: 'The keys are ⟦on⟧ the kitchen table.' },
          { text: 'Her interview is ⟦on⟧ Thursday morning.' },
          { text: 'He hung the picture ⟦on⟧ the wall.' },
        ],
      },
    },
    {
      fields: {
        Word: 'in',
        Meaning: 'inside a space; months, years, longer periods',
        Sentences: [
          { text: 'The milk is ⟦in⟧ the fridge.' },
          { text: 'She was born ⟦in⟧ October.' },
          { text: 'They live ⟦in⟧ a small village.' },
        ],
      },
    },
    {
      fields: {
        Word: 'at',
        Meaning: 'a specific point or time',
        Sentences: [
          { text: 'Meet me ⟦at⟧ the station.' },
          { text: 'The film starts ⟦at⟧ seven.' },
          { text: "She's ⟦at⟧ work until five." },
        ],
      },
    },
    {
      fields: {
        Word: 'since',
        Meaning: 'from a point in the past until now',
        Sentences: [
          { text: "I've lived here ⟦since⟧ 2019." },
          { text: 'He has been awake ⟦since⟧ dawn.' },
        ],
      },
    },
    {
      fields: {
        Word: 'between',
        Meaning: 'in the space separating two things',
        Sentences: [
          { text: 'The bakery is ⟦between⟧ the bank and the café.' },
          { text: 'Keep this ⟦between⟧ you and me.' },
        ],
      },
    },
    {
      fields: {
        Word: 'during',
        Meaning: 'throughout a period or event',
        Sentences: [
          { text: 'No phones ⟦during⟧ the exam, please.' },
          { text: 'It rained ⟦during⟧ the night.' },
        ],
      },
    },
  ],
};
