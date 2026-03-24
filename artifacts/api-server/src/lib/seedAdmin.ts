import bcrypt from "bcryptjs";
import { db, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "./logger";

export async function seedAdmin(): Promise<void> {
  const adminEmail = process.env["ADMIN_EMAIL"] ?? "admin@platform.com";

  const existing = await db
    .select({ id: usersTable.id })
    .from(usersTable)
    .where(eq(usersTable.email, adminEmail))
    .limit(1);

  if (existing.length > 0) {
    logger.info({ email: adminEmail }, "Admin account already exists — skipping seed");
    return;
  }

  const rawPassword = process.env["ADMIN_PASSWORD"];
  if (!rawPassword) {
    logger.warn(
      { email: adminEmail },
      "ADMIN_PASSWORD env var is not set and no admin account exists. " +
        "Set the ADMIN_PASSWORD secret to create the admin account on next restart.",
    );
    return;
  }

  const hashed = await bcrypt.hash(rawPassword, 10);
  await db.insert(usersTable).values({
    email: adminEmail,
    password: hashed,
    role: "admin",
  });

  logger.info({ email: adminEmail }, "Admin account created from ADMIN_PASSWORD env var");
}
