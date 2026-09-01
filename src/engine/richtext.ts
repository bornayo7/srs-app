/**
 * A deliberately tiny inline markup for mnemonics and notes:
 *   **bold**   *italic*   ==highlight==   `code`
 * plus hard line breaks. Parsed to tokens (never HTML) so notes can come from
 * AI, imports, or packets without opening an injection hole.
 */

export type RichKind = 'text' | 'bold' | 'italic' | 'mark' | 'code';

export interface RichToken {
  kind: RichKind;
  text: string;
}

// Marks must hug their content ("2 * 3 * 4" is arithmetic, not italics).
const TOKEN_RE =
  /(\*\*[^\s*](?:[^*\n]*[^\s*])?\*\*|\*[^\s*](?:[^*\n]*[^\s*])?\*|==[^\s=](?:[^=\n]*[^\s=])?==|`[^`\n]+`)/g;

function classify(chunk: string): RichToken {
  if (chunk.startsWith('**') && chunk.endsWith('**')) {
    return { kind: 'bold', text: chunk.slice(2, -2) };
  }
  if (chunk.startsWith('==') && chunk.endsWith('==')) {
    return { kind: 'mark', text: chunk.slice(2, -2) };
  }
  if (chunk.startsWith('`') && chunk.endsWith('`')) {
    return { kind: 'code', text: chunk.slice(1, -1) };
  }
  if (chunk.startsWith('*') && chunk.endsWith('*')) {
    return { kind: 'italic', text: chunk.slice(1, -1) };
  }
  return { kind: 'text', text: chunk };
}

/** Parse into lines of tokens. Never throws; unmatched markers stay literal. */
export function parseRichText(src: string): RichToken[][] {
  return src.split('\n').map((line) =>
    line
      .split(TOKEN_RE)
      .filter((chunk) => chunk !== '' && chunk !== undefined)
      .map(classify),
  );
}

/** Marker-free text — for TTS, list previews, and anywhere plain text is required. */
export function richTextToPlain(src: string): string {
  return parseRichText(src)
    .map((line) => line.map((t) => t.text).join(''))
    .join('\n');
}
