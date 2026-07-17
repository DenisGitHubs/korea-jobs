import type { ReactNode } from 'react';
import type { LegalBlock, LegalDoc as LegalDocData } from '../content/legal/types';

/**
 * Render `**bold**` spans inline. Single-asterisk placeholders such as `*[...]*`
 * are NOT matched, so they render literally and stay visible for the owner.
 */
function inline(text: string): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*)/g).map((part, i) =>
    part.startsWith('**') && part.endsWith('**') ? (
      <strong key={i}>{part.slice(2, -2)}</strong>
    ) : (
      <span key={i}>{part}</span>
    ),
  );
}

function Block({ block }: { block: LegalBlock }) {
  if (block.type === 'p') return <p className="legal__p">{inline(block.text)}</p>;
  const items = block.items.map((it, i) => <li key={i}>{inline(it)}</li>);
  return block.type === 'ol' ? (
    <ol className="legal__list legal__list--ol">{items}</ol>
  ) : (
    <ul className="legal__list">{items}</ul>
  );
}

/** Presentational renderer for a structured legal document (Privacy / Rules). */
export function LegalDoc({ doc }: { doc: LegalDocData }) {
  return (
    <div className="legal">
      <div className="legal__draft" role="note">
        {doc.draftNote}
      </div>
      <p className="legal__meta">{doc.meta}</p>
      {doc.sections.map((s, i) => (
        <section className="legal__section" key={i}>
          {s.heading ? <h2 className="legal__h">{s.heading}</h2> : null}
          {s.blocks.map((b, j) => (
            <Block key={j} block={b} />
          ))}
        </section>
      ))}
    </div>
  );
}
