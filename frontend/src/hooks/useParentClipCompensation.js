import { useEffect } from 'react';

// GHL sizes the custom-page iframe as calc(100vh - 96px) but offsets it further
// down when its dismissible notification banner is showing (banner height gets
// added to the offset without being subtracted from the iframe height), so the
// bottom ~50px of the app hangs below the browser viewport and the outer page
// cannot scroll to it — permanently clipped.
//
// A cross-origin iframe can't read its own position in the parent page, but
// IntersectionObserver with the implicit root intersects against the TOP-LEVEL
// viewport by spec, even from inside a cross-origin iframe. Observing a
// fixed full-viewport sentinel therefore tells us exactly how many pixels of
// the iframe are cut off at the bottom. We publish that as a CSS variable
// (--bb-clip-bottom) that the layout, the feedback launcher, and the toast
// viewport add to their bottom spacing, keeping everything reachable whether
// or not GHL's banner is up (the observer re-fires when the banner is
// dismissed and the iframe shifts back up).
export default function useParentClipCompensation(enabled) {
  useEffect(() => {
    if (!enabled || typeof IntersectionObserver === 'undefined') return undefined;

    const sentinel = document.createElement('div');
    sentinel.setAttribute('aria-hidden', 'true');
    Object.assign(sentinel.style, {
      position: 'fixed',
      inset: '0',
      pointerEvents: 'none',
      visibility: 'hidden',
    });
    document.body.appendChild(sentinel);

    // 1%-step thresholds so the observer re-fires on any meaningful geometry
    // change (window resize, GHL banner dismissed). The exact clip comes from
    // the rects, not the ratio.
    const thresholds = Array.from({ length: 101 }, (_, i) => i / 100);
    const io = new IntersectionObserver(
      (entries) => {
        const e = entries[entries.length - 1];
        // Pixels of the sentinel (== iframe viewport) below the real viewport.
        const clipped = e.intersectionRatio > 0
          ? Math.max(0, e.boundingClientRect.bottom - e.intersectionRect.bottom)
          : 0;
        // Round up a little so the padding always errs on the generous side.
        const px = Math.ceil(clipped / 4) * 4;
        document.documentElement.style.setProperty('--bb-clip-bottom', `${px}px`);
      },
      { threshold: thresholds },
    );
    io.observe(sentinel);

    return () => {
      io.disconnect();
      sentinel.remove();
      document.documentElement.style.removeProperty('--bb-clip-bottom');
    };
  }, [enabled]);
}
