import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { beforeAll, describe, expect, it } from 'vitest';
import { AuthStack } from '../stacks/auth-stack.js';
import { resolveEnv, stackName } from '../lib/env.js';

describe('auth stack (S2.1)', () => {
  let template: Template;

  beforeAll(() => {
    const app = new App({ context: { env: 'dev' } });
    const config = resolveEnv(app);
    const stack = new AuthStack(app, stackName('Auth', config), {
      env: { account: '123456789012', region: 'ap-south-1' },
      config,
    });
    template = Template.fromStack(stack);
  });

  it('creates two separate pools, not one with groups', () => {
    /**
     * A single pool would put buyers and merchants behind the same issuer, so every
     * merchant route would depend on a group check to stay safe and one missing check
     * would expose the merchant surface to any buyer. Two pools make that impossible
     * rather than unlikely.
     */
    template.resourceCountIs('AWS::Cognito::UserPool', 2);
    template.resourceCountIs('AWS::Cognito::UserPoolClient', 2);
  });

  it('issues no client secret, because a browser cannot keep one', () => {
    const clients = template.findResources('AWS::Cognito::UserPoolClient');
    for (const client of Object.values(clients)) {
      expect(client.Properties?.GenerateSecret ?? false).toBe(false);
    }
  });

  it('allows only SRP and refresh, never plain password auth', () => {
    const clients = template.findResources('AWS::Cognito::UserPoolClient');
    for (const client of Object.values(clients)) {
      const flows: string[] = client.Properties?.ExplicitAuthFlows ?? [];
      expect(flows).toContain('ALLOW_USER_SRP_AUTH');
      expect(flows).toContain('ALLOW_REFRESH_TOKEN_AUTH');
      // These send the password to the API rather than proving knowledge of it.
      expect(flows).not.toContain('ALLOW_USER_PASSWORD_AUTH');
      expect(flows).not.toContain('ALLOW_ADMIN_USER_PASSWORD_AUTH');
    }
  });

  it('requires ten characters with three classes', () => {
    const pools = template.findResources('AWS::Cognito::UserPool');
    for (const pool of Object.values(pools)) {
      const policy = pool.Properties?.Policies?.PasswordPolicy;
      expect(policy?.MinimumLength).toBe(10);
      expect(policy?.RequireLowercase).toBe(true);
      expect(policy?.RequireUppercase).toBe(true);
      expect(policy?.RequireNumbers).toBe(true);
    }
  });

  it('declares the custom id attribute as mutable', () => {
    // The post-confirmation trigger writes it after the user exists, so an immutable
    // attribute could never be set at all.
    const pools = Object.values(template.findResources('AWS::Cognito::UserPool'));
    const schemas = pools.flatMap((p) => p.Properties?.Schema ?? []);
    const custom = schemas.filter((a: { Name?: string }) =>
      ['merchant_id', 'buyer_id'].includes(a.Name ?? ''),
    );
    expect(custom.length).toBe(2);
    for (const attr of custom) expect(attr.Mutable).toBe(true);
  });

  it('lets buyers sign in by phone as well as email', () => {
    const pools = Object.values(template.findResources('AWS::Cognito::UserPool'));
    const aliases = pools.map((p) => p.Properties?.AliasAttributes ?? p.Properties?.UsernameAttributes ?? []);
    // One pool accepts phone; the merchant pool does not.
    expect(aliases.some((a: string[]) => a.includes('phone_number'))).toBe(true);
  });

  it('expires access tokens in an hour and refresh in thirty days', () => {
    const clients = template.findResources('AWS::Cognito::UserPoolClient');
    for (const client of Object.values(clients)) {
      expect(client.Properties?.AccessTokenValidity).toBe(60);
      expect(client.Properties?.IdTokenValidity).toBe(60);
      expect(client.Properties?.RefreshTokenValidity).toBe(43200);
      expect(client.Properties?.EnableTokenRevocation).toBe(true);
    }
  });
});
