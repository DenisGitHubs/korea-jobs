import { useEffect, useRef, useState } from 'react';
import { mediaSrc } from '../lib/vacancyMedia';

type Variant = 'card' | 'detail';

/**
 * Cover image of a listing (feed preview + open card). Deliberately boring:
 *   • the BOX is sized before the bytes arrive (fixed aspect-ratio + a max
 *     height), so the feed never jumps when an image paints in;
 *   • a shimmer placeholder fills that box while loading — the same primitive
 *     the feed skeleton uses;
 *   • `object-fit: cover` + token radius, so any photo proportion fits the card
 *     instead of the card fitting the photo;
 *   • `loading="lazy"` — an image far down the feed is not fetched at all;
 *   • a broken/blocked image removes the whole block (no grey ghost box).
 * No image (or a blank `image_url`) → renders nothing and the card looks exactly
 * as it does today.
 *
 * The picture is DECORATIVE here: it comes from the listing's author and its
 * content is unknown to us, so it carries an empty alt and stays out of the
 * accessibility tree — the text of the listing is the content.
 */
export function VacancyImage({
  src,
  variant = 'card',
}: {
  src: string | null | undefined;
  variant?: Variant;
}) {
  const url = mediaSrc(src);
  const ref = useRef<HTMLImageElement | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>('loading');

  // A cached image can finish loading before React attaches onLoad; `complete`
  // catches that. Also resets the state when the src changes (card → card).
  useEffect(() => {
    if (!url) return;
    setState('loading');
    const img = ref.current;
    if (img?.complete) setState(img.naturalWidth > 0 ? 'ready' : 'failed');
  }, [url]);

  if (!url || state === 'failed') return null;

  return (
    <div className={`vcimg vcimg--${variant}${state === 'loading' ? ' vcimg--busy' : ''}`}>
      <img
        ref={ref}
        className="vcimg__img"
        src={url}
        alt=""
        aria-hidden
        loading="lazy"
        decoding="async"
        draggable={false}
        onLoad={() => setState('ready')}
        onError={() => setState('failed')}
      />
    </div>
  );
}
