// Typed `inject('databaseUrl' | 'appDatabaseUrl')` / `project.provide(…)` for every Vitest project.
declare module 'vitest' {
  export interface ProvidedContext {
    databaseUrl: string;
    /** Same database as the restricted role `clinicai_app` (F19). */
    appDatabaseUrl: string;
  }
}

export {};
