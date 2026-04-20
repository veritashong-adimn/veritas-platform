import { db, logsTable } from "@workspace/db";
import type { Logger } from "pino";

type EntityType = "project" | "quote" | "task" | "communication" | "company" | "translator" | "translation_unit" | "product" | "product_request" | "insight";

export interface LogPerformer {
  id: number;
  email: string;
}

export async function logEvent(
  entityType: EntityType,
  entityId: number,
  action: string,
  log?: Logger,
  performer?: LogPerformer,
  metadata?: string,
): Promise<void> {
  try {
    await db.insert(logsTable).values({
      entityType,
      entityId,
      action,
      performedBy: performer?.id ?? null,
      performedByEmail: performer?.email ?? null,
      metadata: metadata ?? null,
    });
  } catch (err) {
    if (log) {
      log.error({ err, entityType, entityId, action }, "Failed to write log event");
    }
  }
}
