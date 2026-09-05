'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, describeError } from '../../lib/api';
import { formatPaise, relativeTime } from '../../lib/format';
import { Badge, Button, Card, CardHeader, Empty, ErrorNote, inputClass } from '../../components/ui';

/**
 * S6.3 — orders.
 *
 * Sorted so the ones costing the merchant something appear first. A paid order that has sat
 * unacknowledged for two days is the single most expensive thing on this screen — it is a
 * refund request and a bad review forming — so it is what the list leads with, not the most
 * recent.
 */

interface OrderRow {
  id: string;
  orderNumber: string;
  buyerEmail: string;
  status: string;
  totalPaise: string;
  itemCount: number;
  source: string | null;
  createdAt: string;
  awaitingAckHours: number | null;
}

interface OrderDetail extends OrderRow {
  shippingAddress?: Record<string, string>;
  razorpayPaymentId?: string | null;
  razorpayOrderId?: string | null;
  razorpayDashboardUrl?: string | null;
  items: {
    id: string;
    nameSnapshot: string;
    skuSnapshot: string;
    quantity: number;
    lineTotalPaise: string | null;
  }[];
  events: { type: string; actor: string; payload: Record<string, unknown>; at: string }[];
}

/** What a merchant can do next, and what each action needs from them. */
const ACTIONS: Record<string, { to: string; label: string; needs?: 'shipping' | 'reason' }[]> = {
  paid: [
    { to: 'confirmed', label: 'Acknowledge' },
    { to: 'cancelled', label: 'Cancel', needs: 'reason' },
  ],
  confirmed: [
    { to: 'packed', label: 'Mark packed' },
    { to: 'cancelled', label: 'Cancel', needs: 'reason' },
  ],
  packed: [{ to: 'shipped', label: 'Mark shipped', needs: 'shipping' }],
  shipped: [{ to: 'delivered', label: 'Mark delivered' }],
};

const STATUS_TONE: Record<string, 'accent' | 'warn' | 'danger' | 'neutral'> = {
  paid: 'warn',
  confirmed: 'accent',
  packed: 'accent',
  shipped: 'accent',
  delivered: 'neutral',
  cancelled: 'danger',
  refunded: 'danger',
  failed: 'danger',
  awaiting_payment: 'neutral',
};

export default function OrdersPage() {
  const [orders, setOrders] = useState<OrderRow[]>([]);
  const [selected, setSelected] = useState<OrderDetail | null>(null);
  const [statusFilter, setStatusFilter] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await api.get<{ orders: OrderRow[] }>(
        `/merchant/orders${statusFilter ? `?status=${statusFilter}` : ''}`,
      );
      // Unacknowledged first, oldest of those first: the list leads with what is costing money.
      setOrders(
        [...result.orders].sort(
          (a, b) => (b.awaitingAckHours ?? -1) - (a.awaitingAckHours ?? -1),
        ),
      );
    } catch (err) {
      setError(describeError(err));
    } finally {
      setLoading(false);
    }
  }, [statusFilter]);

  useEffect(() => {
    void load();
  }, [load]);

  async function open(id: string) {
    setError(null);
    try {
      setSelected(await api.get<OrderDetail>(`/merchant/orders/${id}`));
    } catch (err) {
      setError(describeError(err));
    }
  }

  async function act(order: OrderDetail, to: string, needs?: 'shipping' | 'reason') {
    let extra: Record<string, string> = {};
    if (needs === 'shipping') {
      const courier = prompt('Courier (e.g. Delhivery, Bluedart)')?.trim();
      const awb = prompt('Tracking / AWB number')?.trim();
      if (!courier || !awb) return;
      extra = { courier, awb };
    }
    if (needs === 'reason') {
      const reason = prompt('Why is this being cancelled? The buyer will see this.')?.trim();
      if (!reason) return;
      extra = { reason };
    }

    setBusy(true);
    setError(null);
    try {
      await api.patch(`/merchant/orders/${order.id}`, { status: to, ...extra });
      await open(order.id);
      await load();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Orders</h1>
        <p className="mt-1.5 max-w-2xl text-sm text-[hsl(var(--muted))]">
          Buyers paid into your Razorpay account directly. Acknowledging quickly is the single
          biggest thing you control in your trust score.
        </p>
      </div>

      {error && <ErrorNote>{error}</ErrorNote>}

      <Card>
        <div className="flex flex-wrap items-center gap-3 border-b border-[hsl(var(--border))] px-5 py-4">
          <select
            className={`${inputClass} max-w-xs`}
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
          >
            <option value="">All orders</option>
            {['paid', 'confirmed', 'packed', 'shipped', 'delivered', 'cancelled', 'refunded'].map(
              (s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ),
            )}
          </select>
        </div>

        {loading ? (
          <p className="px-5 py-8 text-sm text-[hsl(var(--muted))]">Loading…</p>
        ) : orders.length === 0 ? (
          <Empty
            title="No orders yet"
            reason="Orders appear here once a buyer pays. Nothing is missing — this is what an empty catalogue looks like before its first sale."
          />
        ) : (
          <ul className="divide-y divide-[hsl(var(--border))]">
            {orders.map((order) => (
              <li key={order.id}>
                <button
                  type="button"
                  onClick={() => void open(order.id)}
                  className="flex w-full items-center gap-4 px-5 py-4 text-left hover:bg-[hsl(var(--accent-soft))]"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-xs">{order.orderNumber}</span>
                      <Badge tone={STATUS_TONE[order.status] ?? 'neutral'}>{order.status}</Badge>
                      {order.awaitingAckHours != null && order.awaitingAckHours >= 24 && (
                        <Badge tone="danger">waiting {order.awaitingAckHours}h</Badge>
                      )}
                    </div>
                    <p className="mt-0.5 text-sm text-[hsl(var(--muted))]">
                      {order.buyerEmail} · {order.itemCount} item
                      {order.itemCount === 1 ? '' : 's'} · {relativeTime(order.createdAt)}
                      {order.source ? ` · via ${order.source}` : ''}
                    </p>
                  </div>
                  <span className="shrink-0 text-sm font-medium tabular-nums">
                    {formatPaise(order.totalPaise)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {selected && (
        <Card>
          <CardHeader
            title={`Order ${selected.orderNumber}`}
            description={`${selected.buyerEmail} · ${selected.status}`}
          />
          <div className="space-y-5 px-5 py-5">
            <div className="flex flex-wrap gap-2">
              {(ACTIONS[selected.status] ?? []).map((action) => (
                <Button
                  key={action.to}
                  type="button"
                  disabled={busy}
                  onClick={() => void act(selected, action.to, action.needs)}
                >
                  {action.label}
                </Button>
              ))}
              {(ACTIONS[selected.status] ?? []).length === 0 && (
                <p className="text-sm text-[hsl(var(--muted))]">
                  Nothing left to do — this order is {selected.status}.
                </p>
              )}
            </div>

            {/*
              Payment first, because it is the first thing a merchant checks — "has this
              actually been paid, and where is it?" — and because seeing their own Razorpay
              payment id is what makes "paid into your account" concrete rather than a claim.
            */}
            <div className="rounded-lg bg-[hsl(var(--accent-soft))] px-4 py-3">
              <h3 className="text-sm font-medium">Payment</h3>
              {selected.razorpayPaymentId ? (
                <>
                  <p className="mt-1 text-sm">
                    Paid into your Razorpay account ·{' '}
                    <span className="font-mono text-xs">{selected.razorpayPaymentId}</span>
                  </p>
                  {selected.razorpayDashboardUrl && (
                    <a
                      href={selected.razorpayDashboardUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="mt-1 inline-block text-sm underline"
                    >
                      Open it in your Razorpay dashboard
                    </a>
                  )}
                </>
              ) : (
                <p className="mt-1 text-sm text-[hsl(var(--muted))]">
                  {selected.status === 'awaiting_payment'
                    ? 'Not paid yet. The buyer has been given a payment link; stock is held for twenty minutes.'
                    : 'No payment recorded against this order.'}
                </p>
              )}
              {selected.razorpayOrderId && (
                <p className="mt-1 text-xs text-[hsl(var(--muted))]">
                  Razorpay order {selected.razorpayOrderId}
                </p>
              )}
            </div>

            <div>
              <h3 className="text-sm font-medium">Items</h3>
              <ul className="mt-2 space-y-1 text-sm">
                {selected.items.map((item) => (
                  <li key={item.id} className="flex justify-between gap-4">
                    <span>
                      {item.nameSnapshot}{' '}
                      <span className="text-[hsl(var(--muted))]">
                        × {item.quantity} · {item.skuSnapshot}
                      </span>
                    </span>
                    <span className="tabular-nums">{formatPaise(item.lineTotalPaise)}</span>
                  </li>
                ))}
              </ul>
            </div>

            <div>
              <h3 className="text-sm font-medium">History</h3>
              <ol className="mt-2 space-y-1 text-sm text-[hsl(var(--muted))]">
                {selected.events.map((e, i) => (
                  <li key={i}>
                    {relativeTime(e.at)} — {e.type.replace('status.', '')}
                    {typeof e.payload.courier === 'string' && ` via ${e.payload.courier}`}
                    {typeof e.payload.awb === 'string' && ` (${e.payload.awb})`}
                    {typeof e.payload.reason === 'string' && ` — ${e.payload.reason}`}
                  </li>
                ))}
              </ol>
            </div>
          </div>
        </Card>
      )}
    </div>
  );
}
