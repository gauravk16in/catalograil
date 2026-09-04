import { DecryptCommand, EncryptCommand, KMSClient } from '@aws-sdk/client-kms';
import { AppError } from '@catalograil/core';

/**
 * Rule 3: a Razorpay token is never stored unencrypted, and is decrypted in memory only.
 *
 * These are the merchant's credentials for their own Razorpay account. D4 means every
 * payment object is created with them, so a leak is not "an API key rotated" — it is
 * someone able to move money on a merchant's behalf. Everything about this file assumes
 * that: the plaintext never touches a log, never enters an error message, and never leaves
 * the function that needed it.
 */

export interface TokenCipher {
  encrypt(plaintext: string): Promise<string>;
  decrypt(ciphertext: string): Promise<string>;
}

/**
 * KMS encryption, with the merchant id as an encryption context.
 *
 * The context is authenticated but not secret, and it is what makes a stolen ciphertext
 * useless in the wrong row: a token encrypted for merchant A cannot be decrypted while
 * claiming to be merchant B, so swapping ciphertexts between rows fails loudly instead of
 * silently handing one merchant another's credentials.
 */
export class KmsTokenCipher implements TokenCipher {
  private readonly client: KMSClient;

  constructor(
    private readonly keyId: string,
    private readonly merchantId: string,
    client?: KMSClient,
  ) {
    this.client = client ?? new KMSClient({});
  }

  async encrypt(plaintext: string): Promise<string> {
    const result = await this.client.send(
      new EncryptCommand({
        KeyId: this.keyId,
        Plaintext: Buffer.from(plaintext, 'utf8'),
        EncryptionContext: { merchantId: this.merchantId },
      }),
    );

    if (!result.CiphertextBlob) {
      throw new AppError('INTERNAL_ERROR', 'KMS returned no ciphertext.');
    }
    return Buffer.from(result.CiphertextBlob).toString('base64');
  }

  async decrypt(ciphertext: string): Promise<string> {
    try {
      const result = await this.client.send(
        new DecryptCommand({
          CiphertextBlob: Buffer.from(ciphertext, 'base64'),
          EncryptionContext: { merchantId: this.merchantId },
        }),
      );
      if (!result.Plaintext) {
        throw new AppError('INTERNAL_ERROR', 'KMS returned no plaintext.');
      }
      return Buffer.from(result.Plaintext).toString('utf8');
    } catch {
      // A bare catch, because the cause is deliberately not attached and not re-read: a KMS
      // error can echo back the encryption context, and this error will be logged.
      throw new AppError('INTERNAL_ERROR', 'Could not decrypt the merchant token.', {
        details: { merchantId: this.merchantId },
      });
    }
  }
}

/**
 * For tests. Reversible and obviously not secret, so nothing can mistake it for the real
 * thing — a fake that looked like encryption would be worse than one that plainly is not.
 */
export class ReversibleTestCipher implements TokenCipher {
  async encrypt(plaintext: string): Promise<string> {
    return `test:${Buffer.from(plaintext, 'utf8').toString('base64')}`;
  }

  async decrypt(ciphertext: string): Promise<string> {
    if (!ciphertext.startsWith('test:')) {
      throw new AppError('INTERNAL_ERROR', 'Not a test ciphertext.');
    }
    return Buffer.from(ciphertext.slice(5), 'base64').toString('utf8');
  }
}
