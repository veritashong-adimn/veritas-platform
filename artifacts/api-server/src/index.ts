// 서버 진입점
import app from "./app";
import { logger } from "./lib/logger";
import { seedAdmin } from "./lib/seedAdmin";
import { seedRbac } from "./lib/rbac";
import { execFile } from "node:child_process";
import { access, constants as fsConstants } from "node:fs/promises";

const PORT = process.env.PORT ?? "8080";

async function resolveSystemBin(name: string, candidates: string[]): Promise<string | null> {
  const fromWhich = await new Promise<string | null>(resolve => {
    execFile("which", [name], (e, out) => resolve(e ? null : (out.trim() || null)));
  });
  if (fromWhich) return fromWhich;
  for (const p of candidates) {
    try { await access(p, fsConstants.X_OK); return p; } catch { /* skip */ }
  }
  return null;
}

async function startServer() {
  // 시스템 바이너리 가용성 진단 — Railway Deploy Log에서 즉시 확인 가능
  const antiwordPath = await resolveSystemBin("antiword", [
    "/usr/bin/antiword", "/usr/local/bin/antiword",
  ]);
  const pdftoppmPath = await resolveSystemBin("pdftoppm", [
    "/usr/bin/pdftoppm", "/usr/local/bin/pdftoppm",
  ]);
  logger.info(
    { antiwordPath: antiwordPath ?? "NOT FOUND", pdftoppmPath: pdftoppmPath ?? "NOT FOUND" },
    "[Startup] system binary check",
  );

  try {
    await seedAdmin();
  } catch (err) {
    console.error("[Seed] seedAdmin failed — continuing:", (err as Error).message);
  }

  try {
    await seedRbac();
  } catch (err) {
    console.error("[Seed] seedRbac failed — continuing:", (err as Error).message);
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server listening on port ${PORT}`);
    logger.info({ port: PORT }, "Server listening");
  });
}

startServer().catch((err) => {
  console.error("[Startup] Fatal error:", err);
  process.exit(1);
});
