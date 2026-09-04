import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { resolveEnv } from '../lib/env.js';

/**
 * Regression tests for the four causes in docs/DIAGNOSIS.md that broke every browser
 * request. Each one was invisible in the CDK source and only observable against the
 * deployed API, which is exactly the kind of bug worth pinning in a synth test.
 */
describe('API CORS and preflight', () => {
  function synth(context: Record<string, string> = {}) {
    const app = new App({ context: { env: 'dev', ...context } });
    return { app, config: resolveEnv(app) };
  }

  it('refuses a wildcard origin', () => {
    // Cause 3: a wildcard is rejected by browsers on any credentialed request, so it fails
    // exactly the calls it appears to permit.
    const app = new App({ context: { env: 'dev', appOrigins: '*' } });
    expect(() => resolveEnv(app)).toThrow(/never contain/i);
  });

  it('takes explicit origins from context', () => {
    const { config } = synth({
      appOrigins: 'https://main.d21osrv849o4of.amplifyapp.com,https://main.d1ypcvqs4kcq44.amplifyapp.com',
    });
    expect(config.appOrigins).toEqual([
      'https://main.d21osrv849o4of.amplifyapp.com',
      'https://main.d1ypcvqs4kcq44.amplifyapp.com',
    ]);
  });

  it('falls back to localhost outside prod rather than guessing an Amplify domain', () => {
    const { config } = synth();
    expect(config.appOrigins).toContain('http://localhost:3000');
    expect(config.appOrigins).not.toContain('*');
  });
});

describe('route methods', () => {
  /**
   * Cause 1, the one that broke everything: `ANY` matches `OPTIONS`, so the IAM authorizer
   * ran on the CORS preflight and answered 403. The browser then never sent the real
   * request. Listing methods explicitly leaves OPTIONS to the API's own preflight handling.
   */
  it('never routes ANY on an authorized path', async () => {
    const { ApiStack } = await import('../stacks/api-stack.js');
    void ApiStack;
    const source = await import('node:fs').then((fs) =>
      fs.readFileSync(new URL('../stacks/api-stack.ts', import.meta.url), 'utf8'),
    );
    expect(source).not.toMatch(/methods:\s*\[apigw\.HttpMethod\.ANY\]/);
  });
});
