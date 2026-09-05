'use client';

import { useEffect, useState } from 'react';
import { useAuth } from '../../lib/auth';

/**
 * Where connecting an assistant begins — on Conciergent, in Conciergent's words.
 *
 * Claude sent the buyer straight to a raw Cognito page: an unfamiliar domain, an unexplained
 * login box, and no statement of what was about to be granted. That is precisely the shape
 * of a phishing page, and asking someone to type a password into it — moments before
 * granting software permission to place orders in their name — is asking for trust that
 * nothing on the screen has earned.
 *
 * So the authorization endpoint published in the MCP metadata is this page. It names the
 * assistant, spells out each permission in plain language, shows where the buyer will be
 * sent back to, and only then hands off to Cognito for the credentials themselves.
 *
 * It deliberately does **not** reimplement OAuth. Every parameter — `state`,
 * `code_challenge`, `redirect_uri` — is passed through untouched, because the security of
 * this exchange lives in those values and a page that rewrote any of them would be
 * substituting its own judgement for the protocol's.
 */

const HOSTED_UI = process.env.NEXT_PUBLIC_COGNITO_HOSTED_UI ?? '';

const PERMISSIONS: Record<string, { title: string; detail: string }> = {
  'catalograil/addresses.read': {
    title: 'See your saved addresses',
    detail: 'So it can tell you where an order is going before you confirm it.',
  },
  'catalograil/orders.read': {
    title: 'See your orders',
    detail: 'So “where is my order?” is answerable without leaving the conversation.',
  },
  'catalograil/orders.write': {
    title: 'Place orders for you',
    detail:
      'It can reserve an item and create an order. It cannot pay — only you can, on the ' +
      'merchant’s own payment page.',
  },
};

export default function AuthorizePage() {
  const { status, email } = useAuth();
  const [params, setParams] = useState<URLSearchParams | null>(null);

  useEffect(() => {
    setParams(new URLSearchParams(window.location.search));
  }, []);

  if (!params) return <p className="py-16 text-sm text-[hsl(var(--muted))]">Loading…</p>;

  const redirectUri = params.get('redirect_uri') ?? '';
  const scopes = (params.get('scope') ?? '').split(/[\s+]+/).filter(Boolean);

  if (!params.get('client_id') || !redirectUri) {
    return (
      <div className="py-16">
        <h1 className="text-lg font-semibold">This link is incomplete.</h1>
        <p className="mt-2 max-w-lg text-sm text-[hsl(var(--muted))]">
          It is missing the details an assistant has to send to ask for access. Start the
          connection again from your assistant rather than from this page.
        </p>
      </div>
    );
  }

  const client = describeClient(redirectUri);
  const granted = scopes.filter((s) => PERMISSIONS[s]);

  function proceed() {
    /**
     * Straight through to Cognito with the query string exactly as it arrived.
     *
     * Rebuilding it from parsed values would be the easy way to lose a parameter this page
     * does not know about — and the one it loses is the one that breaks the exchange.
     */
    window.location.href = `${HOSTED_UI.replace(/\/$/, '')}/oauth2/authorize${window.location.search}`;
  }

  return (
    <div className="mx-auto max-w-lg space-y-7 py-12">
      <div className="space-y-2">
        <p className="text-[13px] font-medium uppercase tracking-wide text-[hsl(var(--muted))]">
          Conciergent
        </p>
        <h1 className="text-2xl font-semibold tracking-tight">Connect {client.name}</h1>
        <p className="text-sm leading-relaxed text-[hsl(var(--muted))]">
          {client.name} is asking to use your Conciergent account. You will sign in next, and
          nothing is shared until you do.
        </p>
      </div>

      <div className="space-y-3 rounded-2xl border border-[hsl(var(--border))] bg-[hsl(var(--bg))] p-5">
        <p className="text-[11px] font-medium uppercase tracking-wide text-[hsl(var(--muted))]">
          It will be able to
        </p>
        {granted.length === 0 ? (
          <p className="text-sm text-[hsl(var(--muted))]">
            Sign in only. It is not asking for access to your addresses or orders.
          </p>
        ) : (
          <ul className="space-y-3">
            {granted.map((scope) => (
              <li key={scope} className="flex gap-3">
                <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-[hsl(var(--accent))]" />
                <div>
                  <p className="text-sm font-medium">{PERMISSIONS[scope]!.title}</p>
                  <p className="text-[13px] leading-relaxed text-[hsl(var(--muted))]">
                    {PERMISSIONS[scope]!.detail}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* The one thing that distinguishes this from a page pretending to be it: where you
          end up. A buyer who does not recognise this host should stop here. */}
      <p className="text-[13px] leading-relaxed text-[hsl(var(--muted))]">
        After signing in you will be sent back to <strong>{client.host}</strong>.
        {status === 'signedIn' && email ? ` You are signed in here as ${email}.` : ''}
      </p>

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={proceed}
          className="rounded-xl bg-[hsl(var(--accent))] px-4 py-2.5 text-sm font-semibold text-white transition hover:opacity-90"
        >
          Continue to sign in
        </button>
        <a href="/" className="text-sm text-[hsl(var(--muted))] underline">
          Cancel
        </a>
      </div>

      <p className="text-[12px] leading-relaxed text-[hsl(var(--muted))]">
        Conciergent never holds your money. Every payment goes to the merchant on their own
        account, and an assistant cannot complete one — it can only bring you to it.
      </p>
    </div>
  );
}

/**
 * Who is asking, from where they will be sent back to.
 *
 * The redirect URI is the only part of the request an attacker cannot forge freely — it has
 * to match what the authorization server will accept — so it is the honest thing to name
 * the caller by, rather than a `client_name` anyone can put in a registration request.
 */
function describeClient(redirectUri: string): { name: string; host: string } {
  let host = redirectUri;
  try {
    host = new URL(redirectUri).host;
  } catch {
    /* Shown as given: an unparseable redirect is itself worth seeing. */
  }

  if (host.endsWith('claude.ai') || host.endsWith('claude.com')) return { name: 'Claude', host };
  if (host.endsWith('openai.com') || host.endsWith('chatgpt.com')) return { name: 'ChatGPT', host };
  return { name: host || 'this assistant', host };
}
