// 서버 진입점
import app from "./app";
import { logger } from "./lib/logger";
import { seedAdmin } from "./lib/seedAdmin";
import { seedRbac } from "./lib/rbac";

const PORT = process.env.PORT;

async function startServer() {
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
