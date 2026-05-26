// ─── Display Name Policy ─────────────────────────────────────────────────────
// canonical displayName 생성 규칙 및 분류 집합
// products.ts analyzeProductStructure에서 import해서 사용

// 통역 subtype canonical 집합 — displayName을 "언어-언어 subtype" 형식으로 생성
// 새로운 subtype 추가 시 반드시 여기에도 추가
export const INTERP_SUBTYPES = new Set([
  "동시통역",
  "순차통역",
  "위스퍼링통역",
  "수행통역",
  "VIP수행통역",
  "가이드통역",
  "전화통역",
  "화상통역",
  "미팅통역",
  "전시회통역",
  "현장통역",
  "수행비서통역",
  "통역",            // generic fallback — 항상 마지막
]);

// 통역장비 canonical 집합 — isInterp 및 displayName 분기에 사용
export const EQUIP_CANONICALS = new Set([
  "동시통역장비",
  "위스퍼링장비",
  "PA장비",
  "통역부스",
  "통역장비",
  "수신기",
  "송신기",
  "헤드셋",
]);
