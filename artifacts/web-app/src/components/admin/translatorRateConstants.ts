import { LANGUAGE_CODES } from "../../lib/constants";

export const SERVICE_TYPES = ["번역", "통역", "감수", "편집", "미디어", "DTP"] as const;

export const SUB_SERVICE_TYPES: Record<string, string[]> = {
  "번역": ["일반번역", "전문번역", "긴급번역", "공증번역"],
  "통역": ["동시통역", "위스퍼링통역", "순차통역", "수행통역", "미팅통역", "전시회통역", "화상통역", "전화통역"],
  "감수": ["교정", "윤문", "원어민감수", "원문대조감수"],
  "편집": ["문서편집", "리라이팅"],
  "미디어": ["자막작업", "더빙"],
  "DTP": ["디자인작업"],
};

export const TRANS_UNITS = [
  { value: "word", label: "단어" },
  { value: "eojeol", label: "어절" },
  { value: "char", label: "글자" },
  { value: "page", label: "페이지" },
  { value: "item", label: "건" },
];

export const INTERP_UNITS = [
  { value: "1h", label: "1시간" },
  { value: "2h", label: "2시간" },
  { value: "4h", label: "4시간" },
  { value: "6h", label: "6시간" },
  { value: "8h", label: "8시간" },
  { value: "extra", label: "추가시간" },
  { value: "day", label: "일" },
  { value: "item", label: "건" },
];

export const MEDIA_UNITS = [
  { value: "min", label: "분" },
  { value: "item", label: "건" },
  { value: "project", label: "프로젝트" },
];

export const UNIT_BY_SERVICE_TYPE: Record<string, { value: string; label: string }[]> = {
  "번역": TRANS_UNITS,
  "통역": INTERP_UNITS,
  "감수": TRANS_UNITS,
  "편집": TRANS_UNITS,
  "미디어": MEDIA_UNITS,
  "DTP": TRANS_UNITS,
};

export const ALL_RATE_UNITS = [
  ...TRANS_UNITS,
  ...INTERP_UNITS.filter(u => !TRANS_UNITS.some(t => t.value === u.value)),
  ...MEDIA_UNITS.filter(u => !TRANS_UNITS.some(t => t.value === u.value) && !INTERP_UNITS.some(i => i.value === u.value)),
];

export const getRateUnitLabel = (unit: string) =>
  ALL_RATE_UNITS.find(u => u.value === unit)?.label ?? unit;

export const CURRENCIES = ["KRW", "USD", "EUR", "JPY", "GBP", "CAD", "AUD", "CNY", "HKD", "SGD"];

export const LANG_LABEL_OPTIONS = LANGUAGE_CODES.map(l => l.label);
