import React from 'react';

// ─── 해외현지 통역 입력(빠른 상품 조회/생성 → 통역 → 해외현지 통역) ─────────────────
//  · 통역방식(기존 통역 유형 재사용) + 국가 + 도시(선택). 목록에 없으면 직접입력.
//  · 상품명: "일본 오사카 현지 한국어-일본어 상담회통역" / 도시 미선택: "일본 현지 …"
//  · 저장 구조·코드 규칙은 서버(lazyProductGen.applyOverseas)가 담당. 이 파일은 입력 UI·표시값만.

export const OVERSEAS_METHODS = ["상담회통역", "순차통역", "동시통역", "위스퍼링통역", "수행통역"] as const;
export type OverseasMethod = typeof OVERSEAS_METHODS[number];

const CUSTOM = "__custom__";

/** 국가 → 주요 도시(선택 목록). 목록에 없으면 직접입력. */
export const COUNTRY_CITIES: { country: string; cities: string[] }[] = [
  { country: "일본",       cities: ["도쿄", "오사카", "나고야", "후쿠오카", "요코하마", "삿포로", "교토"] },
  { country: "중국",       cities: ["베이징", "상하이", "광저우", "선전", "칭다오", "톈진", "항저우"] },
  { country: "미국",       cities: ["뉴욕", "로스앤젤레스", "샌프란시스코", "라스베이거스", "시카고", "워싱턴 D.C.", "애틀랜타"] },
  { country: "독일",       cities: ["베를린", "프랑크푸르트", "뮌헨", "뒤셀도르프", "하노버", "함부르크", "쾰른"] },
  { country: "베트남",     cities: ["하노이", "호치민", "다낭"] },
  { country: "대만",       cities: ["타이베이", "타이중", "가오슝"] },
  { country: "홍콩",       cities: [] },
  { country: "싱가포르",   cities: [] },
  { country: "태국",       cities: ["방콕"] },
  { country: "인도네시아", cities: ["자카르타"] },
  { country: "인도",       cities: ["뉴델리", "뭄바이", "벵갈루루"] },
  { country: "아랍에미리트", cities: ["두바이", "아부다비"] },
  { country: "영국",       cities: ["런던"] },
  { country: "프랑스",     cities: ["파리"] },
  { country: "이탈리아",   cities: ["밀라노", "로마"] },
  { country: "스페인",     cities: ["바르셀로나", "마드리드"] },
  { country: "캐나다",     cities: ["토론토", "밴쿠버"] },
  { country: "호주",       cities: ["시드니", "멜버른"] },
  { country: "멕시코",     cities: ["멕시코시티"] },
  { country: "러시아",     cities: ["모스크바"] },
];

export type OverseasState = {
  method: OverseasMethod;
  country: string;       // 국가명 또는 CUSTOM
  countryCustom: string;
  city: string;          // "" = 미선택, 도시명 또는 CUSTOM
  cityCustom: string;
};

export const EMPTY_OVERSEAS: OverseasState = { method: "상담회통역", country: "", countryCustom: "", city: "", cityCustom: "" };

/** 서버 전송값 — 국가 미입력이면 null */
export function resolveOverseas(s: OverseasState): { country: string; city?: string } | null {
  const country = (s.country === CUSTOM ? s.countryCustom : s.country).trim();
  if (!country) return null;
  const city = (s.city === CUSTOM ? s.cityCustom : s.city).trim();
  return city ? { country, city } : { country };
}

/** 미리보기용 위치 접두어 — "일본 오사카 현지" / "일본 현지" / "국가 현지" */
export function overseasPrefix(s: OverseasState): string {
  const loc = resolveOverseas(s);
  if (!loc) return "국가 현지";
  return `${loc.country}${loc.city ? ` ${loc.city}` : ""} 현지`;
}

const label: React.CSSProperties = { fontSize: 10, fontWeight: 600, color: "#9ca3af", marginBottom: 4 };
const selectStyle: React.CSSProperties = {
  padding: "7px 10px", fontSize: 13, borderRadius: 6, border: "1px solid #d1d5db", color: "#111827", background: "#fff", minWidth: 130,
};
const inputStyle: React.CSSProperties = { ...selectStyle, fontSize: 12, padding: "6px 10px", marginTop: 4, width: 150, minWidth: 0 };

export function OverseasInterpFields({ value, onChange, chip }: {
  value: OverseasState;
  onChange: (patch: Partial<OverseasState>) => void;
  /** 기존 칩 스타일 재사용(활성 여부 → 스타일) */
  chip: (active: boolean) => React.CSSProperties;
}) {
  const countryCfg = COUNTRY_CITIES.find(c => c.country === value.country);
  const cities = countryCfg?.cities ?? [];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }} data-testid="overseas-fields">
      <div>
        <div style={label}>통역방식</div>
        <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
          {OVERSEAS_METHODS.map(m => (
            <button key={m} type="button" onClick={() => onChange({ method: m })} style={chip(value.method === m)}
              aria-label={`통역방식 ${m}`} data-testid={`overseas-method-${m}`}>{m}</button>
          ))}
        </div>
      </div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-start" }}>
        <div style={{ display: "flex", flexDirection: "column" }}>
          <div style={label}>국가 *</div>
          <select value={value.country} style={selectStyle} aria-label="국가 선택" data-testid="overseas-country"
            onChange={e => onChange({ country: e.target.value, city: "", cityCustom: "" })}>
            <option value="">국가 선택</option>
            {COUNTRY_CITIES.map(c => <option key={c.country} value={c.country}>{c.country}</option>)}
            <option value={CUSTOM}>기타(직접입력)</option>
          </select>
          {value.country === CUSTOM && (
            <input value={value.countryCustom} onChange={e => onChange({ countryCustom: e.target.value })}
              placeholder="국가명 입력" maxLength={30} style={inputStyle} aria-label="국가명 직접 입력" data-testid="overseas-country-custom" />
          )}
        </div>
        <div style={{ display: "flex", flexDirection: "column" }}>
          <div style={label}>도시 <span style={{ fontWeight: 400 }}>(선택)</span></div>
          <select value={value.city} style={selectStyle} aria-label="도시 선택" data-testid="overseas-city"
            disabled={!value.country} onChange={e => onChange({ city: e.target.value })}>
            <option value="">도시 미선택</option>
            {cities.map(c => <option key={c} value={c}>{c}</option>)}
            <option value={CUSTOM}>기타(직접입력)</option>
          </select>
          {value.city === CUSTOM && (
            <input value={value.cityCustom} onChange={e => onChange({ cityCustom: e.target.value })}
              placeholder="도시명 입력" maxLength={30} style={inputStyle} aria-label="도시명 직접 입력" data-testid="overseas-city-custom" />
          )}
        </div>
      </div>
    </div>
  );
}
