import { describe, expect, it } from 'vitest';
import { osaDistance, typoBudget } from './distance';
import { normalizeAnswer } from './normalize';
import { matchTypedAnswer, type MatchContext } from './match';

describe('osaDistance', () => {
  it('identical strings are 0', () => {
    expect(osaDistance('receive', 'receive')).toBe(0);
  });
  it('adjacent transposition counts as ONE edit', () => {
    expect(osaDistance('receive', 'recieve')).toBe(1);
  });
  it('substitution, insertion, deletion', () => {
    expect(osaDistance('cat', 'car')).toBe(1);
    expect(osaDistance('cat', 'cart')).toBe(1);
    expect(osaDistance('cart', 'cat')).toBe(1);
  });
  it('empty strings', () => {
    expect(osaDistance('', 'abc')).toBe(3);
    expect(osaDistance('abc', '')).toBe(3);
  });
});

describe('typoBudget ladder', () => {
  it('len<4 → 0, len<8 → 1, else 2', () => {
    expect(typoBudget(3)).toBe(0);
    expect(typoBudget(4)).toBe(1);
    expect(typoBudget(7)).toBe(1);
    expect(typoBudget(8)).toBe(2);
  });
});

describe('normalizeAnswer', () => {
  it('lowercases, collapses whitespace, strips trailing punctuation', () => {
    expect(normalizeAnswer('  To   Attack!  ')).toBe('to attack');
    expect(normalizeAnswer('O(log n).')).toBe('o(log n)');
  });
});

function ctx(overrides: Partial<MatchContext> = {}): MatchContext {
  return {
    accepted: ['attack'],
    blocked: [],
    guidance: [],
    siblingAccepted: [],
    answerLang: 'latin',
    typoTolerance: true,
    ...overrides,
  };
}

describe('matchTypedAnswer pipeline', () => {
  it('exact match → correct', () => {
    expect(matchTypedAnswer('Attack', ctx())).toMatchObject({ verdict: 'correct' });
  });

  it('synonym (in accepted set) → correct', () => {
    const r = matchTypedAnswer('assault', ctx({ accepted: ['attack', 'assault'] }));
    expect(r).toMatchObject({ verdict: 'correct', matched: 'assault' });
  });

  it('small typo within budget → correctWithTypo', () => {
    const r = matchTypedAnswer('atack', ctx());
    expect(r).toMatchObject({ verdict: 'correctWithTypo', distance: 1 });
  });

  it('short answers (len<4) get no typo budget', () => {
    expect(matchTypedAnswer('cst', ctx({ accepted: ['cat'] }))).toEqual({ verdict: 'incorrect' });
  });

  it('block list defeats fuzzy rescue', () => {
    const r = matchTypedAnswer('attach', ctx({ blocked: ['attach'] }));
    expect(r).toEqual({ verdict: 'incorrect' });
    // sanity: without the block it would fuzzy-match (distance 1)
    expect(matchTypedAnswer('attach', ctx())).toMatchObject({ verdict: 'correctWithTypo' });
  });

  it('guidance answer → retry with the custom message, no penalty', () => {
    const r = matchTypedAnswer(
      'strike',
      ctx({ guidance: [{ text: 'strike', message: 'Almost — we want the noun form' }] }),
    );
    expect(r).toEqual({
      verdict: 'retry',
      reason: 'guidance',
      message: 'Almost — we want the noun form',
    });
  });

  it('empty input → retry, not incorrect', () => {
    expect(matchTypedAnswer('   ', ctx())).toMatchObject({ verdict: 'retry', reason: 'empty' });
  });

  it('kana expected but latin typed → retry (shake)', () => {
    const r = matchTypedAnswer('kougeki', ctx({ accepted: ['こうげき'], answerLang: 'kana' }));
    expect(r).toMatchObject({ verdict: 'retry', reason: 'alphabet' });
  });

  it('kana answers are exact-match only — no fuzzy', () => {
    const r = matchTypedAnswer('こうげきき', ctx({ accepted: ['こうげき'], answerLang: 'kana' }));
    expect(r).toEqual({ verdict: 'incorrect' });
    expect(
      matchTypedAnswer('こうげき', ctx({ accepted: ['こうげき'], answerLang: 'kana' })),
    ).toMatchObject({ verdict: 'correct' });
  });

  it('typing the OTHER facet of the item → wrong-facet retry', () => {
    const r = matchTypedAnswer('to strike', ctx({ siblingAccepted: ['to strike'] }));
    expect(r).toMatchObject({ verdict: 'retry', reason: 'wrongFacet' });
  });

  it('kanji typed on a latin card → alphabet retry, not a penalty', () => {
    const r = matchTypedAnswer('攻撃', ctx({ accepted: ['attack'] }));
    expect(r).toMatchObject({ verdict: 'retry', reason: 'alphabet' });
  });

  it('full-width Latin folds via NFKC — right answer stays right, wrong script shakes', () => {
    // full-width "attack" typed with an IME left in 全角英数 mode
    expect(matchTypedAnswer('ａｔｔａｃｋ', ctx())).toMatchObject({ verdict: 'correct' });
    // full-width romaji on a kana card → alphabet retry, not incorrect
    const r = matchTypedAnswer('ｋｏｕｇｅｋｉ', ctx({ accepted: ['こうげき'], answerLang: 'kana' }));
    expect(r).toMatchObject({ verdict: 'retry', reason: 'alphabet' });
  });

  it('mixed-script accepted answers stay answerable (exact runs before the script guard)', () => {
    const r = matchTypedAnswer('kabuki 歌舞伎', ctx({ accepted: ['kabuki 歌舞伎'] }));
    expect(r).toMatchObject({ verdict: 'correct' });
  });

  it('plain wrong answer → incorrect', () => {
    expect(matchTypedAnswer('defend', ctx())).toEqual({ verdict: 'incorrect' });
  });
});
