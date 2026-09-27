import {
  IntakeError,
  createProjectIntakeStore,
  createUserIntakeStore
} from "../chunk-VWAEWOWK.js";
import "../chunk-YZ6KQULN.js";
import "../chunk-JDEGS53O.js";

// src/intakes/drizzle/schema.ts
import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
var hexId = () => text("id").primaryKey().default(sql`(lower(hex(randomblob(16))))`);
var createdAt = () => integer("created_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`);
var updatedAt = () => integer("updated_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`);
function createUserIntakeTable(userTable) {
  return sqliteTable("user_intake", {
    id: hexId(),
    userId: text("user_id").notNull().references(() => userTable.id, { onDelete: "cascade" }),
    /** The intake definition id the payload was collected against. */
    graphId: text("graph_id").notNull(),
    /** The IntakePayload JSON blob. */
    payload: text("payload", { mode: "json" }).notNull(),
    /** Set when the user finishes the onboarding interview; null while open. */
    completedAt: integer("completed_at", { mode: "timestamp" }),
    createdAt: createdAt(),
    updatedAt: updatedAt()
  }, (table) => [
    uniqueIndex("uniq_user_intake_user").on(table.userId)
  ]);
}
function createProjectIntakeTable(workspaceTable) {
  return sqliteTable("project_intake", {
    id: hexId(),
    workspaceId: text("workspace_id").notNull().references(() => workspaceTable.id, { onDelete: "cascade" }),
    graphId: text("graph_id").notNull(),
    payload: text("payload", { mode: "json" }).notNull(),
    completedAt: integer("completed_at", { mode: "timestamp" }),
    createdAt: createdAt(),
    updatedAt: updatedAt()
  }, (table) => [
    uniqueIndex("uniq_project_intake_workspace").on(table.workspaceId),
    index("idx_project_intake_graph").on(table.graphId)
  ]);
}
function createIntakeTables(opts) {
  const userIntake = createUserIntakeTable(opts.userTable);
  const result = {
    userIntake
  };
  if (opts.workspaceTable) {
    result.projectIntake = createProjectIntakeTable(opts.workspaceTable);
  }
  return result;
}
export {
  IntakeError,
  createIntakeTables,
  createProjectIntakeStore,
  createUserIntakeStore
};
//# sourceMappingURL=drizzle.js.map