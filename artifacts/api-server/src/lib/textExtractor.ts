/**
 * 문서 텍스트 추출 엔진
 *
 * 지원 형식:
 *   TXT  → buffer.toString
 *   DOCX → mammoth
 *   DOC  → word-extractor
 *   PDF  → pdf-parse
 *   PPTX → unzipper + XML <a:t> 파싱
 *   PPT  → word-extractor (부분 지원)
 *   XLSX / XLS → xlsx
 *   JPG / PNG  → GPT-4o vision OCR
 *
 * 반환값: TextStats (wordCount, charCountWithSpace, charCountNoSpace, detectedLanguage 포함)
 */

import path from "node:path";

// ─── 타입 ───────────────────────────────────────────────────────────────────

export interface TextStats {
  text:               string;   // 추출 원문 (최대 50,000자)
  wordCount:          number;   // 공백 기준 단어수
  charCountWithSpace: number;   // 공백 포함 글자수
  charCountNoSpace:   number;   // 공백 제외 글자수
  detectedLanguage:   string;   // 'ko' | 'ja' | 'zh-hans' | 'zh-hant' | 'en' | 'unknown'
  method:             string;   // 추출 방식 (로그용)
  warning?:           string;
}

// ─── 언어 감지 (유니코드 블록 비율) ──────────────────────────────────────────

export function detectLanguage(text: string): string {
  if (!text || text.length < 10) return "unknown";
  const sample = text.slice(0, 3000);
  const total  = sample.length;
  let ko = 0, ja = 0, zh = 0;
  for (const ch of sample) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp >= 0xAC00 && cp <= 0xD7A3) ko++;
    else if ((cp >= 0x3040 && cp <= 0x309F) || (cp >= 0x30A0 && cp <= 0x30FF)) ja++;
    else if (cp >= 0x4E00 && cp <= 0x9FFF) zh++;
  }
  if (ko / total > 0.05) return "ko";
  if (ja / total > 0.05) return "ja";
  if (zh / total > 0.05) return "zh-hans";
  return "en";
}

// ─── 통계 계산 ───────────────────────────────────────────────────────────────

function stats(raw: string, method: string, warning?: string): TextStats {
  const text = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim().slice(0, 50_000);
  // Word 호환 단어수: 공백 분리, 순수 특수문자 토큰 제외
  const words = text.split(/\s+/).filter(w =>
    w.length > 0 && w.replace(/[^a-zA-Z\d-￿]/g, "").length > 0
  );
  return {
    text,
    wordCount:          words.length,
    charCountWithSpace: text.length,
    charCountNoSpace:   text.replace(/\s/g, "").length,
    detectedLanguage:   detectLanguage(text),
    method,
    warning,
  };
}

function empty(method: string, warning: string): TextStats {
  return { text: "", wordCount: 0, charCountWithSpace: 0, charCountNoSpace: 0, detectedLanguage: "unknown", method, warning };
}

// ─── TXT ─────────────────────────────────────────────────────────────────────

function extractTxt(buf: Buffer): TextStats {
  return stats(buf.toString("utf8"), "txt-buffer");
}

// ─── DOCX — 직접 XML 파싱 (Word 기준 정확도 목표) ───────────────────────────
//
// Microsoft Word 단어수 기준으로 최대 1% 오차를 목표로 한다.
//
// 포함 영역:
//   word/document.xml   — 본문 + 텍스트 박스(w:txbxContent)
//   word/header*.xml    — 헤더 (각 섹션별)
//   word/footer*.xml    — 푸터 (각 섹션별)
//   word/footnotes.xml  — 각주
//   word/endnotes.xml   — 미주
//
// XML 파서 처리 규칙:
//   <w:t>              → 텍스트 수집 (공백 보존)
//   <w:instrText>      → 필드 코드 — 스킵
//   <w:del>            → 추적 변경 삭제 텍스트 — 스킵
//   <w:rPrChange>      → 서식 변경 정보 — 스킵
//   <w:br>, <w:cr>     → 공백(단어 경계)
//   <w:tab>            → 탭(공백)
//   </w:p>, </w:tr>    → 단락/행 끝 → 공백(단어 경계)
//
// Word 단어수 알고리즘:
//   - 공백(\s)으로 분리
//   - 하이픈은 단어 내부 (state-of-the-art = 1단어)
//   - 특수문자는 단어에 포함 (U.S.A., don't = 각 1단어)

/**
 * Word XML(OOXML) 시퀀셜 파서.
 * 단어 경계 주입 + 불필요 요소 스킵으로 Word 카운트와 최대 일치.
 */
function parseWordXml(xml: string): string {
  const buf: string[] = [];
  let i = 0;
  const n = xml.length;

  // 이 태그들의 내용은 완전히 스킵 (Word 미카운트 영역)
  const SKIP_TAGS = new Set([
    "w:instrText",   // 필드 코드 (PAGE, DATE 등)
    "w:del",         // 추적 변경 삭제 텍스트
    "w:rPrChange",   // 서식 변경 메타데이터
    "w:pPrChange",   // 단락 서식 변경 메타데이터
    "w:sectPrChange",
    "w:tblPrChange",
  ]);

  while (i < n) {
    // '<' 탐색
    if (xml[i] !== "<") { i++; continue; }

    // 태그 끝 탐색 (속성 값 내부 '>' 무시)
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

    const full   = xml.slice(i, j + 1);  // <...>
    const inner  = full.slice(1, -1);    // ...
    const isClose = inner.startsWith("/");
    const isSelf  = inner.endsWith("/");
    const tagRaw  = isClose ? inner.slice(1) : inner;
    const tagName = tagRaw.split(/[\s/]/)[0] ?? "";

    i = j + 1;

    // ─ 스킵 태그 처리 ──────────────────────────────────────────────────────
    if (!isClose && !isSelf && SKIP_TAGS.has(tagName)) {
      const closeTag = `</${tagName}>`;
      const k = xml.indexOf(closeTag, i);
      if (k !== -1) i = k + closeTag.length;
      continue;
    }

    // ─ w:t — 텍스트 수집 ───────────────────────────────────────────────────
    if (tagName === "w:t" && !isClose && !isSelf) {
      const closePos = xml.indexOf("</w:t>", i);
      if (closePos !== -1) {
        // xml:space="preserve" 유무와 관계없이 원본 텍스트 그대로 수집
        let text = xml.slice(i, closePos);
        // XML 엔티티 디코딩
        text = text
          .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
          .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
          .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(parseInt(d)))
          .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
        buf.push(text);
        i = closePos + 6;
      }
      continue;
    }

    // ─ 단어 경계 주입 ────────────────────────────────────────────────────
    if (!isClose) {
      // 줄바꿈/탭 → 공백 (단어 경계 역할)
      if (tagName === "w:br" || tagName === "w:cr") { buf.push(" "); continue; }
      if (tagName === "w:tab")                       { buf.push(" "); continue; }
    } else {
      // 단락·표 행 끝 → 공백 (단어 경계 역할)
      if (tagName === "w:p" || tagName === "w:tr") { buf.push(" "); }
    }
  }

  return buf.join("");
}

/**
 * DOCX 전체 파트 텍스트 추출 + Word 호환 단어수 계산.
 * mammoth 대비 Header/Footer/Footnote/TextBox 포함으로 정확도 향상.
 */
async function extractDocx(buf: Buffer): Promise<TextStats> {
  const unzipper = await import("unzipper");
  const zip = await unzipper.Open.buffer(buf);

  // 처리 순서: 본문 → 헤더 → 푸터 → 각주 → 미주
  // (Word의 단어수 카운트 순서와 동일)
  const PART_PATTERNS = [
    /^word\/document\.xml$/i,
    /^word\/header\d*\.xml$/i,
    /^word\/footer\d*\.xml$/i,
    /^word\/footnotes\.xml$/i,
    /^word\/endnotes\.xml$/i,
  ];

  const segments: string[] = [];
  for (const pat of PART_PATTERNS) {
    const matched = zip.files
      .filter(f => pat.test(f.path))
      .sort((a, b) => a.path.localeCompare(b.path));
    for (const file of matched) {
      const xml  = (await file.buffer()).toString("utf8");
      const text = parseWordXml(xml);
      if (text.trim()) segments.push(text);
    }
  }

  const fullText = segments.join(" ");

  // ─ Word 호환 단어수 계산 ──────────────────────────────────────────────────
  // 규칙: 공백(\s) 기준 분리, 하이픈은 단어 내부로 처리
  // "state-of-the-art" → 1단어, "it's" → 1단어, "U.S.A." → 1단어
  const normalised = fullText.replace(/[\t\r\n]+/g, " ").trim();
  const wordTokens = normalised.split(/\s+/).filter(w => {
    // 순수 특수문자만으로 이루어진 토큰 제외 (구두점 단독 토큰)
    return w.replace(/[^a-zA-Z0-90-鿿Ѐ-ӿ가-힣]/g, "").length > 0;
  });

  const wordCount         = wordTokens.length;
  const charCountWithSp   = normalised.length;
  const charCountNoSp     = normalised.replace(/\s/g, "").length;

  const sources = zip.files.filter(f => PART_PATTERNS.some(p => p.test(f.path))).map(f => f.path);
  console.log(`[DOCX-XML] parts=${sources.join(",")} words=${wordCount} chars=${charCountNoSp}`);

  return {
    text:               fullText.slice(0, 50_000),
    wordCount,
    charCountWithSpace: charCountWithSp,
    charCountNoSpace:   charCountNoSp,
    detectedLanguage:   detectLanguage(fullText),
    method:             "docx-xml-direct",
    warning:            segments.length === 0 ? "DOCX에서 텍스트를 찾을 수 없습니다." : undefined,
  };
}

// ─── DOC (legacy binary) ─────────────────────────────────────────────────────

async function extractDoc(buf: Buffer): Promise<TextStats> {
  // word-extractor는 파일 경로를 받으므로 임시 파일에 기록
  const os   = await import("node:os");
  const fs   = await import("node:fs/promises");
  const tmp  = path.join(os.tmpdir(), `ve-doc-${Date.now()}.doc`);
  try {
    await fs.writeFile(tmp, buf);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const weModule = (await import("word-extractor" as any)) as any;
    const WordExtractor = weModule.default ?? weModule;
    const ext = new WordExtractor();
    const doc = await ext.extract(tmp);
    return stats(doc.getBody(), "word-extractor-doc");
  } finally {
    await (await import("node:fs/promises")).unlink(tmp).catch(() => undefined);
  }
}

// ─── PDF ─────────────────────────────────────────────────────────────────────

async function extractPdf(buf: Buffer): Promise<TextStats> {
  // pdf-parse 기본 옵션으로 텍스트 추출. 스캔본 PDF는 텍스트 빈 경우 있음.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mod      = (await import("pdf-parse")) as any;
  const pdfParse = mod.default ?? mod;
  const data     = await pdfParse(buf, { max: 0 });
  const text     = data.text ?? "";
  const warn     = text.trim().length === 0 ? "스캔 PDF — 텍스트 레이어 없음. 이미지로 재업로드를 권장합니다." : undefined;
  return stats(text, "pdf-parse", warn);
}

// ─── PPTX ────────────────────────────────────────────────────────────────────
// PPTX = ZIP. ppt/slides/slide*.xml 에서 <a:t>텍스트</a:t> 추출.

async function extractPptx(buf: Buffer): Promise<TextStats> {
  const unzipper = await import("unzipper");
  const zip      = await unzipper.Open.buffer(buf);

  const parts: string[] = [];
  const slideFiles = zip.files
    .filter(f => /^ppt\/slides\/slide\d+\.xml$/i.test(f.path))
    .sort((a, b) => a.path.localeCompare(b.path));

  for (const file of slideFiles) {
    const xml = (await file.buffer()).toString("utf8");
    const matches = xml.match(/<a:t[^>]*>([^<]*)<\/a:t>/g) ?? [];
    for (const m of matches) {
      const t = m.replace(/<[^>]+>/g, "").trim();
      if (t) parts.push(t);
    }
  }

  const text = parts.join(" ");
  const warn = text.length === 0 ? "PPTX에서 텍스트를 찾을 수 없습니다. 이미지로만 구성된 슬라이드일 수 있습니다." : undefined;
  return stats(text, "unzipper-pptx-xml", warn);
}

// ─── XLSX / XLS ──────────────────────────────────────────────────────────────

async function extractXlsx(buf: Buffer): Promise<TextStats> {
  const XLSX = await import("xlsx");
  const wb   = XLSX.read(buf, { type: "buffer" });
  const parts: string[] = [];
  for (const sheetName of wb.SheetNames) {
    const ws   = wb.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json<string[]>(ws, { header: 1, defval: "" });
    for (const row of rows) {
      for (const cell of row) {
        const v = String(cell ?? "").trim();
        if (v) parts.push(v);
      }
    }
  }
  return stats(parts.join(" "), "xlsx-parse");
}

// ─── Image / PDF-image → GPT-4o OCR ─────────────────────────────────────────

async function extractImageOcr(
  buf: Buffer,
  ext: string,
  apiKey: string,
  baseURL?: string,
): Promise<TextStats> {
  const { default: OpenAI }    = await import("openai");
  const { buildImageDataUrl }  = await import("./documentOcr");

  const openai  = new OpenAI({ apiKey, baseURL });
  const dataUrl = buildImageDataUrl(buf, ext);

  const resp = await openai.chat.completions.create({
    model:       "gpt-4o",
    temperature: 0,
    messages: [{
      role:    "user",
      content: [
        {
          type: "text",
          text: "이 이미지에서 보이는 모든 텍스트를 그대로 추출해 주세요. 추출한 텍스트만 출력하고, 설명이나 주석은 넣지 마세요.",
        },
        { type: "image_url", image_url: { url: dataUrl } },
      ],
    }],
  });

  const text = resp.choices[0]?.message?.content ?? "";
  return stats(text, "gpt4o-vision-ocr");
}

// ─── 공개 진입점 ─────────────────────────────────────────────────────────────

export async function extractText(
  buf:          Buffer,
  filename:     string,
  openaiApiKey?: string,
  openaiBaseURL?: string,
): Promise<TextStats> {
  const ext = path.extname(filename).toLowerCase();

  try {
    switch (ext) {
      case ".txt":            return extractTxt(buf);
      case ".docx":           return await extractDocx(buf);
      case ".doc":            return await extractDoc(buf);
      case ".pdf":            return await extractPdf(buf);
      case ".pptx":           return await extractPptx(buf);
      case ".ppt":
        // PPT binary — word-extractor가 부분 지원, 실패 시 빈 텍스트
        try { return await extractDoc(buf); } catch {
          return empty("ppt-fallback", "PPT 형식 추출 실패. PPTX 변환 후 업로드를 권장합니다.");
        }
      case ".xlsx":
      case ".xls":            return await extractXlsx(buf);
      case ".jpg":
      case ".jpeg":
      case ".png":
        if (openaiApiKey) return await extractImageOcr(buf, ext, openaiApiKey, openaiBaseURL);
        return empty("image-no-key", "이미지 OCR은 OpenAI API 키 설정 후 사용 가능합니다.");
      default:
        return empty("unsupported", `지원하지 않는 형식: ${ext}`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[TEXT-EXTRACT] ${filename} failed:`, msg);
    return empty(`${ext}-error`, `텍스트 추출 실패: ${msg.slice(0, 120)}`);
  }
}
