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
import settlementsRouter from "./settlements";
import logsRouter from "./logs";
import companiesRouter from "./companies";
import productsRouter from "./products";
import boardRouter from "./board";
import translatorsRouter from "./translators";
import documentsRouter from "./documents";

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
router.use(settlementsRouter);
router.use(logsRouter);
router.use(companiesRouter);
router.use(productsRouter);
router.use(boardRouter);
router.use(translatorsRouter);
router.use(documentsRouter);

export default router;
