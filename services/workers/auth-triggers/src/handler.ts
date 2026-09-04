import { Logger } from '@aws-lambda-powertools/logger';
import { getDb } from '@catalograil/db';
import type { PostConfirmationTriggerEvent } from 'aws-lambda';
import {
  handleBuyerConfirmation,
  handleMerchantConfirmation,
  type TriggerDeps,
} from './post-confirmation.js';

const logger = new Logger({ serviceName: 'auth-triggers' });

let cached: TriggerDeps | undefined;
function deps(): TriggerDeps {
  if (!cached) cached = { db: getDb() };
  return cached;
}

/**
 * Cognito passes the event through unchanged on success; returning it is the contract.
 *
 * Errors are logged and rethrown rather than swallowed. A swallowed failure here produces
 * a confirmed user with no row behind it — an account that signs in successfully and then
 * finds nothing it owns, which is far harder to diagnose than a sign-up that failed.
 */
export async function merchantHandler(
  event: PostConfirmationTriggerEvent,
): Promise<PostConfirmationTriggerEvent> {
  logger.appendKeys({ correlationId: event.userName, pool: event.userPoolId });
  try {
    const result = await handleMerchantConfirmation(event, deps());
    logger.info('Merchant confirmed and linked');
    return result;
  } catch (err) {
    logger.error('Merchant post-confirmation failed', {
      errorMessage: err instanceof Error ? err.message : String(err),
    });
    throw err;
  } finally {
    logger.removeKeys(['correlationId', 'pool']);
  }
}

export async function buyerHandler(
  event: PostConfirmationTriggerEvent,
): Promise<PostConfirmationTriggerEvent> {
  logger.appendKeys({ correlationId: event.userName, pool: event.userPoolId });
  try {
    const result = await handleBuyerConfirmation(event, deps());
    logger.info('Buyer confirmed and linked');
    return result;
  } catch (err) {
    logger.error('Buyer post-confirmation failed', {
      errorMessage: err instanceof Error ? err.message : String(err),
    });
    throw err;
  } finally {
    logger.removeKeys(['correlationId', 'pool']);
  }
}
