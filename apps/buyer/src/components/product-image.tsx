'use client';

import { useState } from 'react';

/**
 * A product image that degrades honestly.
 *
 * Merchant images are arbitrary external URLs we do not host and cannot guarantee — a
 * catalogue imported from a CSV routinely carries links that 404, expire, or point at a
 * placeholder the merchant never replaced. A broken-image icon makes the *product* look
 * broken, and a buyer skims past it.
 *
 * So a failure falls back to the product's initials on a plain ground: unmistakably "no
 * photo" rather than "something went wrong", and it takes the same space so nothing shifts.
 */
export function ProductImage({
  src,
  alt,
  className = '',
}: {
  src?: string | undefined;
  alt: string;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);

  if (!src || failed) {
    const initials = alt
      .split(/\s+/)
      .slice(0, 2)
      .map((word) => word[0] ?? '')
      .join('')
      .toUpperCase();

    return (
      <div
        className={`flex items-center justify-center bg-[hsl(var(--accent-soft))] text-sm font-medium text-[hsl(var(--muted))] ${className}`}
        aria-label={`No photo for ${alt}`}
      >
        {initials || '—'}
      </div>
    );
  }

  return (
    /* A plain <img>: these are arbitrary merchant domains, and next/image would need every
       one allow-listed in advance. */
    <img
      src={src}
      alt={alt}
      loading="lazy"
      onError={() => setFailed(true)}
      className={`object-cover ${className}`}
    />
  );
}
