// ─── 통번역사 지역 표시 — 상세주소 제거 (개인정보 최소화) ────────────────────
// 판매관리 → 수행정보 통번역사 검색·미리보기에서 사용. 원본(DB) 값은 변경하지 않는다.
// web-app/src/lib/regionDisplay.ts 와 동일 규칙 (test-region-display 에서 일치 검증).
//
// 규칙
//  - 시·도 / 시·군·구 / 읍·면·동(가·리)까지만 남기고, 도로명·건물번호·건물명·층·동호수·상세주소는 제거한다.
//  - 도로명주소는 괄호 안에 원문으로 적힌 법정동(예: "(여의도동, 파크원)")이 있을 때만 동을 붙인다. 동을 추정·생성하지 않는다.
//  - "국가 / 지역" 형식은 국가 접두어를 유지하고 지역 부분에만 규칙을 적용한다.
//  - 행정구역을 확정할 수 없으면 확인 가능한 부분까지만(없으면 국가만) 표시한다.

const SIDO_SHORT = new Set([
  "서울", "부산", "대구", "인천", "광주", "대전", "울산", "세종", "제주",
  "경기", "강원", "충북", "충남", "전북", "전남", "경북", "경남",
]);
const RE_SIDO = /^[가-힣]+(특별시|광역시|특별자치시|특별자치도|도)$/;
const RE_SIGUNGU = /^[가-힣]+(시|군|구)$/;
const RE_EMD = /^[가-힣]+[0-9]*(읍|면|동|가|리)$/;        // 역삼1동, 종로1가 허용 / 101동·B동(동호수) 제외
const RE_DETAIL = /[0-9]|(로|길)$|번지|아파트|빌라|빌딩|오피스텔|타워|맨션|주택|층|호$|[#,]/;

type Level = 0 | 1 | 2 | 3; // 0=없음 1=시도 2=시군구 3=읍면동

function levelOf(tok: string): Level {
  if (RE_SIDO.test(tok) || SIDO_SHORT.has(tok) || /^[가-힣]+시$/.test(tok) && SIDO_SHORT.has(tok.slice(0, -1))) return 1;
  if (RE_SIGUNGU.test(tok)) return 2;
  if (RE_EMD.test(tok)) return 3;
  return 0;
}

/** 지역 부분(국가 접두어 제외)에서 행정구역만 남긴다 */
function maskLocal(raw: string): string {
  // 괄호 안 원문(도로명주소의 법정동·건물명) 분리
  const paren = raw.match(/\(([^)]*)\)/)?.[1] ?? "";
  const main = raw.replace(/\([^)]*\)/g, " ").replace(/,/g, " ");
  const tokens = main.split(/\s+/).filter(Boolean);

  const kept: string[] = [];
  let maxLevel: Level = 0;
  let stoppedAtRoad = false;
  for (const tok of tokens) {
    let lv = levelOf(tok);
    // "제주시", "세종시" 등은 첫 단어일 때만 시·도, 시·도 다음이면 시·군·구
    if (lv === 1 && kept.length > 0 && RE_SIGUNGU.test(tok)) lv = 2;
    if (lv > 0 && lv >= maxLevel) {
      // 같은 단계 반복은 시·군·구(예: 성남시 분당구)만 허용
      if (lv === maxLevel && lv !== 2) break;
      kept.push(tok); maxLevel = lv;
      if (lv === 3 && /(읍|면)$/.test(tok)) { maxLevel = 2; } // 읍·면 뒤 리 허용
      continue;
    }
    if (lv === 0 && kept.length === 0 && !RE_DETAIL.test(tok) && /^[가-힣A-Za-z.'-]+$/.test(tok)) {
      // 해외 도시 등 행정구역 접미사 없는 지역명(숫자·도로명·건물명 아님) — 최대 2단어
      const plain: string[] = [tok];
      const rest = tokens.slice(tokens.indexOf(tok) + 1);
      for (const t of rest) { if (plain.length >= 2 || RE_DETAIL.test(t) || !/^[가-힣A-Za-z.'-]+$/.test(t) || levelOf(t) > 0) break; plain.push(t); }
      return plain.join(" ");
    }
    stoppedAtRoad = /(로|길)$/.test(tok) || /^[0-9]/.test(tok);
    break;
  }
  // 도로명주소: 괄호 안에 원문으로 적힌 동이 있고, 아직 동이 없을 때만 보충
  if (stoppedAtRoad && kept.length > 0 && !kept.some(t => levelOf(t) === 3)) {
    const dong = paren.split(",").map(s => s.trim()).find(s => RE_EMD.test(s) && !/(읍|면)$/.test(s));
    if (dong) kept.push(dong);
  }
  return kept.join(" ");
}

/** 표시용 지역 문자열. 상세주소를 제거하며, 남는 정보가 없으면 null */
export function toDisplayRegion(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = raw.replace(/\s+/g, " ").trim();
  if (!s) return null;
  const slash = s.indexOf(" / ");
  if (slash >= 0) {
    const country = s.slice(0, slash).trim();
    const local = maskLocal(s.slice(slash + 3));
    return local ? `${country} / ${local}` : (country || null);
  }
  // 국가명 단독(예: "독일", "인도네시아") 또는 접두어 없는 국내 주소
  return maskLocal(s) || null;
}
