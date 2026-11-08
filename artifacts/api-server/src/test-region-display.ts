// 판매관리 수행정보 — 통번역사 지역 표시(상세주소 제거) 검증. DB 쓰기 없음.
//   서버(api-server/src/lib/regionDisplay)와 화면(web-app/src/lib/regionDisplay) 규칙 일치도 함께 확인한다.
// 실행: pnpm run test:region-display
import { toDisplayRegion as server } from "./lib/regionDisplay";
import { toDisplayRegion as web } from "../../web-app/src/lib/regionDisplay";
import { maskPhoneLast4 } from "./lib/phoneMask";
// 화면 phoneLast4(TranslatorPreviewPopover)와 동일 로직 — 숫자만 추출 후 끝 4자리
const phoneLast4 = (p?: string | null) => { if (!p) return null; const d = String(p).replace(/\D/g, ""); return d.length >= 4 ? d.slice(-4) : null; };

let pass = 0, fail = 0;
const check = (label: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log(`  ✅ ${label}`); } else { fail++; console.log(`  ❌ ${label}`, JSON.stringify(extra ?? "")); }
};

const CASES: Array<[string, string | null, string | null]> = [
  // [설명, 입력, 기대값]
  ["도로명+괄호 법정동+건물명", "서울특별시 영등포구 여의대로 108 (여의도동, 파크원)", "서울특별시 영등포구 여의도동"],
  ["도로명+동호수(괄호 동 없음) → 시군구까지", "대한민국 / 경기도 고양시 덕양구 화정로 123, 101동 1203호", "대한민국 / 경기도 고양시 덕양구"],
  ["도로명+층", "서울 강남구 테헤란로 123 4층", "서울 강남구"],
  ["도로명(읍)", "경기도 김포시 고촌읍 상미로 12", "경기도 김포시 고촌읍"],
  ["도로명(국가 없음)", "경기도 성남시 분당구 내정로 54 302동 1104호", "경기도 성남시 분당구"],
  ["지번+아파트 동호수", "서울특별시 강남구 역삼동 123-45 래미안아파트 101동 1203호", "서울특별시 강남구 역삼동"],
  ["지번(번지 공백 구분)", "서울특별시 강남구 역삼동 999 999", "서울특별시 강남구 역삼동"],
  ["지번", "서울특별시 도봉구 쌍문동 123-4", "서울특별시 도봉구 쌍문동"],
  ["지번+번지 표기", "부산광역시 해운대구 우동 1234번지", "부산광역시 해운대구 우동"],
  ["숫자 포함 행정동", "서울특별시 강남구 역삼1동 678-9", "서울특별시 강남구 역삼1동"],
  ["숫자 포함 가", "서울시 종로구 종로1가 1 2층", "서울시 종로구 종로1가"],
  ["읍+리", "경기도 양평군 양평읍 양근리 12-3", "경기도 양평군 양평읍 양근리"],
  ["제주시", "제주특별자치도 제주시 연동 123", "제주특별자치도 제주시 연동"],
  ["기존 지역 형식 유지", "대한민국 / 서울", "대한민국 / 서울"],
  ["기존 지역 형식 유지(시군구)", "대한민국 / 경기도 부천시", "대한민국 / 경기도 부천시"],
  ["기존 지역 형식 유지(약칭 도시)", "대한민국 / 수원", "대한민국 / 수원"],
  ["해외 도시", "미국 / 로스앤젤레스", "미국 / 로스앤젤레스"],
  ["국가 단독", "독일", "독일"],
  ["행정구역 불명(도로명만) → 국가만", "대한민국 / 화정로 123", "대한민국"],
  ["행정구역 불명(번지만) → 없음", "123-45 래미안 101동", null],
  ["영문 주소(번지 시작) → 국가만", "미국 / 123 Main St, Apt 4B", "미국"],
  ["동을 추정하지 않음(괄호 건물명만)", "서울특별시 영등포구 여의대로 108 (파크원)", "서울특별시 영등포구"],
  ["빈 값", "", null],
  ["null", null, null],
];

console.log("\n[R] 지역 표시 규칙");
for (const [label, input, expected] of CASES) {
  const s = server(input), w = web(input);
  check(`${label}: "${input}" → "${expected}"`, s === expected, s);
  check(`${label}: 서버·화면 동일`, s === w, [s, w]);
}

console.log("\n[P] 상세주소 비노출 (숫자·도로명·동호수·층·건물명이 남지 않음)");
for (const [, input] of CASES) {
  const out = server(input) ?? "";
  const leaked = /[0-9]{2,}|(로|길)(\s|$)|[0-9]+동\b|[0-9]+호|층|아파트|파크원|래미안|Main St|Apt/.test(out.replace(/역삼1동|종로1가/g, ""));
  check(`"${input}" → "${out}"`, !leaked, out);
}

console.log("\n[T] 연락처 마스킹 (검색 응답 view=picker)");
const PHONES: Array<[string | null, string | null]> = [
  ["010-1234-1082", "1082"], ["01012341082", "1082"], ["+82-10-1234-1082", "1082"], ["02-123-4567", "4567"], ["123", null], [null, null],
];
for (const [ph, last4] of PHONES) {
  const masked = maskPhoneLast4(ph);
  check(`"${ph}" → "${masked}" (화면 끝4자리 "${last4}")`, phoneLast4(masked) === last4 && phoneLast4(ph) === last4, [masked, phoneLast4(masked)]);
  const full = (ph ?? "").replace(/\D/g, "");
  check(`"${ph}" 응답에 전체 번호 없음`, !masked || (masked.replace(/\D/g, "").length === 4 && (full.length <= 4 || !masked.replace(/\D/g, "").includes(full))), masked);
}

console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
process.exit(fail > 0 ? 1 : 0);
