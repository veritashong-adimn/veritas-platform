import { Router, type IRouter } from "express";
import healthRouter from "./health";
import authRouter from "./auth";
import usersRouter from "./users";
import projectsRouter from "./projects";
import quotesRouter from "./quotes";
import tasksRouter from "./tasks";
import uploadRouter from "./upload";
import paymentsRouter from "./payments";
import adminRouter from "./admin";
import logsRouter from "./logs";

const router: IRouter = Router();

router.use(healthRouter);
router.use(authRouter);
router.use(usersRouter);
router.use(projectsRouter);
router.use(quotesRouter);
router.use(tasksRouter);
router.use(uploadRouter);
router.use(paymentsRouter);
router.use(adminRouter);
router.use(logsRouter);

export default router;
