/**
 * 매핑 로직 검증(순수) — 이미지 경로의 실제 코드(sourceFieldsFromLabelValueRows → mapSourceFieldsToForm)가
 * "vision 이 셀을 읽어 넘긴 라벨-값 행"으로부터 정답 폼값을 산출하는지 확인한다. (OpenAI 불필요)
 *
 * ⚠ 이것은 파싱/매핑/예시제거/라벨매칭 "로직" 검증이다. 최종 정확도는 반드시 실제 「통역의뢰 접수.PNG」로
 *   vision 까지 태워 검증해야 한다(별도). 여기 rows 는 문서에 기재된 셀 텍스트를 그대로 넣은 것이며 하드코딩 매칭이 아니다.
 */
import {
  sourceFieldsFromLabelValueRows,
  mapSourceFieldsToForm,
} from "../src/lib/inquirySourceFields";

// vision 이 각 값 칸에서 "보이는 그대로" 읽어 넘겼다고 가정한 라벨-값 행(예시 표기 포함).
// — interpretType/duration/place 는 예시 'ex) …' 가 붙어 있어도 코드가 제거해야 하고,
//   subject 는 서술형이라 원문(예시 포함)을 보존해야 한다.
const rows = [
  { label: "회사명",         value: "한국뷰로베리타스" },
  { label: "부서",           value: "CER" },
  { label: "담당자",         value: "조예리" },
  { label: "직함",           value: "사원" },
  { label: "전화번호",       value: "02-6925-5805" },
  { label: "휴대폰",         value: "010-2240-4330" },
  { label: "회사 E-mail",    value: "ye-ri.cho@bureauveritas.com" },
  { label: "서비스 유형",    value: "통역" },
  { label: "출발언어",       value: "한국어" },
  { label: "도착언어",       value: "말레이시아어" },
  { label: "통역의 형태",    value: "동시통역 ex) 동시통역, 순차통역" },
  { label: "통역 일정",      value: "2026-09-02" },
  { label: "1일 통역시간",   value: "9시간 ex) 8시간" },
  { label: "통역할 주제",    value: "일반통역 ex) 의학,법학" },
  { label: "통역 수행 장소", value: "말레이시아 ex) 말레이시아, 싱가포르" },
  { label: "요구 및 주의사항", value: "행사 당일 오전 8시까지 현장 도착 요망.\n통역사 2명 필요, 복장 정장." },
];

// 문서에 기재된 정답값
const expected: Record<string, string> = {
  customerCompanyName: "한국뷰로베리타스",
  department: "CER",
  contactName: "조예리",
  contactPosition: "사원",
  contactPhone: "02-6925-5805",
  contactMobile: "010-2240-4330",
  contactEmail: "ye-ri.cho@bureauveritas.com",
  serviceType: "interpretation",
  languageFrom: "한국어",
  languageTo: "말레이시아어",
  interpretType: "동시통역",
  scheduleFrom: "2026-09-02T09:00",
  interpretDuration: "9시간",
  subject: "일반통역 ex) 의학,법학",
  place: "말레이시아",
};

const sf = sourceFieldsFromLabelValueRows(rows, "document");
const { fields, warnings } = mapSourceFieldsToForm(sf);

const rowsOut: Array<[string, string, string, string, boolean]> = [];
const labelByFk: Record<string, string> = {
  customerCompanyName: "회사명", department: "부서", contactName: "담당자", contactPosition: "직함",
  contactPhone: "전화번호", contactMobile: "휴대폰", contactEmail: "이메일", serviceType: "서비스유형",
  languageFrom: "출발언어", languageTo: "도착언어", interpretType: "통역형태", scheduleFrom: "통역일정",
  interpretDuration: "1일 통역시간", subject: "통역주제", place: "통역장소",
};

let pass = 0;
for (const [fk, exp] of Object.entries(expected)) {
  const got = (fields as Record<string, string | undefined>)[fk] ?? "";
  const ok = got.trim() === exp.trim();
  if (ok) pass++;
  rowsOut.push([labelByFk[fk] ?? fk, exp, got, "", ok]);
}

const cell = (s: string, n = 30) => { const t = (s ?? "").replace(/\n/g, " ⏎ "); return t.length > n ? t.slice(0, n - 1) + "…" : t; };
console.log("| 필드 | 정답값 | 매핑 결과 | 일치 |");
console.log("|---|---|---|---|");
for (const [label, exp, got, , ok] of rowsOut) {
  console.log(`| ${label} | ${cell(exp)} | ${cell(got)} | ${ok ? "✅" : "❌"} |`);
}
console.log(`\n요약: ${pass}/${Object.keys(expected).length} 일치`);
if (warnings.length) { console.log("\n[warnings]"); warnings.forEach(w => console.log(" - " + w)); }
console.log("\n[요구사항 보존 확인]");
console.log("  raw:", JSON.stringify(sf.requirements?.raw));
console.log("  form:", JSON.stringify(fields.requirements));
