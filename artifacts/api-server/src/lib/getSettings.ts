/**
 * getSettings — settings 테이블의 운영 설정을 로드하는 공유 헬퍼
 *
 * 우선순위: settings 테이블 → 환경변수 → 기본값
 * 모든 서비스(견적서, 정산, 결제)에서 동일하게 사용
 */
import { db, settingsTable } from "@workspace/db";

export type OperationalSettings = {
  // 문서
  quoteValidityDays: number;
  taxRate: number;
  quoteNotes: string | null;
  signatureImageUrl: string | null;
  // 결제
  defaultBillingType: string;
  paymentDueDays: number;
  allowPartialPayment: boolean;
  // 정산
  settlementRatio: number;       // 0~100 (예: 70 → 통번역사 70%, 플랫폼 30%)
  settlementCycle: string;
  applyWithholdingTax: boolean;
};

let _cache: OperationalSettings | null = null;
let _cacheAt = 0;
const CACHE_TTL_MS = 30_000; // 30초 캐시 (잦은 요청 방지)

export async function getSettings(): Promise<OperationalSettings> {
  const now = Date.now();
  if (_cache && now - _cacheAt < CACHE_TTL_MS) return _cache;

  const rows = await db.select().from(settingsTable).limit(1);
  const s = rows[0] ?? {};

  _cache = {
    quoteValidityDays:  s.quoteValidityDays  ?? 14,
    taxRate:            s.taxRate != null ? Number(s.taxRate) : 10,
    quoteNotes:         s.quoteNotes         ?? null,
    signatureImageUrl:  s.signatureImageUrl  ?? null,
    defaultBillingType: s.defaultBillingType ?? "postpaid_per_project",
    paymentDueDays:     s.paymentDueDays     ?? 7,
    allowPartialPayment: Boolean(s.allowPartialPayment ?? false),
    settlementRatio:    s.settlementRatio != null ? Number(s.settlementRatio) : 70,
    settlementCycle:    s.settlementCycle    ?? "monthly",
    applyWithholdingTax: Boolean(s.applyWithholdingTax ?? true),
  };
  _cacheAt = now;
  return _cache;
}

/** settings 캐시 무효화 (settings PATCH 후 호출) */
export function invalidateSettingsCache() {
  _cache = null;
  _cacheAt = 0;
}
