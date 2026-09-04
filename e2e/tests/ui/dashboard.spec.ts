import { expect, test } from '@playwright/test';

/**
 * The UI half of S7.1.
 *
 * Deliberately thin, and deliberately about the things that were broken rather than about
 * rendering. Every route below returned a 403 or a 404 before this sprint, and none of that
 * was visible from a local dev server — which is why these run against the deployment.
 */
const APP = process.env.MERCHANT_APP_URL;

test.describe('merchant dashboard', () => {
  test.skip(!APP, 'Needs MERCHANT_APP_URL.');

  test('serves the sign-in screen to a signed-out visitor', async ({ page }) => {
    await page.goto('/login');
    await expect(page.getByRole('heading', { name: /sign in/i })).toBeVisible();
  });

  test('offers a way to create an account', async ({ page }) => {
    await page.goto('/signup');
    await expect(page.getByRole('heading', { name: /create your account/i })).toBeVisible();
  });

  test('sends a signed-out visitor to sign in rather than an empty dashboard', async ({ page }) => {
    // Not a security boundary — the API is — but it is the difference between a login
    // screen and a page of failed requests.
    await page.goto('/products');
    await expect(page).toHaveURL(/\/login/);
  });

  test('serves the CSV templates as static files, not through the API', async ({ request }) => {
    /**
     * These used to be an API route behind IAM authorization, so the browser got a 403 and
     * the merchant got a button that did nothing.
     */
    for (const name of ['simple-products.csv', 'variant-products.csv']) {
      const response = await request.get(`${APP}/templates/${name}`);
      expect(response.status()).toBe(200);
      const body = await response.text();
      // The BOM Excel needs, then the header row.
      expect(body.charCodeAt(0)).toBe(0xfeff);
      expect(body).toContain('external_ref');
    }
  });

  test('ships a column guide beside each template', async ({ request }) => {
    const response = await request.get(`${APP}/templates/variant-products-guide.md`);
    expect(response.status()).toBe(200);
    expect(await response.text()).toContain('external_ref');
  });
});
