// ─── 증빙서류(신분증/통장사본) OCR/AI 분석 공통 유틸 ──────────────────────────
// Preview 전용 분석에서 사용. DB 저장은 이 파일에서 다루지 않음(라우트에서 처리).
import type OpenAI from "openai";

export type DocType = "id_card" | "bankbook" | "business_license" | "contact_card";

// ── 분석 지원 형식 ────────────────────────────────────────────────────────────
const OCR_SUPPORTED_EXTS = [".jpg", ".jpeg", ".png", ".pdf"] as const;

export function isOcrSupportedExt(ext: string): boolean {
  return (OCR_SUPPORTED_EXTS as readonly string[]).includes(ext.toLowerCase());
}

// OCR 패키지를 실제 사용 시점에만 동적 로드 — 서버 시작 시 로드하지 않음.
// Node.js dynamic import는 첫 호출 후 모듈 캐시에 저장되므로 반복 호출 오버헤드 없음.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function loadOcrModules(): Promise<{ pdfjsLib: any; createCanvas: (w: number, h: number) => any }> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs") as any;
  const { createCanvas } = await import("@napi-rs/canvas");
  pdfjsLib.GlobalWorkerOptions.workerSrc = import.meta.resolve(
    "pdfjs-dist/legacy/build/pdf.worker.mjs",
  );
  return { pdfjsLib, createCanvas };
}

// PDF 첫 페이지를 PNG 버퍼로 렌더링 (pdfjs-dist + @napi-rs/canvas — lazy load)
export async function renderPdfFirstPageAsPng(pdfBuffer: Buffer): Promise<Buffer> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let pdfjsLib: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let createCanvas: (w: number, h: number) => any;

  try {
    ({ pdfjsLib, createCanvas } = await loadOcrModules());
    console.log("[OCR] pdfjs-dist + @napi-rs/canvas loaded OK");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[OCR] LOAD FAILED — ${msg}`);
    throw new Error(`OCR 패키지 로드 실패: ${msg}`);
  }

  console.log(`[PDFJS] load — bytes=${pdfBuffer.byteLength}`);

  const pdf = await pdfjsLib.getDocument({
    data: new Uint8Array(pdfBuffer),
    useSystemFonts: true,
    verbosity: 0,
  }).promise;

  console.log(`[PDFJS] page — numPages=${pdf.numPages}`);

  const page = await pdf.getPage(1);
  const viewport = page.getViewport({ scale: 2.0 });
  const w = Math.round(viewport.width);
  const h = Math.round(viewport.height);

  console.log(`[PDFJS] render start — w=${w} h=${h}`);

  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext("2d");

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const canvasFactory = {
    create(width: number, height: number) {
      const c = createCanvas(width, height);
      return { canvas: c, context: c.getContext("2d") };
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    reset(cac: { canvas: any }, width: number, height: number) {
      cac.canvas.width = width;
      cac.canvas.height = height;
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    destroy(cac: { canvas: any }) {
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

// ── 예금주 정규화 (은행 앱 호칭 접미사 제거) ─────────────────────────────────
// 은행 앱/화면에서 "홍길동 님", "(주)베리타스 고객님" 등으로 표시되는 호칭을 제거한다.
// 긴 패턴을 먼저 검사해 부분 매칭 오작동을 방지한다.
export function normalizeAccountHolder(raw: string | null): string | null {
  if (!raw) return null;
  const HONORIFICS = ["고객님", "님께", "님의", "귀하", "님"];
  let result = raw.trim();
  for (const h of HONORIFICS) {
    if (result.endsWith(h)) {
      result = result.slice(0, -h.length);
      break;
    }
  }
  return result.trim().replace(/\s+/g, " ") || null;
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

const BUSINESS_LICENSE_SYSTEM_PROMPT = `당신은 한국 사업자등록증 이미지에서 정보를 추출하는 OCR 도우미입니다.
이미지에서 명확하게 식별 가능한 정보만 추출하고, 추측하거나 임의로 생성하지 마세요.
다음 JSON 스키마로만 응답하세요:
{"name": string|null, "businessNumber": string|null, "representativeName": string|null, "registeredAt": string|null, "industry": string|null, "businessCategory": string|null, "address": string|null, "vendorType": string|null, "confidence": "high"|"medium"|"low", "notes": string|null}
- name: 상호(법인명 또는 사업장명)
- businessNumber: 사업자등록번호 (원문 그대로, 하이픈 포함. 예: "123-45-67890")
- representativeName: 대표자 성명
- registeredAt: 개업연월일 (ISO 형식 YYYY-MM-DD. 예: "2020-01-15"). 날짜 불명확하면 null.
- industry: 업태 (예: 제조, 서비스, 도·소매)
- businessCategory: 종목 (예: 번역, 통역, 소프트웨어개발)
- address: 사업장 소재지 전체 주소
- vendorType: 아래 목록에서 가장 적합한 값 하나를 선택하세요. 적합한 항목이 없으면 "etc"를 반환합니다.
  통번역: 통번역업체, 번역업체, 통역업체, 감수업체, 편집업체, DTP업체, 자막업체, 녹취업체, 속기사
  행사·운영: 통역장비, 음향장비, 영상장비, 행사운영, 행사인력, MC, 사회자, 촬영, 사진, 영상제작
  디자인·마케팅: 디자인, 인쇄, 홈페이지 제작, 광고대행, 마케팅, 홍보물 제작
  IT: 개발, AI 개발, 서버, 클라우드, 보안
  물류·시설: 택배, 퀵서비스, 물류, 배송, 청소, 생수, 케이터링, 도시락, 사무용품
  전문서비스: 법무, 회계, 세무, 노무, 특허, 인증, 컨설팅
  예시: 번역→번역업체, 통역→통역업체, 번역·통역→통번역업체, DTP→DTP업체, 소프트웨어→개발, 청소용역→청소, 생수도매→생수
  고객사(최종 소비 기업)처럼 명확히 서비스 판매자가 아닌 경우 null을 반환합니다.
- confidence: 이미지 품질과 추출 확신도
- notes: 흐릿함, 일부 가려짐 등 특이사항. 없으면 null
사업자등록증이 아니거나 정보를 읽을 수 없으면 모든 필드를 null로, confidence는 "low"로 응답하세요.`;

const CONTACT_CARD_SYSTEM_PROMPT = `당신은 명함, 이메일 서명, 연락처 이미지에서 담당자 정보를 추출하는 AI 도우미입니다.
이미지에서 명확하게 식별 가능한 정보만 추출하고, 추측하거나 임의로 생성하지 마세요.
다음 JSON 스키마로만 응답하세요:
{"contactName": string|null, "companyName": string|null, "department": string|null, "position": string|null, "email": string|null, "mobilePhone": string|null, "officePhone": string|null, "companyPhone": string|null, "fax": string|null, "website": string|null, "memo": string|null, "confidence": "high"|"medium"|"low", "notes": string|null}
- contactName: 담당자 이름 (한글 또는 영문)
- companyName: 회사명/브랜드명 (명함에 표시된 그대로)
- department: 부서명 (팀, 본부, 사업부 포함)
- position: 직책/직위 (예: 과장, Manager, 팀장, 대리)
- email: 이메일 주소 (E-MAIL, EMAIL 등 표시)
- mobilePhone: 휴대폰 번호 (숫자만). Mobile, Cell, HP, M., 휴대폰 표시 우선
- officePhone: 담당자 직통 전화번호 (숫자만). Direct, 직통, 직장전화, D. 표시만 해당. 대표전화·TEL은 officePhone에 넣지 말 것
- companyPhone: 회사 대표전화 (숫자만). TEL, Tel., T., 대표전화, 본사 표시
- fax: 팩스 번호 (숫자만). FAX, Fax, F., 팩스 표시
- website: 홈페이지/웹사이트 URL. www., http, 홈페이지 표시
- memo: 위 항목(companyPhone, fax, website)에 이미 들어간 항목은 memo에 반복하지 말 것. SNS 계정, 슬로건, 기타 잡다한 정보만. 없으면 null
- confidence: 이미지 품질과 추출 확신도 ("high"=명확, "medium"=일부 불명확, "low"=대부분 불명확)
- notes: 흐릿함, 일부 가려짐 등 특이사항. 없으면 null
명함/서명이 아니거나 정보를 읽을 수 없으면 모든 필드를 null로, confidence는 "low"로 응답하세요.`;

export function buildOcrPromptMessages(
  docType: DocType,
  imageDataUrl: string,
): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
  const systemPrompt =
    docType === "id_card"           ? ID_CARD_SYSTEM_PROMPT :
    docType === "business_license"  ? BUSINESS_LICENSE_SYSTEM_PROMPT :
    docType === "contact_card"      ? CONTACT_CARD_SYSTEM_PROMPT :
    BANKBOOK_SYSTEM_PROMPT;
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
