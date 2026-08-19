import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "crypto";

const ALGORITHM = "aes-256-gcm";

const KEY = (() => {
  const secret = process.env.SENSITIVE_ENCRYPT_KEY ?? "dev-fallback-key-change-in-prod-!!";
  return scryptSync(secret, "translator-sensitive-v1", 32);
})();

export function encrypt(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, KEY, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("hex")}:${tag.toString("hex")}:${encrypted.toString("hex")}`;
}

export function decrypt(data: string): string {
  const parts = data.split(":");
  if (parts.length !== 3) throw new Error("Invalid encrypted format");
  const [ivHex, tagHex, encHex] = parts;
  const iv = Buffer.from(ivHex, "hex");
  const tag = Buffer.from(tagHex, "hex");
  const enc = Buffer.from(encHex, "hex");
  const decipher = createDecipheriv(ALGORITHM, KEY, iv);
  decipher.setAuthTag(tag);
  return decipher.update(enc).toString("utf8") + decipher.final("utf8");
}

export function maskResidentNumber(raw: string): string {
  const digits = raw.replace(/[^0-9]/g, "");
  if (digits.length === 13) {
    return `${digits.slice(0, 6)}-*******`;
  }
  return "******-*******";
}

// ── 계좌번호 보안 유틸 ────────────────────────────────────────────────────────
//  · translator_sensitive.bankAccount 는 레거시로 평문/암호문이 혼재한다(벌크임포트는 암호문 저장,
//    수동/문서OCR 경로는 평문 저장). 신규 표준 컬럼 bankAccountEnc 는 항상 암호문이다.
//  · 아래 헬퍼는 두 형태를 모두 안전하게 처리한다. 어떤 화면/로그에도 평문 계좌번호를 노출하지 않는다.

// 우리 암호문 포맷(iv:tag:cipher, 모두 hex)인지 감지. 레거시 평문과 구분용.
export function isEncryptedPayload(s: string | null | undefined): boolean {
  if (!s) return false;
  const parts = s.split(":");
  return parts.length === 3 && parts.every((p) => p.length > 0 && /^[0-9a-fA-F]+$/.test(p));
}

// 계좌번호를 "암호문"으로 정규화한다(snapshot 저장·표준 컬럼 기록용).
//  · enc(bankAccountEnc)가 있으면 그대로 사용.
//  · 없으면 legacy(bankAccount)를 보고 암호문이면 그대로, 평문이면 encrypt() 후 반환.
//  · 어느 쪽도 없으면 null. (원본 컬럼은 이 함수가 바꾸지 않는다)
export function toEncryptedAccount(
  enc: string | null | undefined,
  legacy: string | null | undefined,
): string | null {
  const e = enc?.trim();
  if (e) return e;
  const l = legacy?.trim();
  if (!l) return null;
  return isEncryptedPayload(l) ? l : encrypt(l);
}

// 계좌번호 평문을 복원한다(검증·형식 확인 등 서버 내부 처리 전용, 응답/로그 노출 금지).
export function readAccountPlain(
  enc: string | null | undefined,
  legacy: string | null | undefined,
): string | null {
  const src = enc?.trim() || legacy?.trim() || "";
  if (!src) return null;
  if (isEncryptedPayload(src)) {
    try { return decrypt(src); } catch { return null; }
  }
  return src; // 레거시 평문
}

// 일반 화면 표시용 마스킹(뒤 4자리만 노출). 예: "1234567890" → "******7890".
export function maskBankAccount(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const digits = raw.replace(/[^0-9]/g, "");
  if (!digits) return null;
  if (digits.length <= 4) return "*".repeat(digits.length);
  return "*".repeat(digits.length - 4) + digits.slice(-4);
}

// 계좌번호 형식 유효성(국내 은행계좌: 숫자 10~16자리). 형식만 검사(실제 계좌 존재는 미확인).
export function isValidBankAccountFormat(raw: string | null | undefined): boolean {
  if (!raw) return false;
  const digits = raw.replace(/[^0-9]/g, "");
  return digits.length >= 10 && digits.length <= 16;
}
