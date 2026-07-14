/**
 * 문서 텍스트 추출 엔진
 *
 * 지원 형식:
 *   TXT        → buffer.toString
 *   DOCX       → unzipper + OOXML XML 파싱 (app.xml Words 우선)
 *   DOC        → word-extractor
 *   HWP / HWPX → kordoc (HWP 3.x/5.x/HWPX/HWPML 전 버전)
 *   PDF        → pdf-parse
 *   PPTX       → unzipper + XML <a:t> 파싱
 *   PPT        → word-extractor (부분 지원)
 *   XLSX / XLS → xlsx
 *   JPG / PNG  → GPT-4o vision OCR
 *
 * 반환값: TextStats (wordCount, charCountWithSpace, charCountNoSpace, detectedLanguage 포함)
 */

import path from "node:path";

// ─── 타입 ───────────────────────────────────────────────────────────────────

export interface TextStats {
  text:               string;   // 추출 원문 (최대 50,000자)
  wordCount:          number;   // 단어수
  charCountWithSpace: number;   // 공백 포함 글자수
  charCountNoSpace:   number;   // 공백 제외 글자수
  detectedLanguage:   string;   // 'ko' | 'ja' | 'zh-hans' | 'zh-hant' | 'en' | 'unknown'
  method:             string;   // 추출 방식 (로그/디버그용)
  countBasis:         string;   // UI 표시용 분석 기준 레이블
  pageCount?:         number;   // 공식 문서 페이지수 (app.xml 등에서 추출)
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

function stats(raw: string, method: string, countBasis = "Text Extraction", warning?: string): TextStats {
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
    countBasis,
    warning,
  };
}

function empty(method: string, warning: string): TextStats {
  return {
    text: "", wordCount: 0, charCountWithSpace: 0, charCountNoSpace: 0,
    detectedLanguage: "unknown", method, countBasis: "Text Extraction", warning,
  };
}

// ─── TXT ─────────────────────────────────────────────────────────────────────

function extractTxt(buf: Buffer): TextStats {
  return stats(buf.toString("utf8"), "txt-buffer", "Text Extraction");
}

// ─── DOCX — 직접 XML 파싱 v2 (Word 기준 1% 오차 목표) ──────────────────────
//
// 포함 영역 (Microsoft Word "단어 개수" 대화상자의 기본 포함 항목):
//   word/document.xml        — 본문 + 인라인 텍스트박스(w:txbxContent)
//   word/header{n}.xml       — 섹션별 헤더 (홀/짝/첫 페이지)
//   word/footer{n}.xml       — 섹션별 푸터
//   word/footnotes.xml       — 각주
//   word/endnotes.xml        — 미주
//   word/drawings/drawing*.xml — DrawingML 도형 내 텍스트 (a:t)
//
// 처리 규칙:
//   <w:t>          → 텍스트 수집
//   <a:t>          → DrawingML/SmartArt 텍스트 수집 (Word에서 카운트)
//   <w:instrText>  → 필드 코드 스킵 (PAGE, DATE 등)
//   <w:del>        → 추적변경 삭제 텍스트 스킵
//   <mc:Fallback>  → AlternateContent 구버전 대체 스킵 (이중 카운트 방지)
//   <w:br><w:cr><w:tab> → 단어 경계 공백 주입
//   </w:p></w:tr>  → 단락/행 끝 공백 주입

/** XML 엔티티 디코딩 */
function decodeXmlEntities(s: string): string {
  return s
    .replace(/&amp;/g,  "&").replace(/&lt;/g, "<").replace(/&gt;/g,  ">")
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g,     (_, d) => String.fromCharCode(parseInt(d, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

/**
 * DrawingML 파서 — 차트/다이어그램 파일 전용 (word/charts/*.xml, word/diagrams/data*.xml).
 *
 * <a:t> 요소를 수집한다.
 * document.xml 에서 mc:Fallback 을 스킵하는 이유(이중카운트)가 이 파일들엔 없으므로
 * <a:t> 를 그대로 수집한다.
 */
function parseDmlXml(xml: string): string {
  const parts: string[] = [];
  // <a:t>…</a:t> 직접 추출 — DML 요소는 중첩 태그 없이 순수 텍스트만 포함
  const re = /<a:t[^>]*>([\s\S]*?)<\/a:t>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const text = decodeXmlEntities(m[1]);
    if (text.trim()) parts.push(text);
  }
  return parts.join(" ");
}

/**
 * Word/OOXML 시퀀셜 파서.
 * w:t 텍스트 수집 + 단어 경계 공백 주입.
 * mc:Fallback 스킵(mc:Choice w:txbxContent에서 이미 수집, 이중 카운트 방지).
 */
function parseWordXml(xml: string): string {
  const out: string[] = [];
  let i = 0;
  const n = xml.length;

  // 내부 내용을 통째로 스킵하는 태그
  const SKIP_TAGS = new Set([
    "w:instrText",    // 필드 코드
    "w:del",          // 추적변경 삭제
    "w:rPrChange",    // 서식 변경 메타
    "w:pPrChange",
    "w:sectPrChange",
    "w:tblPrChange",
    "mc:Fallback",    // AlternateContent 구버전 VML 대체 — mc:Choice w:txbxContent에서 이미 수집됨
  ]);

  // 단락/행 끝에 공백을 삽입할 닫는 태그
  const PARA_CLOSE = new Set(["w:p", "w:tr", "a:p"]);

  while (i < n) {
    if (xml[i] !== "<") { i++; continue; }

    // 태그 끝 탐색 (따옴표 내부 > 무시)
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

    const full    = xml.slice(i, j + 1);
    const inner   = full.slice(1, -1);
    const isClose = inner.startsWith("/");
    const isSelf  = inner.endsWith("/");
    const tagRaw  = isClose ? inner.slice(1) : inner;
    const tagName = tagRaw.split(/[\s/]/)[0] ?? "";

    i = j + 1;

    // ─ 스킵 태그: 닫는 태그까지 점프 ─────────────────────────────────────
    if (!isClose && !isSelf && SKIP_TAGS.has(tagName)) {
      const close = `</${tagName}>`;
      const k = xml.indexOf(close, i);
      if (k !== -1) i = k + close.length;
      continue;
    }

    // ─ 텍스트 수집: w:t (OOXML) ────────────────────────────────────────────
    // a:t (DrawingML) 는 mc:Fallback 내 <w:t>와 이중 카운트 발생으로 제외
    if (tagName === "w:t" && !isClose && !isSelf) {
      const k = xml.indexOf("</w:t>", i);
      if (k !== -1) {
        out.push(decodeXmlEntities(xml.slice(i, k)));
        i = k + 6;
      }
      continue;
    }

    // ─ 단어 경계 공백 ────────────────────────────────────────────────────
    if (!isClose) {
      if (tagName === "w:br" || tagName === "w:cr") { out.push(" "); continue; }
      if (tagName === "w:tab" || tagName === "a:tab") { out.push(" "); continue; }
    } else {
      if (PARA_CLOSE.has(tagName)) out.push(" ");
    }
  }

  return out.join("");
}

/**
 * Word 호환 단어수 카운터 (보조 계산용).
 *
 * Word의 실제 알고리즘:
 *   - 공백(\s) 기준 분리 (기본)
 *   - 슬래시(/) 는 단어 구분자: "mg/kg" = 2단어, "dose/response" = 2단어
 *   - Em/En dash(—, –) 는 단어 구분자
 *   - 하이픈(-) 은 단어 내부: "state-of-the-art" = 1단어
 *   - 어포스트로피(') 는 단어 내부: "it's" = 1단어
 *   - 순수 기호 토큰(알파뉴메릭 없음)은 제외
 */
function calcWordCount(text: string): number {
  const HAS_ALNUM = /[\p{L}\p{N}]/u;
  return text
    .replace(/[\r\n\t]+/g, " ")
    // 슬래시와 Em/En 대시를 공백으로 대체 (Word 단어 구분자)
    .replace(/[/–—]/g, " ")
    .trim()
    .split(/\s+/)
    .filter(w => w.length > 0 && HAS_ALNUM.test(w))
    .length;
}

/**
 * DOCX 전체 파트 텍스트 추출.
 *
 * 단어수 계산 방식 (우선순위 순):
 *   1순위: docProps/app.xml <Words> — Word "검토 → 단어 개수" 대화상자와 동일한 공식값.
 *          존재하면 이 값을 그대로 사용하고 "Word 공식 통계"로 표시.
 *   2순위: XML 파싱 (w:t 수집 + 슬래시/Em dash 구분자) — app.xml 공식값 없을 때 폴백.
 *          "Text Extraction"으로 표시.
 *
 * 파트별 단어수 로그로 누락 영역 진단 지원.
 */
async function extractDocx(buf: Buffer): Promise<TextStats> {
  const unzipper = await import("unzipper");
  const zip = await unzipper.Open.buffer(buf);

  // ── 1. docProps/app.xml — Word 공식 통계 (1순위) ─────────────────────────────
  // <Words>/<Characters>/<Pages> = Word "검토 → 단어 개수" 대화상자와 동일한 값.
  // Words가 존재하면 Text Extraction 없이 이 값을 직접 사용한다.
  let appXmlWords:     number | null = null;
  let appXmlCharsNoSp: number | null = null;
  let appXmlCharsWSp:  number | null = null;
  let appXmlPages:     number | null = null;

  // 경로 변형 허용: docProps/app.xml, ./docProps/app.xml, docProps\app.xml
  const appXmlFile = zip.files.find(f => /(?:^|[\\/])docprops[\\/]app\.xml$/i.test(f.path));

  // 진단: docProps/ 하위 파일 목록 출력
  const docPropsEntries = zip.files.filter(f => /docprops/i.test(f.path)).map(f => f.path);
  console.log(`[DOCX-XML] docProps entries(${docPropsEntries.length}): ${docPropsEntries.join(", ") || "(none)"}`);
  console.log(`[DOCX-XML] app.xml found: ${appXmlFile ? appXmlFile.path : "NO — fallback to xml-parse"}`);

  if (appXmlFile) {
    const appXml = (await appXmlFile.buffer()).toString("utf8");
    // 네임스페이스 접두사 허용: <Words>, <ep:Words>, <app:Words> 등
    const wm  = appXml.match(/<(?:\w+:)?Words>\s*(\d+)\s*<\/(?:\w+:)?Words>/i);
    const cm  = appXml.match(/<(?:\w+:)?Characters>\s*(\d+)\s*<\/(?:\w+:)?Characters>/i);
    const cwm = appXml.match(/<(?:\w+:)?CharactersWithSpaces>\s*(\d+)\s*<\/(?:\w+:)?CharactersWithSpaces>/i);
    const pm  = appXml.match(/<(?:\w+:)?Pages>\s*(\d+)\s*<\/(?:\w+:)?Pages>/i);
    if (wm)  appXmlWords     = parseInt(wm[1],  10);
    if (cm)  appXmlCharsNoSp = parseInt(cm[1],  10);
    if (cwm) appXmlCharsWSp  = parseInt(cwm[1], 10);
    if (pm)  appXmlPages     = parseInt(pm[1],  10);
    console.log(`[DOCX-XML] app.xml values — Words=${appXmlWords ?? "N/A"} Characters=${appXmlCharsNoSp ?? "N/A"} CharactersWithSpaces=${appXmlCharsWSp ?? "N/A"} Pages=${appXmlPages ?? "N/A"}`);
    if (appXmlWords === null) {
      console.warn(`[DOCX-XML] WARNING: app.xml exists but <Words> tag NOT found — falling back to xml-parse`);
      // 전체 내용을 출력하여 태그 형식 진단 가능하게 함
      console.log(`[DOCX-XML] app.xml FULL CONTENT:\n${appXml}`);
    }
  }

  // ── 2. XML 파트 파싱 — 텍스트 추출 (AI 분석용) + 파트별 단어수 로그 ────────
  const allPaths = zip.files.map(f => f.path);
  const wordXmlPaths = allPaths.filter(p =>
    p.startsWith("word/") && p.endsWith(".xml") && !p.includes("_rels")
  );
  console.log(`[DOCX-XML] all_word_parts(${wordXmlPaths.length}): ${wordXmlPaths.join(", ")}`);

  const COUNT_PATTERNS: Array<{ pat: RegExp; label: string; dml?: boolean }> = [
    { pat: /^word\/document\.xml$/i,                      label: "document"  },
    { pat: /^word\/header\d+\.xml$/i,                     label: "header"    },
    { pat: /^word\/footer\d+\.xml$/i,                     label: "footer"    },
    { pat: /^word\/footnotes\.xml$/i,                     label: "footnotes" },
    { pat: /^word\/endnotes\.xml$/i,                      label: "endnotes"  },
    { pat: /^word\/drawings\/drawing\d+\.xml$/i,          label: "drawing"   },
    // 차트 레이블/제목 (<a:t>) — Word 공식 통계와 일치시키기 위해 포함
    { pat: /^word\/charts\/chart\d+\.xml$/i,              label: "chart",   dml: true },
    // SmartArt 노드 텍스트 (<a:t>) — Word 공식 통계와 일치시키기 위해 포함
    { pat: /^word\/diagrams\/data\d+\.xml$/i,             label: "diagram", dml: true },
    { pat: /^word\/diagrams\/drawing\d+\.xml$/i,          label: "diagram", dml: true },
  ];

  const IGNORE_PAT = [
    /styles/, /settings/, /theme/, /numbering/, /fontTable/,
    /webSettings/, /app\.xml/, /core\.xml/, /custom/, /glossary/,
    /comments/, /customXml/, /media\//, /\.rels$/,
  ];
  const uncovered = wordXmlPaths.filter(p =>
    !COUNT_PATTERNS.some(({ pat }) => pat.test(p)) &&
    !IGNORE_PAT.some(ig => ig.test(p))
  );
  if (uncovered.length > 0) {
    console.log(`[DOCX-XML] UNCOVERED_PARTS: ${uncovered.join(", ")}`);
  }

  const segments: string[] = [];
  let xmlCalcWords = 0;

  for (const { pat, label, dml } of COUNT_PATTERNS) {
    const matched = zip.files
      .filter(f => pat.test(f.path))
      .sort((a, b) => a.path.localeCompare(b.path));

    for (const file of matched) {
      const xml  = (await file.buffer()).toString("utf8");
      // DML 파일(차트/다이어그램)은 <a:t> 수집, 일반 OOXML 파일은 <w:t> 수집
      const text = dml ? parseDmlXml(xml) : parseWordXml(xml);
      if (!text.trim()) continue;

      const wc = calcWordCount(text);
      xmlCalcWords += wc;
      segments.push(text);
      console.log(`[DOCX-XML] ${label} ${file.path}: ${wc} words${dml ? " (dml/a:t)" : " (ooxml/w:t)"}`);
    }
  }

  console.log(`[DOCX-XML] xml-calc total: ${xmlCalcWords} words`);

  // ── 3. 최종값 결정 ────────────────────────────────────────────────────────────
  // app.xml 공식값 우선 (Word 기준 정확도 최대화).
  // 없으면 XML 파싱값(슬래시/대시 구분자 적용) 폴백.
  const fullText   = segments.join(" ");
  const normalised = fullText.replace(/[\r\n\t]+/g, " ").trim();

  const wordCount  = appXmlWords     ?? xmlCalcWords;
  const charNoSp   = appXmlCharsNoSp ?? normalised.replace(/\s/g, "").length;
  const charWithSp = appXmlCharsWSp  ?? normalised.length;
  const useOfficial = appXmlWords != null;
  const countBasis = useOfficial ? "Word 공식 통계" : "Text Extraction";
  const countSource = useOfficial ? "app.xml" : "xml-parse(slash-split)";

  console.log(`[DOCX-XML] FINAL countBasis=${countBasis} wordCount=${wordCount} charNoSp=${charNoSp} charWithSp=${charWithSp} pages=${appXmlPages ?? "N/A"} (xml-calc=${xmlCalcWords})`);

  return {
    text:               fullText.slice(0, 50_000),
    wordCount,
    charCountWithSpace: charWithSp,
    charCountNoSpace:   charNoSp,
    detectedLanguage:   detectLanguage(fullText),
    method:             `docx-xml-${countSource}`,
    countBasis,
    pageCount:          appXmlPages ?? undefined,
    warning:            segments.length === 0 ? "DOCX에서 텍스트를 찾을 수 없습니다." : undefined,
  };
}

// ─── HWP / HWPX — kordoc ─────────────────────────────────────────────────────
//
// kordoc가 HWP 3.x/5.x, HWPX, HWPML 전 버전을 Markdown으로 변환한다.
// Markdown에서 문법 기호를 제거한 순수 텍스트로 단어수·글자수를 계산한다.

function stripMarkdownSyntax(md: string): string {
  return md
    .replace(/^#{1,6}\s+/gm, "")                    // 헤딩 기호 제거
    .replace(/\*\*([^*]*)\*\*/g, "$1")               // bold
    .replace(/\*([^*]*)\*/g, "$1")                   // italic
    .replace(/^\|[\s:|-]+\|\s*$/gm, "")              // 표 구분선
    .replace(/^\|(.*)\|$/gm, (_: string, inner: string) =>
      inner.split("|").map((c: string) => c.trim()).filter(Boolean).join(" "))  // 표 셀
    .replace(/```[\s\S]*?```/gm, "")                 // 코드 블록
    .replace(/`[^`]+`/g, "")                          // 인라인 코드
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")         // 링크
    .replace(/^[\s]*[-*+]\s+/gm, "")                  // 순서 없는 목록
    .replace(/^[\s]*\d+\.\s+/gm, "")                  // 순서 있는 목록
    .replace(/^[-*_]{3,}\s*$/gm, "")                  // 수평선
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function extractHwp(buf: Buffer, ext: string): Promise<TextStats> {
  // kordoc는 외부 패키지로 번들에서 제외됨 — 런타임 동적 로드
  const { parse } = await import("kordoc");

  const result = await parse(buf);

  if (!result.success) {
    const errMsg = result.error ?? "알 수 없는 오류";
    console.warn(`[HWP-KORDOC] 추출 실패 (${ext}): ${errMsg}`);
    return empty(`${ext}-kordoc-error`, `HWP/HWPX 추출 실패: ${errMsg.slice(0, 120)}`);
  }

  const markdown  = result.markdown;
  const plainText = stripMarkdownSyntax(markdown);
  const method    = `${ext.replace(".", "")}-kordoc`;

  // kordoc pageCount: HWP/HWPX는 섹션 수, 실제 페이지 계산은 aiQuoteDraft에서 수행
  const kordocPages = result.pageCount ?? undefined;
  console.log(`[HWP-KORDOC] ${ext} 추출 완료 — 마크다운 ${markdown.length}자 → 순수텍스트 ${plainText.length}자 (sections=${kordocPages ?? "N/A"})`);

  const st = stats(plainText, method, "Text Extraction");
  st.pageCount = kordocPages;
  return st;
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
    return stats(doc.getBody(), "word-extractor-doc", "Text Extraction");
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
  return stats(text, "pdf-parse", "Text Extraction", warn);
}

// ─── PPTX ────────────────────────────────────────────────────────────────────
// 1순위: docProps/app.xml <Slides>/<Words>/<Characters>/<CharactersWithSpaces>
// 2순위: ppt/slides/slide*.xml <a:t> 텍스트 추출

async function extractPptx(buf: Buffer): Promise<TextStats> {
  const unzipper = await import("unzipper");
  const zip      = await unzipper.Open.buffer(buf);

  // ── 1. docProps/app.xml — PowerPoint 공식 통계 ───────────────────────────
  let appWords:  number | null = null;
  let appChars:  number | null = null;
  let appCharsW: number | null = null;
  let appSlides: number | null = null;
  const appXmlFile = zip.files.find(f => /^docProps\/app\.xml$/i.test(f.path));
  if (appXmlFile) {
    const xml = (await appXmlFile.buffer()).toString("utf8");
    const wm  = xml.match(/<Words>(\d+)<\/Words>/i);
    const cm  = xml.match(/<Characters>(\d+)<\/Characters>/i);
    const cwm = xml.match(/<CharactersWithSpaces>(\d+)<\/CharactersWithSpaces>/i);
    const sm  = xml.match(/<Slides>(\d+)<\/Slides>/i);
    if (wm)  appWords  = parseInt(wm[1],  10);
    if (cm)  appChars  = parseInt(cm[1],  10);
    if (cwm) appCharsW = parseInt(cwm[1], 10);
    if (sm)  appSlides = parseInt(sm[1],  10);
    console.log(`[PPTX] app.xml: words=${appWords} chars=${appChars} slides=${appSlides}`);
  }

  // ── 2. 슬라이드 텍스트 추출 (AI 분석용 + 폴백 계산) ────────────────────
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
  const extractedText = parts.join(" ");

  // ── 3. 최종값 결정 ───────────────────────────────────────────────────────
  if (appWords != null) {
    // 공식 통계 사용
    const text = extractedText.trim().slice(0, 50_000);
    const warn = text.length === 0 ? "PPTX 텍스트 레이어 없음 — 이미지 슬라이드일 수 있습니다." : undefined;
    console.log(`[PPTX] 분석 기준: PowerPoint 공식 통계`);
    return {
      text,
      wordCount:          appWords,
      charCountNoSpace:   appChars  ?? extractedText.replace(/\s/g, "").length,
      charCountWithSpace: appCharsW ?? extractedText.length,
      detectedLanguage:   detectLanguage(extractedText),
      method:             "pptx-app.xml",
      countBasis:         "PowerPoint 공식 통계",
      pageCount:          appSlides ?? undefined,
      warning:            warn,
    };
  }

  // 폴백: 텍스트 추출
  const warn = extractedText.length === 0
    ? "PPTX에서 텍스트를 찾을 수 없습니다. 이미지로만 구성된 슬라이드일 수 있습니다."
    : undefined;
  console.log(`[PPTX] 분석 기준: Text Extraction (app.xml 없음)`);
  const st = stats(extractedText, "unzipper-pptx-xml", "Text Extraction", warn);
  st.pageCount = slideFiles.length > 0 ? slideFiles.length : undefined;
  return st;
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
  return stats(parts.join(" "), "xlsx-parse", "Text Extraction");
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
  return stats(text, "gpt4o-vision-ocr", "Text Extraction");
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
      case ".hwp":
      case ".hwpx":           return await extractHwp(buf, ext);
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
