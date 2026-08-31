import type { SeedCourse } from './index';

/**
 * Daily-life memory sample — runs on the Gentle ladder (no burning: life facts
 * come back forever, just very rarely). Replace the sample items with your own.
 */
export const gentleSeed: SeedCourse = {
  key: 'daily-life-v1',
  name: 'Daily Life Memory',
  description:
    'Sample course for names, dates, and little facts you keep forgetting. Gentle intervals, never burns.',
  ladderPresetId: 'preset-gentle',
  newPerDay: 10,
  batchSize: 5,
  type: {
    name: 'Fact',
    color: '#10b981',
    icon: '💡',
    fields: [
      { name: 'Prompt', kind: 'text' },
      { name: 'Answer', kind: 'text' },
    ],
    templates: [
      {
        name: 'Recall',
        promptFieldNames: ['Prompt'],
        answerFieldName: 'Answer',
        grading: { mode: 'typed', answerLang: 'latin', typoTolerance: true },
      },
    ],
  },
  items: [
    { fields: { Prompt: "Mom's birthday", Answer: 'march 14' }, synonyms: { Recall: ['3/14', 'mar 14'] } },
    { fields: { Prompt: "Dad's birthday", Answer: 'july 8' }, synonyms: { Recall: ['7/8', 'jul 8'] } },
    { fields: { Prompt: "Neighbor's dog's name", Answer: 'biscuit' } },
    { fields: { Prompt: 'Apartment gate code (sample!)', Answer: '4821' } },
    { fields: { Prompt: "Barber's name", Answer: 'marco' } },
    { fields: { Prompt: 'Car tire pressure (psi)', Answer: '36' } },
    { fields: { Prompt: "Landlord's name", Answer: 'mrs chen' }, synonyms: { Recall: ['chen'] } },
    { fields: { Prompt: 'Gym locker number', Answer: '117' } },
    { fields: { Prompt: "Cousin's new baby's name", Answer: 'noah' } },
    { fields: { Prompt: 'Printer wifi network', Answer: 'brother-2400' } },
  ],
};
