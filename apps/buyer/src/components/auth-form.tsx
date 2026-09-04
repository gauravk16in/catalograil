'use client';

import type { ReactNode } from 'react';
import { Button, Card, ErrorNote, Field, inputClass } from './ui';

/**
 * The shared shell for the five auth screens.
 *
 * They differ only in their fields and their submit, so the layout, the error placement
 * and the busy state live here — five near-identical copies is how the screens drift and
 * one of them ends up showing errors somewhere the others do not.
 */
export function AuthCard({
  title,
  description,
  error,
  notice,
  submitLabel,
  busy,
  onSubmit,
  children,
  footer,
}: {
  title: string;
  description: string;
  error?: string | null;
  notice?: string | null;
  submitLabel: string;
  busy: boolean;
  onSubmit: (event: React.FormEvent) => void;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <div className="mx-auto max-w-md py-10">
      <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
      <p className="mt-1.5 text-sm text-[hsl(var(--muted))]">{description}</p>

      <Card className="mt-6">
        <form onSubmit={onSubmit} className="space-y-4 px-5 py-5">
          {children}
          {error && <ErrorNote>{error}</ErrorNote>}
          {notice && (
            <p className="rounded-md bg-[hsl(var(--accent-soft))] px-3 py-2 text-sm">{notice}</p>
          )}
          <Button type="submit" disabled={busy}>
            {busy ? 'Working…' : submitLabel}
          </Button>
        </form>
      </Card>

      {footer && <div className="mt-4 text-sm text-[hsl(var(--muted))]">{footer}</div>}
    </div>
  );
}

export function TextField({
  label,
  hint,
  type = 'text',
  value,
  onChange,
  autoComplete,
  placeholder,
}: {
  label: string;
  hint?: string;
  type?: string;
  value: string;
  onChange: (value: string) => void;
  autoComplete?: string;
  placeholder?: string;
}) {
  return (
    <Field label={label} {...(hint ? { hint } : {})}>
      <input
        className={inputClass}
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        {...(autoComplete ? { autoComplete } : {})}
        {...(placeholder ? { placeholder } : {})}
      />
    </Field>
  );
}

/**
 * Cognito's messages are written for developers. These are the ones a merchant will
 * actually hit, rewritten to say what to do next; anything unrecognised passes through
 * rather than being flattened into a generic apology that hides a real cause.
 */
export function describeAuthError(err: unknown): string {
  const name = (err as { name?: string })?.name ?? '';
  const message = (err as { message?: string })?.message ?? 'Something went wrong.';

  switch (name) {
    case 'UserNotFoundException':
    case 'NotAuthorizedException':
      // Deliberately identical for both: distinguishing them tells an attacker which
      // addresses have accounts.
      return 'That email and password do not match.';
    case 'UsernameExistsException':
      return 'An account already exists for this email. Try signing in, or reset your password.';
    case 'UserNotConfirmedException':
      return 'This account still needs its email verified. Check your inbox for the code.';
    case 'CodeMismatchException':
      return 'That code is not right. Check it and try again.';
    case 'ExpiredCodeException':
      return 'That code has expired. Request a new one.';
    case 'InvalidPasswordException':
      return 'Password needs at least 10 characters, with an uppercase letter, a lowercase letter and a digit.';
    case 'InvalidParameterException':
      // Almost always a phone number without the country code.
      return 'Check the details — a phone number needs its country code, like +919876543210.';
    case 'LimitExceededException':
    case 'TooManyRequestsException':
      return 'Too many attempts. Wait a minute and try again.';
    default:
      return message;
  }
}
