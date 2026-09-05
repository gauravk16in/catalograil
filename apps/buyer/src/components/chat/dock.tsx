'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

/**
 * The floating dock.
 *
 * The conversation is the surface, so navigation cannot sit in a bar across the top
 * competing with it for attention. It sits at the bottom, out of the reading line, and
 * grows a label only on hover — an icon row that shouts its own names is the thing you end
 * up looking at instead of the answer.
 */

const ITEMS = [
  { href: '/', label: 'Ask', icon: Circle },
  { href: '/orders', label: 'Orders', icon: Diamond },
  { href: '/account', label: 'Account', icon: Dot },
  { href: '/connect', label: 'Connect', icon: Square },
];

export function Dock() {
  const pathname = usePathname();

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-5 z-30 flex justify-center">
      <nav className="pointer-events-auto flex items-center gap-1 rounded-full border border-[hsl(var(--border))] bg-[hsl(var(--bg))]/85 p-1.5 shadow-lg backdrop-blur">
        {ITEMS.map((item) => {
          const active = pathname === item.href;
          const Icon = item.icon;
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-label={item.label}
              aria-current={active ? 'page' : undefined}
              className={`group relative grid h-10 w-10 place-items-center rounded-full transition ${
                active
                  ? 'bg-[hsl(var(--accent-soft))] text-[hsl(var(--accent))]'
                  : 'text-[hsl(var(--muted))] hover:bg-[hsl(var(--surface))] hover:text-[hsl(var(--text))]'
              }`}
            >
              <Icon />
              <span className="pointer-events-none absolute -top-9 whitespace-nowrap rounded-md bg-[hsl(var(--text))] px-2 py-1 text-[11px] font-medium text-white opacity-0 transition group-hover:opacity-100">
                {item.label}
              </span>
            </Link>
          );
        })}
      </nav>
    </div>
  );
}

/* Four plain marks rather than a pictographic set: they read as one family at 18px, which
   a mixed bag of literal icons does not. */
const stroke = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.6 } as const;

function Circle() {
  return (
    <svg viewBox="0 0 24 24" className="h-[18px] w-[18px]" {...stroke}>
      <circle cx="12" cy="12" r="7.5" />
    </svg>
  );
}
function Diamond() {
  return (
    <svg viewBox="0 0 24 24" className="h-[18px] w-[18px]" {...stroke}>
      <rect x="12" y="3.5" width="12" height="12" rx="2" transform="rotate(45 12 3.5)" />
    </svg>
  );
}
function Dot() {
  return (
    <svg viewBox="0 0 24 24" className="h-[18px] w-[18px]" {...stroke}>
      <circle cx="12" cy="12" r="7.5" strokeDasharray="3 3" />
    </svg>
  );
}
function Square() {
  return (
    <svg viewBox="0 0 24 24" className="h-[18px] w-[18px]" {...stroke}>
      <rect x="4.5" y="4.5" width="15" height="15" rx="3.5" />
    </svg>
  );
}
