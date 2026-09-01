import { Fragment } from 'react';
import { parseRichText } from '@/engine/richtext';

/**
 * Renders the app's tiny mnemonic markup. Tokens, never HTML — notes can come
 * from AI output, imports and packets, and none of those get to inject markup.
 */
export function RichText({ src, className = '' }: { src: string; className?: string }) {
  const lines = parseRichText(src);
  return (
    <span className={className}>
      {lines.map((line, li) => (
        <Fragment key={li}>
          {li > 0 && <br />}
          {line.map((t, ti) => {
            switch (t.kind) {
              case 'bold':
                return (
                  <strong key={ti} className="font-semibold text-slate-100">
                    {t.text}
                  </strong>
                );
              case 'italic':
                return (
                  <em key={ti} className="italic">
                    {t.text}
                  </em>
                );
              case 'mark':
                return (
                  <mark key={ti} className="rounded bg-violet-500/25 px-1 text-violet-100">
                    {t.text}
                  </mark>
                );
              case 'code':
                return (
                  <code key={ti} className="rounded bg-slate-800 px-1 font-mono text-[0.9em]">
                    {t.text}
                  </code>
                );
              default:
                return <Fragment key={ti}>{t.text}</Fragment>;
            }
          })}
        </Fragment>
      ))}
    </span>
  );
}

export const RICHTEXT_HELP = '**bold** · *italic* · ==highlight== · `code`';
