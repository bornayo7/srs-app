/**
 * Canonical form both sides of every comparison pass through.
 * NFKC (not NFC): folds full-width Latin （ａｔｔａｃｋ → attack）and half-width
 * katakana, so an IME left in 全角英数 mode can't turn a right answer wrong.
 */
export function normalizeAnswer(raw: string): string {
  return raw
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.,!?;:。、！？]+$/u, '')
    .trim();
}

const LATIN_RE = /[a-z]/i;
// Hiragana, katakana (incl. phonetic extensions & halfwidth), iteration marks,
// and CJK ideographs — so kanji typed on a meaning card shakes instead of
// counting as a miss.
const KANA_RE = /[぀-ヿㇰ-ㇿｦ-ﾟー々〆〻㐀-䶿一-鿿豈-﫿]/;

export function containsLatin(s: string): boolean {
  return LATIN_RE.test(s);
}

export function containsKana(s: string): boolean {
  return KANA_RE.test(s);
}
