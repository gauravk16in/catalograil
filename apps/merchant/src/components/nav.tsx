'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

/** T1.21's nav. "Preview in AI" is listed last because it is where a merchant ends up. */
const LINKS = [
  { href: '/products', label: 'Products' },
  { href: '/inventory', label: 'Inventory' },
  { href: '/orders', label: 'Orders' },
  { href: '/imports', label: 'Import' },
  { href: '/uploads', label: 'Uploads' },
  { href: '/policies', label: 'Policies' },
  { href: '/preview', label: 'Preview in AI' },
  { href: '/settings/payments', label: 'Payments' },
  { href: '/settings/profile', label: 'Profile' },
];

export function Nav() {
  const pathname = usePathname();

  return (
    <nav className="flex gap-1" aria-label="Main">
      {LINKS.map((link) => {
        const active = pathname === link.href || pathname.startsWith(`${link.href}/`);
        return (
          <Link
            key={link.href}
            href={link.href}
            aria-current={active ? 'page' : undefined}
            className={`rounded-lg px-3 py-1.5 text-sm font-medium transition ${
              active
                ? 'bg-[hsl(var(--accent-soft))] text-[hsl(var(--accent))]'
                : 'text-[hsl(var(--muted))] hover:bg-[hsl(var(--surface))] hover:text-[hsl(var(--text))]'
            }`}
          >
            {link.label}
          </Link>
        );
      })}
    </nav>
  );
}
