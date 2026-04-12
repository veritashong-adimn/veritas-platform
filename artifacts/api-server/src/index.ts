import app from "./app";
import { logger } from "./lib/logger";
import { seedAdmin } from "./lib/seedAdmin";
import { seedRbac } from "./lib/rbac";

const port = Number(process.env["PORT"] || 8080);

seedAdmin()
  .catch((err) => {
    logger.error({ err }, "Admin seed failed — continuing startup");
  })
  .then(() => seedRbac())
  .catch((err) => {
    logger.error({ err }, "RBAC seed failed — continuing startup");
  })
  .finally(() => {
    app.listen(port, "0.0.0.0", () => {
      console.log(`Server listening on port ${port}`);
      logger.info({ port }, "Server listening");
    });
  });
