import { AppError } from '../errors/index.js';

/**
 * Rule 13: all amounts are bigint paise. Never floats. Formatting happens at the
 * edge only — nothing inside the system ever holds a rupee number.
 */
export type Paise = bigint;

const RUPEE_STRING = /^-?\d+(\.\d{1,2})?$/;

/**
 * Parse a decimal rupee string ("2499.50") to paise, without ever creating a float.
 * CSV prices and merchant form input come through here.
 */
export function rupeeStringToPaise(input: string): Paise {
  const trimmed = input.trim().replace(/[₹,\s]/g, '');
  if (!RUPEE_STRING.test(trimmed)) {
    throw new AppError('VALIDATION_FAILED', `Not a valid rupee amount: "${input}"`, {
      details: { input },
    });
  }
  const negative = trimmed.startsWith('-');
  const abs = negative ? trimmed.slice(1) : trimmed;
  const [whole = '0', frac = ''] = abs.split('.');
  const paise = BigInt(whole) * 100n + BigInt(frac.padEnd(2, '0'));
  return negative ? -paise : paise;
}

/** Whole rupees to paise. Rejects a non-integer so a float never sneaks in. */
export function rupeesToPaise(rupees: number): Paise {
  if (!Number.isInteger(rupees)) {
    throw new AppError(
      'VALIDATION_FAILED',
      'Rupee input must be a whole number; use rupeeStringToPaise for decimals.',
      {
        details: { rupees },
      },
    );
  }
  return BigInt(rupees) * 100n;
}

/** Display formatting. Edge only — never store or compare on this output. */
export function formatPaise(paise: Paise, options: { symbol?: boolean } = {}): string {
  const { symbol = true } = options;
  const negative = paise < 0n;
  const abs = negative ? -paise : paise;
  const whole = abs / 100n;
  const frac = abs % 100n;

  const grouped = groupIndian(whole.toString());
  const body = frac === 0n ? grouped : `${grouped}.${frac.toString().padStart(2, '0')}`;
  return `${negative ? '-' : ''}${symbol ? '₹' : ''}${body}`;
}

/** Indian digit grouping: last three, then pairs. 1234567 → 12,34,567 */
function groupIndian(digits: string): string {
  if (digits.length <= 3) return digits;
  const last3 = digits.slice(-3);
  const rest = digits.slice(0, -3);
  return `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${last3}`;
}

/** Sum a set of line amounts. Present so no caller reaches for reduce with a number seed. */
export function sumPaise(amounts: readonly Paise[]): Paise {
  return amounts.reduce<Paise>((total, a) => total + a, 0n);
}
