import Link from 'next/link';
import { Badge, Button, Card, CardHeader } from '../components/ui';

/**
 * The onboarding wizard's entry point (T1.22).
 *
 * A merchant landing here has not connected Razorpay yet, so the page's job is to explain
 * what connecting means before asking for it — the authorisation grants us the ability to
 * create payments on their account, and someone should know that before clicking.
 */
export default function Home() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">
          Get your catalogue into AI assistants
        </h1>
        <p className="mt-1.5 max-w-2xl text-sm text-[hsl(var(--muted))]">
          Buyers describe what they need inside Claude or ChatGPT, and your products appear as
          answers. Payments go straight to your own Razorpay account — we never hold your money and
          take no commission.
        </p>
      </div>

      <Card>
        <CardHeader
          title="Step 1 — Connect Razorpay"
          description="Authorises CatalogRail to create orders and payment links on your account, so buyers pay you directly."
        />
        <div className="space-y-4 px-5 py-5">
          <ul className="space-y-2 text-sm text-[hsl(var(--muted))]">
            <li>• You stay the merchant of record on every sale.</li>
            <li>• We never hold funds, and there is no commission.</li>
            <li>• You can revoke access at any time from Settings.</li>
          </ul>
          <Button
            onClick={undefined}
            className="w-fit"
            // A plain link rather than a fetch: the OAuth start endpoint issues a redirect,
            // and following it in JavaScript would lose the browser navigation it depends on.
          >
            <a href="/api/oauth/start">Connect with Razorpay</a>
          </Button>
        </div>
      </Card>

      <div className="grid gap-4 sm:grid-cols-3">
        <StepCard
          step="2"
          title="Add your products"
          body="Upload a CSV or add products one at a time. We work out the categories and search metadata."
          href="/products"
        />
        <StepCard
          step="3"
          title="Publish your policies"
          body="Refund, terms and fulfillment URLs. Required — buyers rely on them, and we snapshot them onto every order."
          href="/policies"
        />
        <StepCard
          step="4"
          title="See how you rank"
          body="Type what a shopper would ask and see exactly where your products land, and why."
          href="/preview"
        />
      </div>
    </div>
  );
}

function StepCard({
  step,
  title,
  body,
  href,
}: {
  step: string;
  title: string;
  body: string;
  href: string;
}) {
  return (
    <Card className="p-5">
      <Badge>Step {step}</Badge>
      <h3 className="mt-3 text-sm font-semibold">{title}</h3>
      <p className="mt-1 text-sm text-[hsl(var(--muted))]">{body}</p>
      <Link href={href} className="mt-3 inline-block text-sm font-medium text-[hsl(var(--accent))]">
        Open →
      </Link>
    </Card>
  );
}
