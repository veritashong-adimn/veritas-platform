// 전화번호 끝 4자리만 남긴 마스킹 값 (판매관리 수행정보 통번역사 검색 응답용).
// 화면의 phoneLast4(숫자만 추출 후 끝 4자리)와 호환: "***-****-1082" → "1082". 원본(DB)은 변경하지 않는다.
export function maskPhoneLast4(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const digits = String(phone).replace(/\D/g, "");
  return digits.length >= 4 ? `***-****-${digits.slice(-4)}` : null;
}
