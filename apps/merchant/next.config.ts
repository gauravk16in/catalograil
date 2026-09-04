import type { NextConfig } from 'next';

const config: NextConfig = {
  reactStrictMode: true,
  transpilePackages: ['@catalograil/core'],
  // All timestamps are stored UTC and rendered IST at the edge (conventions).
  env: { NEXT_PUBLIC_DISPLAY_TIMEZONE: 'Asia/Kolkata' },
};

export default config;
