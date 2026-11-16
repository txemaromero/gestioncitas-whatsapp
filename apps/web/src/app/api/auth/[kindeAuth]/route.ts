import { handleAuth } from '@kinde-oss/kinde-auth-nextjs/server';

// Kinde auth endpoints: /api/auth/login, /api/auth/logout, /api/auth/kinde_callback, …
export const GET = handleAuth();
