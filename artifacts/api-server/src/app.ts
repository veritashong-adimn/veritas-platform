import express, { type Express, type Request, type Response, type NextFunction } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import path from "path";
import fs from "fs";
import router from "./routes";
import { logger } from "./lib/logger";

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.get("/api/health", async (_req, res) => {
  let dbStatus = "ok";
  try {
    const { pool } = await import("@workspace/db");
    await pool.query("SELECT 1");
  } catch {
    dbStatus = "unavailable";
  }
  res.json({ status: "ok", db: dbStatus });
});

app.use("/api", router);

// 프론트엔드 정적 파일 서빙 (Railway 프로덕션)
// __dirname = artifacts/api-server/dist/ → ../../web-app/dist/public
const clientDist = path.resolve(__dirname, "../../web-app/dist/public");
if (fs.existsSync(clientDist)) {
  app.use(express.static(clientDist));
  app.get(/^\/(?!api).*/, (_req, res) => {
    res.sendFile(path.join(clientDist, "index.html"));
  });
}

// 전역 에러 핸들러 — 모든 라우트/미들웨어에서 발생한 예외를 JSON으로 반환
// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  logger.error({ err }, "Unhandled error");
  if (res.headersSent) return;
  res.status(500).json({ error: "서버 오류가 발생했습니다. 잠시 후 다시 시도해 주세요." });
});

export default app;
