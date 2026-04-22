import bcrypt from "bcryptjs";
import { db, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "./logger";

const DEFAULT_ADMIN_EMAIL = "admin@platform.com";
const DEFAULT_ADMIN_PASSWORD = "DevTest1234!";

export async function seedAdmin(): Promise<void> {
  const adminEmail = process.env["ADMIN_EMAIL"] ?? DEFAULT_ADMIN_EMAIL;
  const rawPassword = process.env["ADMIN_PASSWORD"] ?? DEFAULT_ADMIN_PASSWORD;

  const existing = await db
    .select({ id: usersTable.id })
    .from(usersTable)
    .where(eq(usersTable.email, adminEmail))
    .limit(1);

  if (existing.length > 0) {
    logger.info({ email: adminEmail }, "Admin account already exists — skipping seed");
    return;
  }

  const hashed = await bcrypt.hash(rawPassword, 10);
  await db.insert(usersTable).values({
    email: adminEmail,
    password: hashed,
    role: "admin",
    name: "관리자",
    isActive: true,
  });

  const usingDefault = !process.env["ADMIN_PASSWORD"];
  logger.info(
    { email: adminEmail, usingDefaultPassword: usingDefault },
    usingDefault
      ? "Admin account created with DEFAULT password — set ADMIN_PASSWORD env var to override"
      : "Admin account created from ADMIN_PASSWORD env var",
  );
}
