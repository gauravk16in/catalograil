'use client';

import { Badge } from './ui';

/**
 * The constraints, as visible controls.
 *
 * Every one of these is a **hard exclusion** in the query, not a ranking nudge — an item
 * that cannot arrive in time does not appear at all, however cheap it is. Making them
 * controls rather than words a buyer has to phrase correctly is what turns the search into
 * something they can play with: change the budget, watch the answer change, understand what
 * the system is actually doing.
 */

export interface Filters {
  maxPriceInr?: number;
  maxDeliveryDays?: number;
  inStockOnly?: boolean;
}

const BUDGETS = [1000, 2500, 5000, 10000];
const DELIVERY = [2, 3, 7];

export function FilterBar({
  filters,
  onChange,
  disabled,
}: {
  filters: Filters;
  onChange: (next: Filters) => void;
  disabled?: boolean;
}) {
  const active = Object.values(filters).filter((v) => v !== undefined && v !== false).length;

  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-xs text-[hsl(var(--muted))]">Under ₹</span>
      {BUDGETS.map((amount) => (
        <Chip
          key={amount}
          on={filters.maxPriceInr === amount}
          disabled={disabled}
          onClick={() =>
            onChange({
              ...filters,
              maxPriceInr: filters.maxPriceInr === amount ? undefined : amount,
            })
          }
        >
          {amount.toLocaleString('en-IN')}
        </Chip>
      ))}

      <span className="ml-2 text-xs text-[hsl(var(--muted))]">Arrives in</span>
      {DELIVERY.map((days) => (
        <Chip
          key={days}
          on={filters.maxDeliveryDays === days}
          disabled={disabled}
          onClick={() =>
            onChange({
              ...filters,
              maxDeliveryDays: filters.maxDeliveryDays === days ? undefined : days,
            })
          }
        >
          {days}d
        </Chip>
      ))}

      <Chip
        on={Boolean(filters.inStockOnly)}
        disabled={disabled}
        onClick={() => onChange({ ...filters, inStockOnly: !filters.inStockOnly })}
      >
        In stock
      </Chip>

      {active > 0 && (
        <button
          type="button"
          onClick={() => onChange({})}
          className="ml-1 text-xs text-[hsl(var(--muted))] underline"
        >
          Clear
        </button>
      )}

      {active > 0 && (
        <Badge tone="neutral">
          {active} constraint{active === 1 ? '' : 's'} — applied as exclusions
        </Badge>
      )}
    </div>
  );
}

function Chip({
  on,
  disabled,
  onClick,
  children,
}: {
  on: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={`rounded-full border px-3 py-1 text-sm transition ${
        on
          ? 'border-[hsl(var(--accent))] bg-[hsl(var(--accent-soft))] font-medium'
          : 'border-[hsl(var(--border))] text-[hsl(var(--muted))] hover:text-[hsl(var(--text))]'
      } disabled:opacity-50`}
    >
      {children}
    </button>
  );
}
