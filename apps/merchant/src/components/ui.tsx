import type { ReactNode } from 'react';

/**
 * The dashboard's small set of primitives.
 *
 * Deliberately few and deliberately plain. A merchant tool is judged on whether the
 * numbers are right and the state is obvious, not on ornament, and every extra variant
 * here is one more thing that can look subtly different on two screens.
 */

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={`rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--bg))] ${className}`}
    >
      {children}
    </div>
  );
}

export function CardHeader({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-[hsl(var(--border))] px-5 py-4">
      <div>
        <h2 className="text-sm font-semibold">{title}</h2>
        {description && <p className="mt-0.5 text-sm text-[hsl(var(--muted))]">{description}</p>}
      </div>
      {action}
    </div>
  );
}

type Tone = 'neutral' | 'ok' | 'warn' | 'danger' | 'accent';

const TONES: Record<Tone, string> = {
  neutral: 'bg-[hsl(var(--surface))] text-[hsl(var(--muted))] border-[hsl(var(--border))]',
  ok: 'bg-[hsl(var(--ok-soft))] text-[hsl(var(--ok))] border-transparent',
  warn: 'bg-[hsl(var(--warn-soft))] text-[hsl(var(--warn))] border-transparent',
  danger: 'bg-[hsl(var(--danger-soft))] text-[hsl(var(--danger))] border-transparent',
  accent: 'bg-[hsl(var(--accent-soft))] text-[hsl(var(--accent))] border-transparent',
};

export function Badge({ children, tone = 'neutral' }: { children: ReactNode; tone?: Tone }) {
  return (
    <span
      className={`inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium ${TONES[tone]}`}
    >
      {children}
    </span>
  );
}

export function Button({
  children,
  variant = 'primary',
  ...props
}: {
  children: ReactNode;
  variant?: 'primary' | 'secondary' | 'danger';
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  const styles = {
    primary: 'bg-[hsl(var(--accent))] text-white hover:opacity-90',
    secondary:
      'border border-[hsl(var(--border))] bg-[hsl(var(--bg))] hover:bg-[hsl(var(--surface))]',
    danger:
      'border border-[hsl(var(--danger))] text-[hsl(var(--danger))] hover:bg-[hsl(var(--danger-soft))]',
  }[variant];

  return (
    <button
      {...props}
      className={`inline-flex items-center justify-center rounded-lg px-3.5 py-2 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-50 ${styles} ${props.className ?? ''}`}
    >
      {children}
    </button>
  );
}

export function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: string;
  error?: string;
  children: ReactNode;
}) {
  return (
    <label className="block">
      <span className="text-sm font-medium">{label}</span>
      {hint && <span className="mt-0.5 block text-xs text-[hsl(var(--muted))]">{hint}</span>}
      <div className="mt-1.5">{children}</div>
      {error && <span className="mt-1 block text-xs text-[hsl(var(--danger))]">{error}</span>}
    </label>
  );
}

export const inputClass =
  'w-full rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--bg))] px-3 py-2 text-sm placeholder:text-[hsl(var(--muted))]';

/**
 * The empty state carries the reason, not just the absence.
 *
 * The same principle as rule 8 in the search API: telling someone nothing was found is
 * only half an answer, and the useful half is why.
 */
export function Empty({
  title,
  reason,
  action,
}: {
  title: string;
  reason?: string;
  action?: ReactNode;
}) {
  return (
    <div className="px-5 py-12 text-center">
      <p className="text-sm font-medium">{title}</p>
      {reason && <p className="mx-auto mt-1 max-w-md text-sm text-[hsl(var(--muted))]">{reason}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function ErrorNote({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-lg border border-[hsl(var(--danger))] bg-[hsl(var(--danger-soft))] px-3.5 py-2.5 text-sm text-[hsl(var(--danger))]">
      {children}
    </div>
  );
}
