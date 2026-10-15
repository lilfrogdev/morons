import { DatabaseSync } from "node:sqlite";
import { RepoMemory, type MemorySql } from "./repo-memory.ts";


export function openNodeOptChat(path: string) {
  const database = new DatabaseSync(path);
  const sql: MemorySql = {
    exec(query, ...bindings) {
      const rows = database.prepare(query).all(...bindings);
      return { toArray: () => rows as never };
    },
  };
  const transaction = <T>(work: () => T): T => {
    database.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      database.exec("COMMIT");
      return result;
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  };
  try {
    return { memory: new RepoMemory(sql, transaction), database };
  } catch (error) {
    database.close();
    throw error;
  }
}
