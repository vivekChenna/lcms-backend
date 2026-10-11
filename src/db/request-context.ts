import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Who a database query is running for.
 *
 * Inside an HTTP request there is always a context, and every query in that request runs as the
 * restricted database role with `userId` as the acting user (null until the request has been
 * authenticated, which sees nothing in the protected tables: fail closed). Outside a request
 * (background workers, seeds, migrations) there is no context and queries run with the
 * connection's own privileges. The row-level security policies read the context through the
 * app_current_* functions created by the 1700000016000 migration.
 */
export type DbContext = { userId: string | null };

const storage = new AsyncLocalStorage<DbContext>();

/** Fastify onRequest hook body: everything the request does from here on runs in its own context. */
export function runInRequestContext(next: () => void): void {
  storage.run({ userId: null }, next);
}

/** Called once the access token has been verified (and by flows where a one-time token proves who is acting). */
export function setRequestUser(userId: string): void {
  const context = storage.getStore();
  if (context) {
    context.userId = userId;
  }
}

/** The context of the code running right now, or undefined outside a request. */
export function currentDbContext(): DbContext | undefined {
  return storage.getStore();
}

/** Run `fn` with a given user, outside of any request (used by tests and one-off tooling). */
export function runAsUser<T>(userId: string | null, fn: () => Promise<T>): Promise<T> {
  return storage.run({ userId }, fn);
}

/** Run `fn` with the connection's own privileges even when called from inside a request. */
export function runAsSystem<T>(fn: () => Promise<T>): Promise<T> {
  return storage.exit(fn);
}
