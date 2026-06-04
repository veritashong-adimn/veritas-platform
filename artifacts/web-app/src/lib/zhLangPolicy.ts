/**
 * 중국어 언어 옵션 정책 (productType별 표시/제외 규칙)
 *
 * 번역(TR):    zh-hans, zh-hant, yue  — script 기반, zh(통합) 제외
 * 통역(IN):    zh, yue                — spoken 기반, zh-hans/zh-hant 제외
 * 통번역(CO):  zh, zh-hans, zh-hant, yue — mixed mode, 모두 표시
 */

/** productType에 따라 LanguageSearchSelect에서 제외할 zh 계열 코드 반환 */
export function getZhExcludeCodes(productType: string): string[] {
  if (productType === "interpretation") return ["zh-hans", "zh-hant"];
  if (productType === "combined")       return [];
  return ["zh"]; // translation + 기타 언어형 상품
}

/**
 * productType 전환 시 zh 코드 자동 정규화
 * 통역으로 전환: zh-hans/zh-hant → zh  (spoken language 기준 통합)
 * 번역으로 전환: zh → zh-hans           (script 기반, 간체 기본값)
 * 통번역:        변환 없음
 */
export function normalizeZhForType(code: string, targetProductType: string): string {
  if (targetProductType === "interpretation") {
    if (code === "zh-hans" || code === "zh-hant") return "zh";
  } else if (targetProductType !== "combined") {
    if (code === "zh") return "zh-hans";
  }
  return code;
}
