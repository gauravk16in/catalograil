import type { Metadata } from 'next';
import Link from 'next/link';
import { Nav } from '../components/nav';
import { AuthProvider } from '../lib/auth';
import './globals.css';

export const metadata: Metadata = {
  title: 'Conciergent',
  description: 'Buy directly from Indian merchants, from inside your chat.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen">
        <AuthProvider>
          <header className="border-b border-[hsl(var(--border))] bg-[hsl(var(--bg))]">
            <div className="mx-auto flex h-14 max-w-4xl items-center gap-6 px-6">
              <Link href="/" className="text-sm font-semibold tracking-tight">
                Conciergent
              </Link>
              <Nav />
            </div>
          </header>
          <main className="mx-auto max-w-4xl px-6 py-8">{children}</main>
        </AuthProvider>
      </body>
    </html>
  );
}
