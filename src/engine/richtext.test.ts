import { describe, expect, it } from 'vitest';
import { parseRichText, richTextToPlain } from './richtext';

describe('parseRichText keeps loose markers literal', () => {
  it('plain text that merely starts and ends with a marker is not a mark', () => {
    expect(parseRichText('* 3 *')).toEqual([[{ kind: 'text', text: '* 3 *' }]]);
    expect(parseRichText('** foo **')).toEqual([[{ kind: 'text', text: '** foo **' }]]);
    expect(parseRichText('== a ==')).toEqual([[{ kind: 'text', text: '== a ==' }]]);
  });

  it('a lone marker is text, not an empty mark that vanishes', () => {
    expect(parseRichText('`')).toEqual([[{ kind: 'text', text: '`' }]]);
    expect(parseRichText('**')).toEqual([[{ kind: 'text', text: '**' }]]);
    expect(richTextToPlain('*')).toBe('*');
  });

  it('real marks still parse next to loose ones', () => {
    expect(parseRichText('* 3 * and **bold**')).toEqual([
      [
        { kind: 'text', text: '* 3 * and ' },
        { kind: 'bold', text: 'bold' },
      ],
    ]);
  });

  it('empty lines survive as empty token lists', () => {
    expect(parseRichText('a\n\nb')).toEqual([
      [{ kind: 'text', text: 'a' }],
      [],
      [{ kind: 'text', text: 'b' }],
    ]);
  });
});
