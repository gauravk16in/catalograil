'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { api, describeError } from '../../lib/api';
import { formatIst, formatPaise, relativeTime } from '../../lib/format';
import { Empty, ErrorNote } from '../../components/ui';
import { useAuth } from '../../lib/auth';

/**
 * The orders page, which used to be a table of statuses.
 *
 * A list of order numbers and state names is a database view. The questions someone
 * actually arrives with are "where is my thing", "what did I buy", and "who has my money" —
 * and none of them were answered on a screen that had room for all three.
 *
 * So each order shows what is in it, who is fulfilling it, and how far along it is on a
 * track a person can read at a glance. An order still waiting for payment gets the one
 * thing that fixes it rather than a note saying it is stuck.
 */

interface OrderItem {
  productId: string | null;
  name: string;
  options: Record<string, string>;
  quantity: number;
  lineTotalPaise: string;
}

interface Order {
  id: string;
  orderNumber: string | null;
  status: string;
  totalPaise: string;
  createdAt: string;
  merchantName: string | null;
  paymentLinkUrl: string | null;
  items: OrderItem[];
}

/** The journey a parcel actually takes, as the buyer experiences it. */
const TRACK = ['paid', 'confirmed', 'packed', 'shipped', 'delivered'] as const;

const MEANING: Record<string, string> = {
  awaiting_payment: 'Waiting for your payment to complete.',
  paid: 'Paid. The seller has not acknowledged it yet.',
  confirmed: 'The seller has accepted your order.',
  packed: 'Packed and waiting for pickup.',
  shipped: 'On its way.',
  delivered: 'Delivered.',
  cancelled: 'Cancelled.',
  refunded: 'Refunded.',
  failed: 'Payment did not go through.',
};

const ENDED = new Set(['cancelled', 'refunded', 'failed']);

export default function OrdersPage() {
  const { status } = useAuth();
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (status === 'loading') return;
    if (status !== 'signedIn') {
      setLoading(false);
      return;
    }
    api
      .get<{ orders: Order[] }>('/buyer/orders')
      .then((r) => setOrders(r.orders))
      .catch((err) => setError(describeError(err)))
      .finally(() => setLoading(false));
  }, [status]);

  /**
   * Three numbers, and only ones that are true.
   *
   * "Spent" counts orders that were actually paid for — an order sitting at
   * `awaiting_payment` is not money anyone has spent, and a total that includes it would be
   * a number the buyer could disprove from their own bank statement.
   */
  const summary = useMemo(() => {
    const paid = orders.filter((o) => !ENDED.has(o.status) && o.status !== 'awaiting_payment');
    const spent = paid.reduce((total, o) => total + BigInt(o.totalPaise || '0'), 0n);
    return {
      spent: spent.toString(),
      inFlight: orders.filter((o) => ['paid', 'confirmed', 'packed', 'shipped'].includes(o.status))
        .length,
      unpaid: orders.filter((o) => o.status === 'awaiting_payment').length,
    };
  }, [orders]);

  if (status === 'signedOut') {
    return (
      <div className="rounded-2xl border border-[hsl(var(--border))] bg-[hsl(var(--bg))]">
        <Empty
          title="Sign in to see your orders"
          reason="Your order history lives with your account — including anything bought from inside Claude or ChatGPT."
        />
        <div className="px-5 pb-6 text-center">
          <Link
            href="/login"
            className="inline-block rounded-xl bg-[hsl(var(--accent))] px-4 py-2 text-sm font-semibold text-white"
          >
            Sign in
          </Link>
        </div>
      </div>
    );
  }

  if (loading) return <p className="py-10 text-sm text-[hsl(var(--muted))]">Loading…</p>;

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold tracking-tight">Your orders</h1>
      {error && <ErrorNote>{error}</ErrorNote>}

      {orders.length > 0 && (
        <div className="grid grid-cols-3 gap-3">
          <Stat label="Spent" value={formatPaise(summary.spent)} />
          <Stat label="On the way" value={String(summary.inFlight)} />
          <Stat
            label="Needs payment"
            value={String(summary.unpaid)}
            tone={summary.unpaid > 0 ? 'warn' : 'neutral'}
          />
        </div>
      )}

      {orders.length === 0 ? (
        <div className="rounded-2xl border border-[hsl(var(--border))] bg-[hsl(var(--bg))]">
          <Empty
            title="No orders yet"
            reason="Anything you buy — here or from inside Claude and ChatGPT — appears here."
            action={
              <Link href="/" className="text-sm underline">
                Ask for something
              </Link>
            }
          />
        </div>
      ) : (
        <ul className="space-y-3">
          {orders.map((order) => (
            <OrderCard key={order.id} order={order} />
          ))}
        </ul>
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  tone = 'neutral',
}: {
  label: string;
  value: string;
  tone?: 'neutral' | 'warn';
}) {
  return (
    <div
      className={`rounded-2xl border px-4 py-3 ${
        tone === 'warn'
          ? 'border-transparent bg-[hsl(var(--warn-soft))]'
          : 'border-[hsl(var(--border))] bg-[hsl(var(--bg))]'
      }`}
    >
      <p className="text-[11px] font-medium uppercase tracking-wide text-[hsl(var(--muted))]">
        {label}
      </p>
      <p
        className={`mt-1 text-lg font-semibold tabular-nums ${
          tone === 'warn' ? 'text-[hsl(var(--warn))]' : ''
        }`}
      >
        {value}
      </p>
    </div>
  );
}

function OrderCard({ order }: { order: Order }) {
  const [open, setOpen] = useState(false);
  const ended = ENDED.has(order.status);
  const reached = TRACK.indexOf(order.status as (typeof TRACK)[number]);

  return (
    <li className="overflow-hidden rounded-2xl border border-[hsl(var(--border))] bg-[hsl(var(--bg))]">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-start gap-4 px-5 py-4 text-left"
      >
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-xs text-[hsl(var(--muted))]">
              {order.orderNumber ?? order.id.slice(0, 8)}
            </span>
            {order.merchantName && <span className="text-sm font-medium">{order.merchantName}</span>}
          </div>
          <p className="truncate text-sm text-[hsl(var(--muted))]">
            {order.items.length > 0
              ? order.items.map((i) => `${i.name}${i.quantity > 1 ? ` ×${i.quantity}` : ''}`).join(', ')
              : (MEANING[order.status] ?? order.status)}
          </p>
          <p className="text-xs text-[hsl(var(--muted))]">
            {relativeTime(order.createdAt)} · {MEANING[order.status] ?? order.status}
          </p>
        </div>
        <span className="shrink-0 text-sm font-semibold tabular-nums">
          {formatPaise(order.totalPaise)}
        </span>
      </button>

      {/* The track, drawn only where it applies. A cancelled order has no position on a
          journey it left, and pretending otherwise is the kind of cheerful UI that makes
          people distrust the rest of the page. */}
      {!ended && order.status !== 'awaiting_payment' && (
        <div className="flex items-center gap-1 px-5 pb-4">
          {TRACK.map((step, index) => (
            <div key={step} className="flex flex-1 items-center gap-1">
              <div
                className={`h-1 flex-1 rounded-full ${
                  index <= reached ? 'bg-[hsl(var(--ok))]' : 'bg-[hsl(var(--border))]'
                }`}
              />
            </div>
          ))}
        </div>
      )}

      {!ended && order.status !== 'awaiting_payment' && (
        <div className="flex justify-between px-5 pb-4 text-[10px] uppercase tracking-wide text-[hsl(var(--muted))]">
          {TRACK.map((step, index) => (
            <span key={step} className={index <= reached ? 'text-[hsl(var(--ok))]' : ''}>
              {step}
            </span>
          ))}
        </div>
      )}

      {order.status === 'awaiting_payment' && order.paymentLinkUrl && (
        <div className="border-t border-[hsl(var(--border))] bg-[hsl(var(--warn-soft))] px-5 py-3">
          <a
            href={order.paymentLinkUrl}
            className="text-sm font-semibold text-[hsl(var(--warn))] underline"
          >
            Complete the payment
          </a>
          <p className="mt-0.5 text-xs text-[hsl(var(--warn))]">
            Nothing has been charged yet, and the seller is not preparing it until it is.
          </p>
        </div>
      )}

      {open && (
        <div className="cr-rise space-y-3 border-t border-[hsl(var(--border))] px-5 py-4">
          <p className="text-xs text-[hsl(var(--muted))]">Placed {formatIst(order.createdAt)}</p>
          {order.items.map((item, index) => (
            <div key={`${item.productId}-${index}`} className="flex items-baseline justify-between gap-4">
              <div className="min-w-0">
                {item.productId ? (
                  <Link href={`/p/${item.productId}`} className="text-sm underline">
                    {item.name}
                  </Link>
                ) : (
                  <span className="text-sm">{item.name}</span>
                )}
                <p className="text-xs text-[hsl(var(--muted))]">
                  {Object.values(item.options ?? {}).join(' · ')}
                  {item.quantity > 1 ? ` · ${item.quantity} of them` : ''}
                </p>
              </div>
              <span className="shrink-0 text-sm tabular-nums">
                {formatPaise(item.lineTotalPaise)}
              </span>
            </div>
          ))}
          {/* The names are what the merchant listed at the time of purchase, not what the
              listing says today — a price or a title that changed later must not rewrite
              what someone agreed to buy. */}
          <p className="text-[11px] text-[hsl(var(--muted))]">
            Shown as they were when you ordered.
          </p>
        </div>
      )}
    </li>
  );
}
