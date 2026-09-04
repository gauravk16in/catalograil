'use client';

/** App Router error boundary. Its absence sends the export to the Pages error page. */
export default function Error({ reset }: { error: Error; reset: () => void }) {
  return (
    <div className="py-16 text-center">
      <h1 className="text-lg font-semibold">Something went wrong</h1>
      <p className="mt-2 text-sm text-[hsl(var(--muted))]">
        The page failed to load. Trying again often resolves it.
      </p>
      <button type="button" onClick={reset} className="mt-4 text-sm underline">
        Try again
      </button>
    </div>
  );
}
