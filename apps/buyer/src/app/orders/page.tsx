'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api, describeError } from '../../lib/api';
import { formatPaise, relativeTime } from '../../lib/format';
import { Badge, Button, Card, Empty, ErrorNote } from '../../components/ui';
import { useAuth } from '../../lib/auth';

interface Order {
  id: string;
  orderNumber: string | null;
  status: string;
  totalPaise: string;
  createdAt: string;
}

const TONE: Record<string, 'accent' | 'warn' | 'danger' | 'neutral'> = {
  delivered: 'accent',
  shipped: 'accent',
  packed: 'accent',
  confirmed: 'accent',
  paid: 'warn',
  awaiting_payment: 'warn',
  cancelled: 'danger',
  refunded: 'danger',
  failed: 'danger',
};

/** What each status means to the person waiting for the parcel, not to the merchant. */
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

export default function OrdersPage() {
  const { status } = useAuth();
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
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

  if (status === 'signedOut') {
    return (
      <Card>
        <Empty title="Sign in to see your orders" reason="Your order history lives with your account." />
        <div className="px-5 pb-5">
          <Button>
            <Link href="/login">Sign in</Link>
          </Button>
        </div>
      </Card>
    );
  }

  if (loading) return <p className="py-10 text-sm text-[hsl(var(--muted))]">Loading…</p>;

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold tracking-tight">Your orders</h1>
      {error && <ErrorNote>{error}</ErrorNote>}

      <Card>
        {orders.length === 0 ? (
          <Empty
            title="No orders yet"
            reason="Anything you buy — here or from inside Claude and ChatGPT — appears here."
          />
        ) : (
          <ul className="divide-y divide-[hsl(var(--border))]">
            {orders.map((order) => (
              <li key={order.id} className="flex items-center gap-4 px-5 py-4">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-xs">{order.orderNumber ?? order.id.slice(0, 8)}</span>
                    <Badge tone={TONE[order.status] ?? 'neutral'}>{order.status}</Badge>
                  </div>
                  <p className="mt-0.5 text-sm text-[hsl(var(--muted))]">
                    {MEANING[order.status] ?? ''} · {relativeTime(order.createdAt)}
                  </p>
                </div>
                <span className="shrink-0 text-sm font-medium tabular-nums">
                  {formatPaise(order.totalPaise)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
