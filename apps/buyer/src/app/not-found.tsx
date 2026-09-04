import Link from 'next/link';

/**
 * An App Router 404.
 *
 * Without one, a static export falls back to the Pages Router error page, which imports
 * `next/document` and fails the build with a message about `<Html>` that names nothing
 * relevant to this app.
 */
export default function NotFound() {
  return (
    <div className="py-16 text-center">
      <h1 className="text-lg font-semibold">Page not found</h1>
      <p className="mt-2 text-sm text-[hsl(var(--muted))]">
        That page does not exist, or has moved.
      </p>
      <Link href="/" className="mt-4 inline-block text-sm underline">
        Back to the dashboard
      </Link>
    </div>
  );
}
