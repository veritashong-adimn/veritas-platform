import { Router, type IRouter } from "express";
import multer from "multer";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { requireAuth } from "../middlewares/auth";
import { uploadToR2, isR2Configured } from "../lib/r2";

const router: IRouter = Router();

const MAX_FILE_SIZE = 10 * 1024 * 1024;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE },
  fileFilter: (_req, file, cb) => {
    const allowed = [
      "application/pdf",
      "application/msword",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "text/plain",
      "image/jpeg",
      "image/png",
      "image/gif",
      "application/zip",
    ];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error(`허용되지 않는 파일 형식입니다: ${file.mimetype}`));
    }
  },
});

router.post("/upload", requireAuth, (req, res, next) => {
  if (!isR2Configured()) {
    res.status(503).json({
      error: "파일 업로드 기능이 비활성화되어 있습니다. R2 환경 변수를 설정해주세요.",
    });
    return;
  }
  next();
}, upload.single("file"), async (req, res) => {
  if (!req.file) {
    res.status(400).json({ error: "파일을 첨부해주세요. (필드명: file)" });
    return;
  }

  const ext = path.extname(req.file.originalname).toLowerCase();
  const key = `uploads/${randomUUID()}${ext}`;

  try {
    const fileUrl = await uploadToR2(key, req.file.buffer, req.file.mimetype);
    req.log.info({ key, size: req.file.size }, "File uploaded to R2");
    res.status(201).json({ fileUrl });
  } catch (err) {
    req.log.error({ err }, "R2 upload failed");
    res.status(500).json({ error: "파일 업로드에 실패했습니다." });
  }
});

export default router;
