import { Router, type IRouter } from "express";
import healthRouter from "./health";
import usersRouter from "./users";
import projectsRouter from "./projects";
import quotesRouter from "./quotes";
import tasksRouter from "./tasks";
import logsRouter from "./logs";

const router: IRouter = Router();

router.use(healthRouter);
router.use(usersRouter);
router.use(projectsRouter);
router.use(quotesRouter);
router.use(tasksRouter);
router.use(logsRouter);

export default router;
