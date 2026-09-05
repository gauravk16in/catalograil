'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Nav } from './nav';
import { Dock } from './chat/dock';

/**
 * The frame, which gets out of the way on the one page that is the product.
 *
 * Everywhere else — orders, account, checkout — is a document and wants a header and a
 * column of readable width. The ask surface is not a document: it is a conversation with a
 * lot of deliberate emptiness around it, and a bar across the top competing for the first
 * thing you look at is exactly what that design cannot have. The dock carries navigation
 * there instead.
 */
export function Shell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const bare = pathname === '/';

  return (
    <>
      {!bare && (
        <header className="border-b border-[hsl(var(--border))] bg-[hsl(var(--bg))]">
          <div className="mx-auto flex h-14 max-w-4xl items-center gap-6 px-6">
            <Link href="/" className="text-sm font-semibold tracking-tight">
              Conciergent
            </Link>
            <Nav />
          </div>
        </header>
      )}

      <main className={bare ? '' : 'mx-auto max-w-4xl px-6 py-8 pb-28'}>{children}</main>

      <Dock />
    </>
  );
}
