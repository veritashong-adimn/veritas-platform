/**
 * 중국어 언어 옵션 정책 (productType별 표시/제외 규칙)
 *
 * 번역(TR)/감수(PR): zh-hans, zh-hant, yue  — script 기반, zh(통합) 제외
 * 통역(IN)/통번역(CO): zh, yue              — spoken 기반, zh-hans/zh-hant 제외
 */

/** productType에 따라 LanguageSearchSelect에서 제외할 zh 계열 코드 반환 */
export function getZhExcludeCodes(productType: string): string[] {
  if (productType === "interpretation" || productType === "combined") return ["zh-hans", "zh-hant"];
  return ["zh"]; // translation/proofreading + 기타 언어형
}

/**
 * productType 전환 시 zh 코드 자동 정규화
 * 통역/통번역으로 전환: zh-hans/zh-hant → zh  (spoken language 기준 통합)
 * 번역/감수로 전환: zh → zh-hans              (script 기반, 간체 기본값)
 */
export function normalizeZhForType(code: string, targetProductType: string): string {
  if (targetProductType === "interpretation" || targetProductType === "combined") {
    if (code === "zh-hans" || code === "zh-hant") return "zh";
  } else {
    if (code === "zh") return "zh-hans";
  }
  return code;
}
