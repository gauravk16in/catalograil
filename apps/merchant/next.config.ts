import type { NextConfig } from 'next';

/**
 * S1.3 — fail the build rather than ship an undefined API URL.
 *
 * `NEXT_PUBLIC_*` values are inlined at build time, so one that is unset does not fail
 * later — it becomes `undefined`, the client's `?? ''` turns every call into a relative
 * path against the dashboard's own origin, and the app 404s with no clue why. The variable
 * being absent is a deployment mistake, and a deployment mistake should stop the build that
 * would otherwise bake it in.
 *
 * Skipped for `next lint` and type-checking runs, which legitimately have no environment.
 */
const isBuild = process.argv.some((arg) => arg === 'build');
if (isBuild && !process.env.NEXT_PUBLIC_API_BASE_URL) {
  throw new Error(
    'NEXT_PUBLIC_API_BASE_URL is not set. It is inlined at build time, so building without ' +
      'it produces a bundle that silently calls relative paths. Set it in the Amplify app ' +
      'environment (or .env.local) and rebuild.',
  );
}

const config: NextConfig = {
  /**
   * A static export, not a server render.
   *
   * Every page in this app is a client component talking to the API over fetch: there is
   * no middleware, no route handler, no server action and no dynamic route, so nothing here
   * runs on a server. Exporting statically is therefore not a compromise — it is what the
   * app actually is — and it removes a whole class of hosting problem, since a static
   * bundle has no Node runtime to be missing dependencies from.
   *
   * If a future page genuinely needs the server — the Razorpay OAuth callback is the likely
   * first one — that page belongs in the API rather than here, or this becomes a hybrid
   * deployment and the hosting platform changes with it.
   */
  output: 'export',
  reactStrictMode: true,
  transpilePackages: ['@catalograil/core'],
  // All timestamps are stored UTC and rendered IST at the edge (conventions).
  env: { NEXT_PUBLIC_DISPLAY_TIMEZONE: 'Asia/Kolkata' },
};

export default config;
