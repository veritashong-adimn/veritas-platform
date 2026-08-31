/**
 * 의뢰서 원문추출/매핑 검증 하니스 — 라우트와 "동일한 실제 파이프라인"(services/inquiryAiPipeline) 사용.
 *
 * 사용:
 *   node scripts/runTestInquiryExtraction.mjs <이미지경로>     # 실제 이미지(PNG/PDF/JPG) — OpenAI vision 사용
 *   node scripts/runTestInquiryExtraction.mjs <텍스트파일.txt>  # 라벨:값 원문 텍스트
 *   node scripts/runTestInquiryExtraction.mjs                    # 인자 없으면 안내
 *
 * 실제 「통역의뢰 접수.PNG」 경로를 넘기면, 이미지 → 원문추출(vision 행) → 필드매핑까지 실제로 돌려
 * "필드 | AI 원문 추출값(sourceFields.raw) | 실제 폼 입력값 | 일치/불일치" 표를 출력한다.
 * (별도 테스트 데이터를 만들지 않는다 — 반드시 실제 파일로 실행한다.)
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { extractText } from "../src/lib/textExtractor";
import { analyzeInquiry, type VisionImg } from "../src/services/inquiryAiPipeline";
import type { SourceFields, MappedFields } from "../src/lib/inquirySourceFields";

async function main() {
  const target = process.argv[2];
  if (!target) {
    console.error("사용법: node scripts/dist-harness/testInquiryExtraction.mjs <이미지 또는 텍스트 파일의 절대경로>");
    console.error("예: node scripts/dist-harness/testInquiryExtraction.mjs /home/runner/workspace/attached_assets/통역의뢰_접수.PNG");
    process.exit(1);
  }

  const apiKey  = process.env.AI_INTEGRATIONS_OPENAI_API_KEY;
  const baseURL = process.env.AI_INTEGRATIONS_OPENAI_BASE_URL;
  const ext = path.extname(target).toLowerCase();
  const isImage = [".png", ".jpg", ".jpeg", ".pdf"].includes(ext);
  const buf = readFileSync(target);
  const name = path.basename(target);

  let pastedText = "";
  let ocrText = "";
  const visionContents: VisionImg[] = [];

  if (isImage) {
    // 실제 라우트와 동일: extractText(OCR) + vision 이미지 컨텍스트
    try {
      const st = await extractText(buf, name, apiKey, baseURL);
      ocrText = `### 파일: ${name}\n${st.text.slice(0, 8000)}`;
      console.log(`[하니스] OCR method=${st.method} chars=${st.charCountWithSpace}`);
    } catch (e) { console.error("[하니스] extractText 실패:", e); }
    const { renderPdfFirstPageAsPng, buildImageDataUrl } = await import("../src/lib/documentOcr");
    let imgBuf = buf; let imgExt = ext;
    if (ext === ".pdf") { imgBuf = await renderPdfFirstPageAsPng(buf); imgExt = ".png"; }
    visionContents.push({ type: "image_url", image_url: { url: buildImageDataUrl(imgBuf, imgExt), detail: "high" } });
  } else {
    pastedText = buf.toString("utf8");
  }

  const out = await analyzeInquiry({ pastedText, ocrText, visionContents, apiKey, baseURL });
  const sf: SourceFields = out.sourceFields;
  const fields = out.fields as Partial<MappedFields>;

  // 비교표 행: [표시라벨, 원문 sourceKey, 폼 필드키, 판정종류]
  type Row = { label: string; sk: keyof SourceFields; fk: keyof MappedFields; kind: "copy" | "contains" | "derived" };
  const rows: Row[] = [
    { label: "회사명",       sk: "companyName",     fk: "customerCompanyName", kind: "copy" },
    { label: "부서",         sk: "department",      fk: "department",          kind: "copy" },
    { label: "담당자",       sk: "contactName",     fk: "contactName",         kind: "copy" },
    { label: "직함",         sk: "contactPosition", fk: "contactPosition",     kind: "copy" },
    { label: "전화번호",     sk: "contactPhone",    fk: "contactPhone",        kind: "copy" },
    { label: "휴대폰",       sk: "contactMobile",   fk: "contactMobile",       kind: "copy" },
    { label: "이메일",       sk: "contactEmail",    fk: "contactEmail",        kind: "copy" },
    { label: "출발언어",     sk: "languageFrom",    fk: "languageFrom",        kind: "copy" },
    { label: "도착언어",     sk: "languageTo",      fk: "languageTo",          kind: "copy" },
    { label: "통역형태",     sk: "interpretType",   fk: "interpretType",       kind: "contains" },
    { label: "1일 통역시간", sk: "interpretDuration", fk: "interpretDuration", kind: "copy" },
    { label: "통역일정",     sk: "schedule",        fk: "scheduleFrom",        kind: "derived" },
    { label: "통역장소",     sk: "place",           fk: "place",               kind: "copy" },
    { label: "통역주제",     sk: "subject",         fk: "subject",             kind: "copy" },
    { label: "요구사항",     sk: "requirements",    fk: "requirements",        kind: "copy" },
  ];

  const oneLine = (s: string | undefined) => (s ?? "").replace(/\n/g, " ⏎ ");
  const cell = (s: string | undefined, n = 44) => {
    const t = oneLine(s);
    return t.length > n ? t.slice(0, n - 1) + "…" : t;
  };

  const lines: string[] = [];
  lines.push("| 필드 | AI 원문 추출값 | 실제 폼 입력값 | 일치/불일치 |");
  lines.push("|---|---|---|---|");
  for (const r of rows) {
    const raw = sf[r.sk]?.raw ?? "";
    const form = (fields as Record<string, string | undefined>)[r.fk] ?? "";
    let ok: boolean;
    if (r.kind === "copy") ok = raw.trim() !== "" && form.trim() === raw.trim();
    else if (r.kind === "contains") ok = form.trim() !== "" && raw.replace(/\s+/g, "").includes(form.replace(/\s+/g, "").slice(0, 2));
    else ok = form.trim() !== "";
    lines.push(`| ${r.label} | ${cell(raw)} | ${cell(form)} | ${ok ? "✅ 일치" : "❌ 불일치/누락"} |`);
  }

  console.log(`\n입력: ${target}  (구조화=${out.debug.structured}, 매칭라벨=${out.debug.matchedCount}, 신뢰도=${out.confidence})`);
  if (out.debug.visionRows.length) {
    console.log("\n[vision 행추출 — 이미지에서 읽은 라벨:값]");
    for (const rw of out.debug.visionRows) console.log(`  ${rw.label} : ${rw.value.replace(/\n/g, " ⏎ ")}`);
  }
  console.log("\n" + lines.join("\n"));
  if (out.warnings.length) {
    console.log("\n[warnings]");
    for (const w of out.warnings) console.log(" - " + w);
  }
  console.log("\n[sourceFields.raw 전체]");
  for (const [k, v] of Object.entries(sf)) console.log(`  ${k}: "${v?.raw}"  (라벨="${v?.sourceLabel}", ${v?.origin})`);
}

main().catch(e => { console.error(e); process.exit(1); });
