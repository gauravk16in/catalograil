import type { NextConfig } from 'next';

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
