// ─── 증빙서류(신분증/통장사본) OCR/AI 분석 공통 유틸 ──────────────────────────
// Preview 전용 분석에서 사용. DB 저장은 이 파일에서 다루지 않음(라우트에서 처리).
import type OpenAI from "openai";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — legacy build 타입 선언이 없음; 런타임 동작 정상
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";
import { createCanvas } from "@napi-rs/canvas";

// Node.js 환경: legacy 빌드 + import.meta.resolve로 실제 worker 경로 지정
pdfjsLib.GlobalWorkerOptions.workerSrc = import.meta.resolve(
  "pdfjs-dist/legacy/build/pdf.worker.mjs",
);

export type DocType = "id_card" | "bankbook";

// ── 분석 지원 형식 ────────────────────────────────────────────────────────────
const OCR_SUPPORTED_EXTS = [".jpg", ".jpeg", ".png", ".pdf"] as const;

export function isOcrSupportedExt(ext: string): boolean {
  return (OCR_SUPPORTED_EXTS as readonly string[]).includes(ext.toLowerCase());
}

// PDF 첫 페이지를 PNG 버퍼로 렌더링 (pdfjs-dist + @napi-rs/canvas — 순수 JS, 시스템 바이너리 불필요)
export async function renderPdfFirstPageAsPng(pdfBuffer: Buffer): Promise<Buffer> {
  console.log(`[PDFJS] load — bytes=${pdfBuffer.byteLength}`);

  const pdf = await pdfjsLib.getDocument({
    data: new Uint8Array(pdfBuffer),
    useSystemFonts: true, // Node.js 환경에서 폰트 리소스 오류 방지
    verbosity: 0,         // pdfjs 내부 경고 억제
  }).promise;

  console.log(`[PDFJS] page — numPages=${pdf.numPages}`);

  const page = await pdf.getPage(1);
  const viewport = page.getViewport({ scale: 2.0 }); // ~144DPI — OCR 품질 충분
  const w = Math.round(viewport.width);
  const h = Math.round(viewport.height);

  console.log(`[PDFJS] render start — w=${w} h=${h}`);

  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext("2d");

  // pdfjs-dist CanvasFactory 구현 (@napi-rs/canvas API와 매핑)
  const canvasFactory = {
    create(width: number, height: number) {
      const c = createCanvas(width, height);
      return { canvas: c, context: c.getContext("2d") };
    },
    reset(cac: { canvas: ReturnType<typeof createCanvas> }, width: number, height: number) {
      cac.canvas.width = width;
      cac.canvas.height = height;
    },
    destroy(cac: { canvas: ReturnType<typeof createCanvas> }) {
      cac.canvas.width = 0;
      cac.canvas.height = 0;
    },
  };

  await page.render({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    canvasContext: ctx as any,
    viewport,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    canvasFactory: canvasFactory as any,
  }).promise;

  console.log(`[PDFJS] render ok`);

  const buf = canvas.toBuffer("image/png");
  console.log(`[PDFJS] buffer size — bytes=${buf.byteLength}`);

  page.cleanup();
  await pdf.destroy();

  return buf;
}

function mimeForExt(ext: string): string {
  return ext.toLowerCase() === ".png" ? "image/png" : "image/jpeg";
}

export function buildImageDataUrl(buffer: Buffer, ext: string): string {
  return `data:${mimeForExt(ext)};base64,${buffer.toString("base64")}`;
}

// ── 은행명 목록 (프론트 SensitiveInfoModal.BANK_LIST와 동기화 유지) ───────────
export const BANK_LIST = [
  "국민은행", "신한은행", "우리은행", "하나은행", "기업은행",
  "농협은행", "카카오뱅크", "케이뱅크", "토스뱅크", "SC제일은행",
  "씨티은행", "우체국", "수협은행", "산업은행", "부산은행",
  "대구은행", "광주은행", "전북은행", "경남은행", "제주은행",
  "새마을금고", "신협",
] as const;

export function matchBankName(raw: string | null): { matched: string | null; bankNameMatched: boolean } {
  if (!raw || !raw.trim()) return { matched: null, bankNameMatched: false };
  const trimmed = raw.trim();
  const exact = BANK_LIST.find(b => b === trimmed);
  if (exact) return { matched: exact, bankNameMatched: true };
  const partial = BANK_LIST.find(b => trimmed.includes(b.replace("은행", "")) || b.includes(trimmed));
  if (partial) return { matched: partial, bankNameMatched: true };
  return { matched: trimmed, bankNameMatched: false };
}

// ── 주민등록번호 정규화/검증 ───────────────────────────────────────────────────
export function normalizeResidentNumber(raw: string | null): { normalized: string | null; valid: boolean } {
  if (!raw) return { normalized: null, valid: false };
  const digits = raw.replace(/[^0-9]/g, "");
  if (digits.length !== 13) return { normalized: digits ? digits : null, valid: false };
  return { normalized: `${digits.slice(0, 6)}-${digits.slice(6)}`, valid: true };
}

// ── 계좌번호 정규화 (숫자/하이픈만 허용) ──────────────────────────────────────
export function normalizeBankAccount(raw: string | null): string | null {
  if (!raw) return null;
  const cleaned = raw.replace(/[^0-9-]/g, "").trim();
  return cleaned || null;
}

// ── 이름 비교 (공백 무시, 대소문자 무시) ──────────────────────────────────────
export function namesMatch(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return true; // 비교 대상이 없으면 불일치로 간주하지 않음(경고 표시 안 함)
  const norm = (s: string) => s.replace(/\s+/g, "").toLowerCase();
  return norm(a) === norm(b);
}

// ── Vision 프롬프트 빌더 ───────────────────────────────────────────────────────
const ID_CARD_SYSTEM_PROMPT = `당신은 한국 신분증(주민등록증/운전면허증) 이미지에서 정보를 추출하는 OCR 도우미입니다.
이미지에서 명확하게 식별 가능한 정보만 추출하고, 추측하거나 임의로 생성하지 마세요.
다음 JSON 스키마로만 응답하세요:
{"name": string|null, "residentNumber": string|null, "address": string|null, "confidence": "high"|"medium"|"low", "notes": string|null}
- name: 이름 (한글)
- residentNumber: 주민등록번호 13자리 숫자만 (하이픈 제외). 일부만 보이거나 불확실하면 null.
- address: 주소 전체 (시/구/동 단위까지 가능한 한 상세히)
- confidence: 이미지 품질과 추출 확신도
- notes: 흐릿함, 일부 가려짐 등 특이사항. 없으면 null
신분증이 아니거나 정보를 읽을 수 없으면 모든 필드를 null로, confidence는 "low"로 응답하세요.`;

const BANKBOOK_SYSTEM_PROMPT = `당신은 한국 통장사본/계좌 정보 이미지에서 정보를 추출하는 OCR 도우미입니다.
이미지에서 명확하게 식별 가능한 정보만 추출하고, 추측하거나 임의로 생성하지 마세요.
다음 JSON 스키마로만 응답하세요:
{"bankName": string|null, "accountHolder": string|null, "bankAccount": string|null, "confidence": "high"|"medium"|"low", "notes": string|null}
- bankName: 은행명 (예: 국민은행, 신한은행)
- accountHolder: 예금주명
- bankAccount: 계좌번호 (숫자와 하이픈만)
- confidence: 이미지 품질과 추출 확신도
- notes: 흐릿함, 일부 가려짐 등 특이사항. 없으면 null
통장사본이 아니거나 정보를 읽을 수 없으면 모든 필드를 null로, confidence는 "low"로 응답하세요.`;

export function buildOcrPromptMessages(
  docType: DocType,
  imageDataUrl: string,
): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
  const systemPrompt = docType === "id_card" ? ID_CARD_SYSTEM_PROMPT : BANKBOOK_SYSTEM_PROMPT;
  return [
    { role: "system", content: systemPrompt },
    {
      role: "user",
      content: [
        { type: "text", text: "이 이미지에서 정보를 추출해 JSON으로 응답하세요." },
        { type: "image_url", image_url: { url: imageDataUrl, detail: "high" } },
      ],
    },
  ];
}

// ── 감사로그용 마스킹 헬퍼 (원문 절대 노출 금지) ──────────────────────────────
export function maskForLog(value: string | null | undefined): string | null {
  if (!value) return null;
  if (value.length <= 4) return "*".repeat(value.length);
  return `${value.slice(0, 2)}***${value.slice(-2)} (len:${value.length})`;
}
