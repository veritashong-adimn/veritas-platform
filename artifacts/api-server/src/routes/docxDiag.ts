/**
 * POST /api/diag/docx
 *
 * DOCX 추출기 진단 엔드포인트.
 * 업로드된 Buffer를 그대로 분석하여 아래 값을 반환한다:
 *   - sha256          : 파일 해시 (동일 파일 여부 확인용)
 *   - fileSize        : 바이트 수
 *   - method          : 추출 방식
 *   - wordCount       : AI 추출 단어수
 *   - charCountNoSpace: AI 추출 글자수 (공백 제외)
 *   - charCountWithSpace
 *   - detectedLanguage
 *   - appXml          : docProps/app.xml의 캐시된 Words / Characters 값
 *   - partBreakdown   : 파트별 단어수 (document, header, footer, footnotes, endnotes, drawings)
 *   - warning         : 추출 경고
 */

import { Router, type IRouter } from "express";
import multer from "multer";
import path from "node:path";
import crypto from "node:crypto";
import { requireAuth, requireRole } from "../middlewares/auth";
import { extractText } from "../lib/textExtractor";

const router: IRouter = Router();

const diagUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, ext === ".docx");
  },
});

router.post(
  "/diag/docx",
  requireAuth,
  requireRole("admin", "staff"),
  diagUpload.single("file"),
  async (req, res) => {
    if (!req.file) {
      res.status(400).json({ error: "DOCX 파일을 첨부해 주세요. (필드명: file, 확장자: .docx)" });
      return;
    }

    const buf = req.file.buffer;
    const filename = req.file.originalname;

    // ── 1. SHA-256 ─────────────────────────────────────────────────────────
    const sha256 = crypto.createHash("sha256").update(buf).digest("hex");
    const fileSize = buf.length;

    // ── 2. app.xml 캐시값 읽기 ────────────────────────────────────────────
    let appXmlWords: number | null = null;
    let appXmlChars: number | null = null;
    try {
      const unzipper = await import("unzipper");
      const zip = await unzipper.Open.buffer(buf);
      const appFile = zip.files.find(f => /^docProps\/app\.xml$/i.test(f.path));
      if (appFile) {
        const appXml = (await appFile.buffer()).toString("utf8");
        const wm = appXml.match(/<Words>(\d+)<\/Words>/i);
        const cm = appXml.match(/<Characters>(\d+)<\/Characters>/i);
        if (wm) appXmlWords = parseInt(wm[1], 10);
        if (cm) appXmlChars = parseInt(cm[1], 10);
      }
    } catch {
      // app.xml 읽기 실패 시 무시
    }

    // ── 3. 파트별 단어수 (extractText 내부 로그와 동일 로직) ─────────────
    const partBreakdown: Record<string, number> = {};
    try {
      const unzipper = await import("unzipper");
      const zip = await unzipper.Open.buffer(buf);

      const COUNT_PATTERNS: Array<{ pat: RegExp; label: string }> = [
        { pat: /^word\/document\.xml$/i,             label: "document"  },
        { pat: /^word\/header\d+\.xml$/i,            label: "header"    },
        { pat: /^word\/footer\d+\.xml$/i,            label: "footer"    },
        { pat: /^word\/footnotes\.xml$/i,            label: "footnotes" },
        { pat: /^word\/endnotes\.xml$/i,             label: "endnotes"  },
        { pat: /^word\/drawings\/drawing\d+\.xml$/i, label: "drawing"   },
      ];

      const SKIP_TAGS = new Set([
        "w:instrText", "w:del", "w:rPrChange", "w:pPrChange",
        "w:sectPrChange", "w:tblPrChange", "mc:Fallback",
      ]);
      const PARA_CLOSE = new Set(["w:p", "w:tr", "a:p"]);

      function parseXml(xml: string): string {
        const out: string[] = [];
        let i = 0;
        const n = xml.length;
        while (i < n) {
          if (xml[i] !== "<") { i++; continue; }
          let j = i + 1;
          let inQ = false, qc = "";
          while (j < n) {
            const c = xml[j];
            if (inQ) { if (c === qc) inQ = false; }
            else if (c === '"' || c === "'") { inQ = true; qc = c; }
            else if (c === ">") break;
            j++;
          }
          if (j >= n) break;
          const inner   = xml.slice(i + 1, j);
          const isClose = inner.startsWith("/");
          const isSelf  = inner.endsWith("/");
          const tagRaw  = isClose ? inner.slice(1) : inner;
          const tagName = tagRaw.split(/[\s/]/)[0] ?? "";
          i = j + 1;
          if (!isClose && !isSelf && SKIP_TAGS.has(tagName)) {
            const k = xml.indexOf(`</${tagName}>`, i);
            if (k !== -1) i = k + tagName.length + 3;
            continue;
          }
          if (tagName === "w:t" && !isClose && !isSelf) {
            const k = xml.indexOf("</w:t>", i);
            if (k !== -1) { out.push(xml.slice(i, k)); i = k + 6; }
            continue;
          }
          if (!isClose) {
            if (tagName === "w:br" || tagName === "w:cr") { out.push(" "); continue; }
            if (tagName === "w:tab" || tagName === "a:tab") { out.push(" "); continue; }
          } else {
            if (PARA_CLOSE.has(tagName)) out.push(" ");
          }
        }
        return out.join("");
      }

      function countWords(text: string): number {
        const HAS_ALNUM = /[\p{L}\p{N}]/u;
        return text
          .replace(/[\r\n\t]+/g, " ")
          .replace(/[/–—]/g, " ")
          .trim()
          .split(/\s+/)
          .filter(w => w.length > 0 && HAS_ALNUM.test(w))
          .length;
      }

      for (const { pat, label } of COUNT_PATTERNS) {
        const matched = zip.files
          .filter(f => pat.test(f.path))
          .sort((a, b) => a.path.localeCompare(b.path));
        let groupWords = 0;
        for (const file of matched) {
          const xml  = (await file.buffer()).toString("utf8");
          const text = parseXml(xml);
          if (!text.trim()) continue;
          groupWords += countWords(text);
        }
        if (groupWords > 0) partBreakdown[label] = groupWords;
      }
    } catch {
      // 파트별 분석 실패 시 무시
    }

    // ── 4. extractText 실행 ────────────────────────────────────────────────
    const stats = await extractText(buf, filename);

    res.json({
      filename,
      sha256,
      fileSize,
      method:             stats.method,
      wordCount:          stats.wordCount,
      charCountNoSpace:   stats.charCountNoSpace,
      charCountWithSpace: stats.charCountWithSpace,
      detectedLanguage:   stats.detectedLanguage,
      appXml: {
        words:      appXmlWords,
        chars:      appXmlChars,
        note:       "Word 저장 당시 캐시값. 편집 후 미저장 시 실제값과 불일치할 수 있음.",
      },
      partBreakdown,
      warning: stats.warning ?? null,
    });
  },
);

export default router;
