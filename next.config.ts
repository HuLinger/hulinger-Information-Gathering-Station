import type { NextConfig } from 'next';
import { GAME_FRAME_CSP } from './src/server/games/security';
const config: NextConfig = {
  devIndicators: false,
  output: 'standalone', poweredByHeader: false, agentRules: false,
  // Runtime storage and operator credentials are never application artifacts.
  outputFileTracingExcludes: { '**': ['./data/**', './.tmp/**', './backups/**', './uploads/**', './exports/**', './.env', './.env.*', './.deploy/**'] },
  async headers() {
    return [{ source: '/:path*', headers: [
      {key: 'X-Content-Type-Options', value: 'nosniff'},
      {key: 'X-Frame-Options', value: 'DENY'},
      {key: 'Referrer-Policy', value: 'no-referrer'},
      {key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()'},
      {key: 'Content-Security-Policy', value: "default-src 'self'; script-src 'self' 'unsafe-inline'" + (process.env.NODE_ENV === 'development' ? " 'unsafe-eval'" : '') + "; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"}
    // Next's global headers take precedence over route response headers.
    ]}, {source:'/api/tools/shattered-pixel-dungeon/assets/index.html',headers:[
      {key:'X-Frame-Options',value:'SAMEORIGIN'},
      {key:'Content-Security-Policy',value:GAME_FRAME_CSP},
    ]}];
  }
};
export default config;
