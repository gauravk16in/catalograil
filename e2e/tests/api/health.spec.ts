import { expect, test } from '@playwright/test';

/**
 * The check that answers when everything else is broken.
 *
 * It needs no credentials by design: during the outage the only way to ask "is the API up"
 * was an IAM-signed call to a business route, which is useless when auth is the problem.
 */
const API = process.env.API_BASE_URL;

test.describe('health', () => {
  test.skip(!API, 'Needs API_BASE_URL.');

  test('answers without a credential', async ({ request }) => {
    const response = await request.get(`${API}/health`);
    expect(response.status()).toBe(200);
    expect((await response.json()).status).toBe('ok');
  });

  test('reports every dependency separately', async ({ request }) => {
    /**
     * Per-dependency latency, because "the API is slow" and "Aurora is resuming from zero
     * ACU" need different responses and only a per-dependency number tells them apart.
     */
    const response = await request.get(`${API}/health/deep`);
    const body = await response.json();

    const names = body.dependencies.map((d: { name: string }) => d.name);
    expect(names).toEqual(expect.arrayContaining(['aurora', 'dynamodb', 's3', 'sqs', 'bedrock']));
    for (const dependency of body.dependencies) {
      expect(dependency.status, `${dependency.name}: ${dependency.detail ?? ''}`).toBe('ok');
      expect(dependency.latencyMs).toBeGreaterThanOrEqual(0);
    }
  });
});
