/** Katakana → hiragana (U+30A1–U+30F6 sit 0x60 above their hiragana twins). */
function katakanaToHiragana(s: string): string {
  return s.replace(/[ァ-ヶ]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0x60));
}

/**
 * Canonical form both sides of every comparison pass through.
 * - NFKC (not NFC): folds full-width Latin （ａｔｔａｃｋ → attack）and half-width
 *   katakana, so an IME left in 全角英数 mode can't turn a right answer wrong.
 * - Katakana folds to hiragana: a romaji IME produces hiragana, so コーヒー
 *   would otherwise be unanswerable without a Japanese keyboard.
 */
export function normalizeAnswer(raw: string): string {
  return katakanaToHiragana(raw.normalize('NFKC'))
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

// Kana ONLY (no CJK) — what a romaji IME can actually produce.
const KANA_ONLY_RE = /[぀-ヿㇰ-ㇿｦ-ﾟー]/;

export function containsLatin(s: string): boolean {
  return LATIN_RE.test(s);
}

/** Japanese script incl. kanji — used by the wrong-alphabet guard. */
export function containsKana(s: string): boolean {
  return KANA_RE.test(s);
}

/**
 * Kana/kana-adjacent only. Drives the romaji IME: a kanji answer must NOT
 * switch the box into kana mode (typing romaji could never produce kanji).
 */
export function isKanaTypeable(s: string): boolean {
  return KANA_ONLY_RE.test(s) && !/[㐀-䶿一-鿿豈-﫿]/.test(s);
}
