import { Logger } from '@aws-lambda-powertools/logger';
import { getDb } from '@catalograil/db';
import { sweepReservations } from './sweep.js';

const logger = new Logger({ serviceName: 'reservation-sweeper' });

/** Runs on a five-minute EventBridge schedule (T2.17). */
export async function handler(): Promise<{ ordersExpired: number; unitsReleased: number }> {
  const result = await sweepReservations(getDb(), new Date());

  // Logged even when it does nothing: a sweeper that silently stops running looks identical
  // to one with nothing to do, until stock quietly disappears for a week.
  logger.info('Reservation sweep complete', { ...result });
  return result;
}
