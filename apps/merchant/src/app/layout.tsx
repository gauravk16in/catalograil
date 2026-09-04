import type { Metadata } from 'next';
import Link from 'next/link';
import { Nav } from '../components/nav';
import { RequireAuth } from '../components/require-auth';
import { AccountMenu } from '../components/account-menu';
import { AuthProvider } from '../lib/auth';
import './globals.css';

export const metadata: Metadata = {
  title: 'CatalogRail — Merchant',
  description: 'List your catalogue and reach buyers inside Claude and ChatGPT.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen">
        <AuthProvider>
          <header className="border-b border-[hsl(var(--border))] bg-[hsl(var(--bg))]">
            <div className="mx-auto flex h-14 max-w-6xl items-center gap-6 px-6">
              <Link href="/" className="text-sm font-semibold tracking-tight">
                CatalogRail
              </Link>
              <Nav />
              <AccountMenu />
            </div>
          </header>
          <main className="mx-auto max-w-6xl px-6 py-8">
            <RequireAuth>{children}</RequireAuth>
          </main>
        </AuthProvider>
      </body>
    </html>
  );
}
