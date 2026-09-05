'use client';

import type { ReactNode } from 'react';

/**
 * A gradient that travels the border of whatever it wraps.
 *
 * CSS and a single conic gradient rather than WebGL. The effect libraries reach for a canvas
 * for this, which buys a richer look and costs a context, a render loop and a blank frame on
 * first paint — on a search box that is the first thing a buyer sees, the blank frame is the
 * more expensive half. This animates on the compositor and does nothing when idle.
 *
 * `prefers-reduced-motion` stops it entirely: a moving border is decoration, and decoration
 * is exactly what should stop for someone who asked for less movement.
 */
export function Glow({
  active = false,
  className = '',
  children,
}: {
  active?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={`cr-glow ${active ? 'cr-glow-on' : ''} ${className}`}>
      <div className="cr-glow-inner">{children}</div>
    </div>
  );
}
