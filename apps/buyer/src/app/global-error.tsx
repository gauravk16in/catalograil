'use client';

/**
 * The last-resort boundary, for a failure in the root layout itself.
 *
 * It renders its own <html> and <body> because at this point the layout that would have
 * provided them is the thing that failed.
 */
export default function GlobalError({ reset }: { error: Error; reset: () => void }) {
  return (
    <html lang="en">
      <body style={{ fontFamily: 'system-ui, sans-serif', padding: '4rem', textAlign: 'center' }}>
        <h1 style={{ fontSize: '1.125rem', fontWeight: 600 }}>Something went wrong</h1>
        <button type="button" onClick={reset} style={{ marginTop: '1rem', textDecoration: 'underline' }}>
          Try again
        </button>
      </body>
    </html>
  );
}
