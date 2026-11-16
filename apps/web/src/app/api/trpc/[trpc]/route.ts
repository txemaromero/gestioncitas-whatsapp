import { fetchRequestHandler } from '@trpc/server/adapters/fetch';
import { appRouter } from '@/server/routers/_app';
import { createTRPCContext } from '@/server/trpc';

export const dynamic = 'force-dynamic';

const handler = (req: Request) =>
  fetchRequestHandler({
    endpoint: '/api/trpc',
    req,
    router: appRouter,
    createContext: () => createTRPCContext(),
    onError:
      process.env.NODE_ENV === 'development'
        ? ({ path, error }) => {
            // F34: one JSON line, so a path or a message cannot forge other log lines.
            console.error('tRPC error', JSON.stringify({ path: path ?? null, message: error.message }));
          }
        : undefined,
  });

export { handler as GET, handler as POST };
