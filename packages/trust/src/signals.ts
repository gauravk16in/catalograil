import type { PerformanceInputs, TrustResult, VerificationInputs } from './score.js';

/**
 * T2.12 — the numbers, in words a buyer can weigh.
 *
 * The rule that shapes every line here: **only claims that are true and mean something**.
 * "0 orders fulfilled" is technically accurate and actively misleading, because a reader
 * skims the shape of a list rather than its contents and a four-item list reads as a track
 * record whatever the items say.
 *
 * A new merchant gets "New on the platform" stated outright rather than an empty list. An
 * absent signal is read as an omission; an explicit one is read as a fact, and the honest
 * thing is to say it.
 */

export interface SignalInputs extends VerificationInputs, PerformanceInputs {
  readonly trust: TrustResult;
}

export function buildTrustSignals(inputs: SignalInputs): string[] {
  const signals: string[] = [];

  if (inputs.gstinVerified) signals.push('GSTIN verified');

  if (inputs.trust.isNewMerchant) {
    /**
     * Stated first, and never omitted.
     *
     * Buyers weight the first item most, and a new merchant's honest position is that
     * nobody has bought from them yet. Burying it under a verification badge would let the
     * badge do work it has not earned.
     */
    signals.push('New on the platform');
    if (inputs.ordersFulfilled > 0) {
      signals.push(`${inputs.ordersFulfilled} order${plural(inputs.ordersFulfilled)} fulfilled`);
    }
    return signals;
  }

  if (inputs.ordersFulfilled > 0) {
    signals.push(`${inputs.ordersFulfilled} orders fulfilled`);
  }

  if (inputs.ordersFulfilled > 0 && inputs.onTimeDeliveries > 0) {
    const rate = Math.round((inputs.onTimeDeliveries / inputs.ordersFulfilled) * 100);
    // Below half is not a signal, it is a warning, and dressing it up as one would be worse
    // than silence.
    if (rate >= 50) signals.push(`${rate}% delivered on time`);
  }

  if (inputs.avgRating != null && inputs.ratingCount > 0) {
    signals.push(
      `${inputs.avgRating.toFixed(1)}★ from ${inputs.ratingCount} buyer${plural(inputs.ratingCount)}`,
    );
  }

  if (inputs.avgAckMinutes != null && inputs.avgAckMinutes <= 60) {
    // Only worth saying when it is genuinely fast; "acknowledges within 5 hours" is noise.
    signals.push('Usually acknowledges within an hour');
  }

  if (inputs.businessAgeMonths >= 12) {
    const years = Math.floor(inputs.businessAgeMonths / 12);
    signals.push(`Selling for ${years} year${plural(years)}`);
  }

  return signals;
}

function plural(n: number): string {
  return n === 1 ? '' : 's';
}
