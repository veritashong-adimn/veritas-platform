// ─── Language Alias Registry ──────────────────────────────────────────────────
// 업계 관용 compact 단음절 약어 → ISO code 매핑
// (LANG_ENTRIES의 단음절 SEP_RX 가드를 우회하는 compact pattern 전처리에서만 사용)
export const COMPACT_SINGLE_CHAR_MAP: Record<string, string> = {
  한: "ko",
  영: "en",
  중: "zh-hans",
  일: "ja",
  태: "th",
  베: "vi",
  인: "id",
  캄: "km",
  불: "fr",
  프: "fr",
  독: "de",
  러: "ru",
  터: "tr",
  서: "es",    // 서반아어 약어
  포: "pt",
  아: "ar",
  몽: "mn",
  말: "ms",
  덴: "da",
  노: "no",
  핀: "fi",
  헝: "hu",
  루: "ro",
  체: "cs",
};

// compact pattern 뒤에 허용되는 서비스 키워드 (긴 것 먼저)
export const COMPACT_SERVICE_KEYWORDS = [
  "원어민감수",
  "공증번역",
  "전문번역",
  "번역",
  "통역",
  "감수",
] as const;
