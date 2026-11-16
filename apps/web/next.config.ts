import type { NextConfig } from 'next';
import { STATIC_SECURITY_HEADERS } from './src/lib/security-headers';

const nextConfig: NextConfig = {
  // Workspace packages are shipped as TypeScript sources.
  transpilePackages: ['@clinicai/db', '@clinicai/shared'],
  // Prisma's driver adapter and pg must stay as runtime dependencies on the server.
  serverExternalPackages: ['pg', '@prisma/adapter-pg'],
  poweredByHeader: false,
  typedRoutes: false,
  // F25: the Content Security Policy (with a nonce per request) is set in src/proxy.ts.
  async headers() {
    return [{ source: '/:path*', headers: STATIC_SECURITY_HEADERS }];
  },
};

export default nextConfig;
