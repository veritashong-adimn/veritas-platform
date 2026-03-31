import app from "./app";
import { logger } from "./lib/logger";
import { seedAdmin } from "./lib/seedAdmin";
import { seedRbac } from "./lib/rbac";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

seedAdmin()
  .catch((err) => {
    logger.error({ err }, "Admin seed failed — continuing startup");
  })
  .then(() => seedRbac())
  .catch((err) => {
    logger.error({ err }, "RBAC seed failed — continuing startup");
  })
  .finally(() => {
    app.listen(port, (err) => {
      if (err) {
        logger.error({ err }, "Error listening on port");
        process.exit(1);
      }

      logger.info({ port }, "Server listening");
    });
  });
