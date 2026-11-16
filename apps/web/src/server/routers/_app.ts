import type { inferRouterInputs, inferRouterOutputs } from '@trpc/server';
import { createCallerFactory, createTRPCRouter } from '../trpc';
import { appointmentsRouter } from './appointments';
import { clientsRouter } from './clients';
import { employeesRouter } from './employees';
import { metricsRouter } from './metrics';
import { servicesRouter } from './services';
import { activityRouter } from './activity';
import { packsRouter } from './packs';
import { calendarFeedRouter } from './calendar-feed';
import { teamRouter } from './team';
import { tenantRouter } from './tenant';
import { timeOffRouter } from './time-off';
import { waitlistRouter } from './waitlist';

export const appRouter = createTRPCRouter({
  tenant: tenantRouter,
  appointments: appointmentsRouter,
  employees: employeesRouter,
  clients: clientsRouter,
  services: servicesRouter,
  timeOff: timeOffRouter,
  metrics: metricsRouter,
  waitlist: waitlistRouter,
  team: teamRouter,
  activity: activityRouter,
  packs: packsRouter,
  calendarFeed: calendarFeedRouter,
});

export type AppRouter = typeof appRouter;
export type RouterInputs = inferRouterInputs<AppRouter>;
export type RouterOutputs = inferRouterOutputs<AppRouter>;
export const createCaller = createCallerFactory(appRouter);
