'use client';

import { useState } from 'react';
import { Badge, Button, Card, CardHeader } from '../../components/ui';

/**
 * Where a buyer gets the URL to paste into Claude or ChatGPT.
 *
 * The page is mostly explanation, deliberately. Connecting an assistant to a shopping
 * account is a genuinely unusual thing to be asked to do — the buyer is about to grant
 * software permission to spend their money — and a bare URL with a Copy button would be
 * asking for trust without earning any of it.
 *
 * So it says what will be asked for, what each permission means, and what happens at the
 * moment of purchase. Someone who reads this and decides not to connect has been served
 * better than someone who connects without understanding it.
 */

const MCP_URL =
  process.env.NEXT_PUBLIC_MCP_URL ??
  'https://ixbecsp676vjg7y5p3rhtkong40rshqa.lambda-url.ap-south-1.on.aws/';

const PERMISSIONS = [
  {
    scope: 'See your saved addresses',
    why: 'So it can tell you where an order is going before you confirm it, instead of asking you to type an address into a chat.',
  },
  {
    scope: 'See your orders',
    why: 'So “where is my order?” is answerable without you leaving the conversation.',
  },
  {
    scope: 'Place orders for you',
    why: 'So it can reserve the item and hand you a payment link. It cannot pay — only you can, and only on the merchant’s own Razorpay page.',
  },
];

export default function ConnectPage() {
  const [copied, setCopied] = useState(false);

  async function copy() {
    await navigator.clipboard.writeText(MCP_URL);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Shop from inside Claude or ChatGPT</h1>
        <p className="mt-1.5 max-w-2xl text-sm text-[hsl(var(--muted))]">
          Add Conciergent as a connector and you can find things, compare them, and order —
          without leaving the conversation. Your assistant reads the same live catalogue this
          site does.
        </p>
      </div>

      <Card>
        <CardHeader title="1. Copy this URL" description="Paste it where your assistant asks for an MCP server." />
        <div className="flex flex-wrap items-center gap-2 px-5 py-5">
          <code className="flex-1 overflow-x-auto rounded bg-[hsl(var(--accent-soft))] px-3 py-2 text-xs">
            {MCP_URL}
          </code>
          <Button type="button" onClick={copy}>
            {copied ? 'Copied' : 'Copy'}
          </Button>
        </div>
      </Card>

      <Card>
        <CardHeader
          title="2. Add it as a connector"
          description="The wording differs between the two, but the step is the same."
        />
        <div className="grid gap-5 px-5 py-5 text-sm sm:grid-cols-2">
          <div>
            <p className="font-medium">Claude</p>
            <ol className="mt-1.5 list-decimal space-y-1 pl-4 text-[hsl(var(--muted))]">
              <li>Settings → Connectors</li>
              <li>Add custom connector</li>
              <li>Paste the URL and confirm</li>
            </ol>
          </div>
          <div>
            <p className="font-medium">ChatGPT</p>
            <ol className="mt-1.5 list-decimal space-y-1 pl-4 text-[hsl(var(--muted))]">
              <li>Settings → Connectors</li>
              <li>Create, then paste the URL</li>
              <li>Confirm</li>
            </ol>
          </div>
        </div>
      </Card>

      <Card>
        <CardHeader
          title="3. Sign in and choose what it may do"
          description="Your assistant will send you to a Conciergent sign-in page. Nothing is shared until you approve it there."
        />
        <ul className="divide-y divide-[hsl(var(--border))]">
          {PERMISSIONS.map((p) => (
            <li key={p.scope} className="px-5 py-4">
              <p className="text-sm font-medium">{p.scope}</p>
              <p className="mt-0.5 text-sm text-[hsl(var(--muted))]">{p.why}</p>
            </li>
          ))}
        </ul>
        <div className="border-t border-[hsl(var(--border))] px-5 py-4">
          {/*
            Said before they connect, not after. The single most important thing a buyer can
            understand about this is that granting "place orders" does not grant spending.
          */}
          <p className="text-sm font-medium">Your assistant can never spend your money.</p>
          <p className="mt-1 text-sm text-[hsl(var(--muted))]">
            Placing an order reserves the item and produces a payment link. You open it, and you
            pay the merchant directly on their own Razorpay page — Conciergent never holds your
            money and never sees your card. If you do not pay, the reservation is released after
            twenty minutes and nothing is charged.
          </p>
        </div>
      </Card>

      <Card>
        <CardHeader title="Then just ask" description="No special phrasing needed." />
        <ul className="space-y-2 px-5 py-5 text-sm">
          {[
            'a formal shirt for an office in Chennai, under ₹2500',
            'something to record my drive — compare the top three',
            'what is the return policy on that one?',
            'order the size 42 in white to my home address',
            'where is my order ORD-7K2M9X?',
          ].map((example) => (
            <li key={example} className="flex items-start gap-2">
              <Badge tone="neutral">ask</Badge>
              <span className="text-[hsl(var(--muted))]">“{example}”</span>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
