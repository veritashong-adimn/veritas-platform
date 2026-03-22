import { db, logsTable } from "@workspace/db";
import type { Logger } from "pino";

type EntityType = "project" | "quote" | "task";

export async function logEvent(
  entityType: EntityType,
  entityId: number,
  action: string,
  log?: Logger,
): Promise<void> {
  try {
    await db.insert(logsTable).values({ entityType, entityId, action });
  } catch (err) {
    if (log) {
      log.error({ err, entityType, entityId, action }, "Failed to write log event");
    }
  }
}
