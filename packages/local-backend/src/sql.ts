import { DatabaseSync, type SQLInputValue } from "node:sqlite";
// Portable shape of the existing Cloudflare cursor; Node owns this connection.
export interface Sql {
  exec<T extends object = Record<string, unknown>>(
    query: string,
    ...params: SQLInputValue[]
  ): { toArray(): T[] };
}
export function sqlFacade(db: DatabaseSync): Sql {
  return {
    exec<T extends object>(query: string, ...params: SQLInputValue[]) {
      const stmt = db.prepare(query);
      const rows = stmt.all(...params) as T[];
      return { toArray: () => rows };
    },
  };
}
