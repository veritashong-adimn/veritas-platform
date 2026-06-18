// ─── 증빙서류(신분증/통장사본) OCR/AI 분석 공통 유틸 ──────────────────────────
// Preview 전용 분석에서 사용. DB 저장은 이 파일에서 다루지 않음(라우트에서 처리).
import type OpenAI from "openai";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { constants as fsConstants } from "node:fs/promises";

export type DocType = "id_card" | "bankbook";

// ── 분석 지원 형식 ────────────────────────────────────────────────────────────
const OCR_SUPPORTED_EXTS = [".jpg", ".jpeg", ".png", ".pdf"] as const;

export function isOcrSupportedExt(ext: string): boolean {
  return (OCR_SUPPORTED_EXTS as readonly string[]).includes(ext.toLowerCase());
}

/**
 * pdftoppm 실행 파일 경로를 찾는다.
 * Railway/Nixpacks 환경에서는 PATH가 Node.js 프로세스에 온전히 전달되지 않을 수 있어
 * which 외에 알려진 고정 경로도 탐색한다.
 */
async function findPdftoppm(): Promise<string | null> {
  // 1) which로 먼저 시도
  const fromWhich = await new Promise<string | null>(resolve => {
    execFile("which", ["pdftoppm"], (e, out) => resolve(e ? null : (out.trim() || null)));
  });
  if (fromWhich) return fromWhich;

  // 2) nixpkgs/Railway가 symlink를 생성하는 알려진 경로들
  const candidates = [
    "/nix/var/nix/profiles/default/bin/pdftoppm",
    "/usr/bin/pdftoppm",
    "/usr/local/bin/pdftoppm",
    "/opt/homebrew/bin/pdftoppm",
  ];
  for (const p of candidates) {
    try { await fs.access(p, fsConstants.X_OK); return p; } catch { /* not found */ }
  }
  return null;
}

// PDF 첫 페이지를 PNG 버퍼로 렌더링 (pdftoppm 사용 — 스캔본 신분증/통장사본 대응)
export async function renderPdfFirstPageAsPng(pdfBuffer: Buffer): Promise<Buffer> {
  const pdftoppmBin = await findPdftoppm();
  if (!pdftoppmBin) {
    throw new Error(
      "PDF를 이미지로 변환할 수 없습니다. 서버에 pdftoppm(poppler-utils)이 설치되지 않았습니다. " +
      "JPG 또는 PNG 이미지로 직접 업로드해 주세요."
    );
  }

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ocr-pdf-"));
  const pdfPath = path.join(tmpDir, "input.pdf");
  const outPrefix = path.join(tmpDir, "page");
  try {
    await fs.writeFile(pdfPath, pdfBuffer);
    // -r 200: 200 DPI (OCR 품질 충분), -png: PNG 출력, -f 1 -l 1: 첫 페이지만
    await new Promise<void>((resolve, reject) => {
      execFile(
        pdftoppmBin,
        ["-r", "200", "-png", "-f", "1", "-l", "1", pdfPath, outPrefix],
        { timeout: 30_000, env: { ...process.env, HOME: process.env.HOME ?? "/root" } },
        (err, _stdout, stderr) => {
          if (err) reject(new Error(`pdftoppm(${pdftoppmBin}): ${stderr?.trim() || err.message}`));
          else resolve();
        },
      );
    });
    const files = await fs.readdir(tmpDir);
    const pngFile = files.find(f => f.startsWith("page") && f.endsWith(".png"));
    if (!pngFile) throw new Error("pdftoppm 출력 파일을 찾을 수 없습니다. PDF가 손상되었거나 빈 파일일 수 있습니다.");
    return await fs.readFile(path.join(tmpDir, pngFile));
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
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
