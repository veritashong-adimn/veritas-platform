import React, { useState, useRef, useEffect } from "react";
import { api, normalizeLanguages, LangExpEntry, emptyLangExp } from "../../lib/constants";
import { PrimaryBtn, GhostBtn, ClickSelect } from "../ui";
import { DraggableModal } from "./DraggableModal";
import { PAYMENT_METHODS, SETTLEMENT_TYPES } from "./SensitiveInfoModal";
import {
  CURRENCIES,
  SERVICE_TYPES as PROFILE_WORK_TYPES,
  SUB_SERVICE_TYPES as PROFILE_SUB_TYPES_MAP,
  SPECIALIZATION_PRESETS,
} from "./translatorRateConstants";
import { TranslatorRateEntryCard, RateEntryData, emptyRateEntry } from "./TranslatorRateEntryCard";
import { ResumeAnalyzePanel, ResumeAnalysisResult } from "./ResumeAnalyzePanel";
import { TranslatorLangExpSection } from "./TranslatorLangExpSection";

// ── 학력 ────────────────────────────────────────────────────────────────
const EDUCATION_DOMESTIC = [
  "한국외국어대학교 통번역대학원",
  "서울외국어대학원대학교 통번역대학원",
  "이화여자대학교 통역번역대학원",
  "부산외국어대학교 통번역대학원",
  "제주대학교 통번역대학원",
  "선문대학교 통번역대학원",
  "중앙대학교 국제대학원",
];
const EDUCATION_OVERSEAS = [
  "Macquarie University",
  "Middlebury Institute of International Studies at Monterey",
  "Monterey Institute of International Studies",
  "University of Bath",
  "University of Westminster",
  "University of Leeds",
  "Université Paris Cité ESIT",
  "Université Sorbonne Nouvelle ESIT",
  "University of Geneva FTI",
  "University of Ottawa",
];

const EDUCATION_ALL = [...EDUCATION_DOMESTIC, ...EDUCATION_OVERSEAS];

// ── 전공 ────────────────────────────────────────────────────────────────
const MAJOR_LANGUAGE = ["한영과", "한중과", "한일과", "한불과", "한독과", "한서과", "한노과", "한아과", "한영통번역", "한중통번역", "한일통번역"];
const MAJOR_INTERPRETATION = ["통번역학", "전문통번역학", "국제회의통역", "국제회의전공", "통역전공", "번역전공", "통번역전공"];
const MAJOR_SPECIALIZED = ["의료통역전공", "법률통번역전공", "영상번역전공", "AI번역전공"];
const MAJOR_ALL = [...MAJOR_LANGUAGE, ...MAJOR_INTERPRETATION, ...MAJOR_SPECIALIZED];

// ── 졸업 ────────────────────────────────────────────────────────────────
const _CURRENT_YEAR = new Date().getFullYear();
const GRAD_YEARS = Array.from({ length: _CURRENT_YEAR + 5 - 1979 }, (_, i) => String(_CURRENT_YEAR + 5 - i));
const GRADUATION_STATUS_OPTIONS = ["졸업", "졸업예정", "재학중", "수료", "중퇴", "기타"];

// ── 거주지역 ─────────────────────────────────────────────────────────────
const REGION_COUNTRIES = [
  "대한민국",
  "미국", "캐나다", "영국", "호주", "뉴질랜드",
  "일본", "중국", "대만", "홍콩", "싱가포르",
  "말레이시아", "태국", "베트남", "인도네시아", "필리핀", "인도",
  "독일", "프랑스", "이탈리아", "스페인", "네덜란드", "벨기에", "스위스", "오스트리아",
  "러시아", "UAE", "사우디아라비아", "카타르",
  "멕시코", "브라질",
  "기타",
] as const;

const KOREA_REGIONS = [
  "서울특별시", "경기도", "인천광역시",
  "부산광역시", "대구광역시", "대전광역시", "광주광역시", "울산광역시",
  "세종특별자치시",
  "강원특별자치도", "충청북도", "충청남도",
  "전북특별자치도", "전라남도",
  "경상북도", "경상남도",
  "제주특별자치도",
] as const;

const KOREA_REGION_DISTRICTS: readonly string[] = [
  "서울특별시 강남구", "서울특별시 강동구", "서울특별시 강북구", "서울특별시 강서구",
  "서울특별시 관악구", "서울특별시 광진구", "서울특별시 구로구", "서울특별시 금천구",
  "서울특별시 노원구", "서울특별시 도봉구", "서울특별시 동대문구", "서울특별시 동작구",
  "서울특별시 마포구", "서울특별시 서대문구", "서울특별시 서초구", "서울특별시 성동구",
  "서울특별시 성북구", "서울특별시 송파구", "서울특별시 양천구", "서울특별시 영등포구",
  "서울특별시 용산구", "서울특별시 은평구", "서울특별시 종로구", "서울특별시 중구",
  "서울특별시 중랑구",
  "경기도 수원시", "경기도 성남시", "경기도 고양시", "경기도 용인시",
  "경기도 안양시", "경기도 안산시", "경기도 의정부시", "경기도 부천시",
  "경기도 광명시", "경기도 평택시", "경기도 동두천시", "경기도 과천시",
  "경기도 구리시", "경기도 남양주시", "경기도 오산시", "경기도 시흥시",
  "경기도 군포시", "경기도 의왕시", "경기도 하남시", "경기도 파주시",
  "경기도 이천시", "경기도 안성시", "경기도 김포시", "경기도 화성시",
  "경기도 광주시", "경기도 양주시", "경기도 포천시", "경기도 여주시",
  "인천광역시 중구", "인천광역시 동구", "인천광역시 미추홀구", "인천광역시 연수구",
  "인천광역시 남동구", "인천광역시 부평구", "인천광역시 계양구", "인천광역시 서구",
  "부산광역시 중구", "부산광역시 서구", "부산광역시 동구", "부산광역시 영도구",
  "부산광역시 부산진구", "부산광역시 동래구", "부산광역시 남구", "부산광역시 북구",
  "부산광역시 해운대구", "부산광역시 사하구", "부산광역시 금정구", "부산광역시 강서구",
  "부산광역시 연제구", "부산광역시 수영구", "부산광역시 사상구", "부산광역시 기장군",
  "대구광역시 중구", "대구광역시 동구", "대구광역시 서구", "대구광역시 남구",
  "대구광역시 북구", "대구광역시 수성구", "대구광역시 달서구", "대구광역시 달성군",
  "대전광역시 동구", "대전광역시 중구", "대전광역시 서구", "대전광역시 유성구", "대전광역시 대덕구",
  "광주광역시 동구", "광주광역시 서구", "광주광역시 남구", "광주광역시 북구", "광주광역시 광산구",
  "울산광역시 중구", "울산광역시 남구", "울산광역시 동구", "울산광역시 북구", "울산광역시 울주군",
  "세종특별자치시",
  "제주특별자치도 제주시", "제주특별자치도 서귀포시",
];
const KOREA_ALL_OPTIONS: readonly string[] = [...KOREA_REGIONS, ...KOREA_REGION_DISTRICTS];

const OVERSEAS_CITIES: Record<string, readonly string[]> = {
  "일본": ["도쿄", "오사카", "요코하마", "나고야", "후쿠오카", "교토", "고베", "삿포로", "히로시마", "센다이"],
  "미국": ["캘리포니아주 로스앤젤레스", "캘리포니아주 샌프란시스코", "뉴욕주 뉴욕", "일리노이주 시카고", "텍사스주 댈러스", "텍사스주 휴스턴", "워싱턴주 시애틀", "조지아주 애틀랜타", "워싱턴 D.C."],
  "중국": ["베이징", "상하이", "광저우", "선전", "항저우", "난징", "칭다오", "톈진", "청두"],
  "대만": ["타이베이", "신베이", "타이중", "타이난", "가오슝"],
  "홍콩": ["홍콩", "구룡", "신계"],
  "싱가포르": ["싱가포르"],
  "말레이시아": ["쿠알라룸푸르", "조호르바루", "페낭"],
  "태국": ["방콕", "치앙마이", "푸켓"],
  "베트남": ["하노이", "호치민", "다낭"],
  "인도네시아": ["자카르타", "수라바야", "발리"],
  "필리핀": ["마닐라", "세부", "클락"],
  "인도": ["뉴델리", "뭄바이", "벵갈루루", "첸나이"],
  "영국": ["런던", "맨체스터", "버밍엄", "에든버러"],
  "독일": ["베를린", "프랑크푸르트", "뮌헨", "함부르크"],
  "프랑스": ["파리", "리옹", "마르세유"],
  "이탈리아": ["로마", "밀라노", "베네치아"],
  "스페인": ["마드리드", "바르셀로나"],
  "네덜란드": ["암스테르담", "로테르담"],
  "벨기에": ["브뤼셀", "앤트워프"],
  "스위스": ["취리히", "제네바"],
  "오스트리아": ["빈", "잘츠부르크"],
  "러시아": ["모스크바", "상트페테르부르크"],
  "캐나다": ["토론토", "밴쿠버", "몬트리올", "오타와"],
  "호주": ["시드니", "멜버른", "브리즈번", "퍼스"],
  "뉴질랜드": ["오클랜드", "웰링턴", "크라이스트처치"],
  "UAE": ["두바이", "아부다비"],
  "사우디아라비아": ["리야드", "제다"],
  "카타르": ["도하"],
  "멕시코": ["멕시코시티", "몬테레이"],
  "브라질": ["상파울루", "리우데자네이루"],
};

// ── 헬퍼 ────────────────────────────────────────────────────────────────
// AI가 반환하는 영문 국가명 → 한국어 매핑 (소문자 키)
const COUNTRY_EN_TO_KO: Record<string, string> = {
  "south korea": "대한민국", "korea": "대한민국",
  "japan": "일본", "china": "중국", "taiwan": "대만", "hong kong": "홍콩", "singapore": "싱가포르",
  "usa": "미국", "united states": "미국", "united states of america": "미국",
  "uk": "영국", "united kingdom": "영국", "great britain": "영국",
  "australia": "호주", "canada": "캐나다", "new zealand": "뉴질랜드",
  "malaysia": "말레이시아", "thailand": "태국", "vietnam": "베트남", "viet nam": "베트남",
  "indonesia": "인도네시아", "philippines": "필리핀", "india": "인도",
  "germany": "독일", "france": "프랑스", "italy": "이탈리아", "spain": "스페인",
  "netherlands": "네덜란드", "belgium": "벨기에", "switzerland": "스위스", "austria": "오스트리아",
  "russia": "러시아", "uae": "UAE", "united arab emirates": "UAE",
  "saudi arabia": "사우디아라비아", "qatar": "카타르",
  "mexico": "멕시코", "brazil": "브라질",
};
function resolveCountry(raw: string): string {
  return COUNTRY_EN_TO_KO[raw.trim().toLowerCase()] ?? raw.trim();
}

function parseRegionStr(regionStr: string): { country: string; city: string; countryCustom: string } {
  if (!regionStr) return { country: "대한민국", city: "", countryCustom: "" };

  // 표준 형식: "대한민국 / 서울특별시 강남구"
  const slashIdx = regionStr.indexOf(" / ");
  if (slashIdx >= 0) {
    const rawCountry = regionStr.slice(0, slashIdx).trim();
    const city = regionStr.slice(slashIdx + 3).trim();
    const country = resolveCountry(rawCountry);
    if ((REGION_COUNTRIES as readonly string[]).includes(country)) return { country, city, countryCustom: "" };
    return { country: "기타", city, countryCustom: country };
  }

  // AI "City, Country" 또는 "Country, City" 형식
  const commaIdx = regionStr.indexOf(", ");
  if (commaIdx >= 0) {
    const part1 = regionStr.slice(0, commaIdx).trim();
    const part2 = regionStr.slice(commaIdx + 2).trim();
    const fromPart2 = resolveCountry(part2);
    if ((REGION_COUNTRIES as readonly string[]).includes(fromPart2)) return { country: fromPart2, city: part1, countryCustom: "" };
    const fromPart1 = resolveCountry(part1);
    if ((REGION_COUNTRIES as readonly string[]).includes(fromPart1)) return { country: fromPart1, city: part2, countryCustom: "" };
    // 국가명 영어로 인식했지만 목록에 없음 → 기타
    return { country: "기타", city: part1, countryCustom: fromPart2 };
  }

  // 단일 값: 국가 목록 직접 매칭 (한국어)
  if ((REGION_COUNTRIES as readonly string[]).slice(0, -1).includes(regionStr)) return { country: regionStr, city: "", countryCustom: "" };
  // 영어 국가명 단일 값 ("South Korea" 등)
  const mappedCountry = resolveCountry(regionStr);
  if ((REGION_COUNTRIES as readonly string[]).includes(mappedCountry)) return { country: mappedCountry, city: "", countryCustom: "" };
  // 알 수 없는 값 → 도시로 처리
  return { country: "대한민국", city: regionStr, countryCustom: "" };
}

function buildRegionString(country: string, countryCustom: string, city: string): string {
  const label = country === "기타" ? countryCustom.trim() : country;
  if (!label) return city.trim();
  return city.trim() ? `${label} / ${city.trim()}` : label;
}

// ── 스타일 ───────────────────────────────────────────────────────────────
const inputStyle: React.CSSProperties = {
  width: "100%", padding: "9px 12px", borderRadius: 8,
  border: "1px solid #d1d5db", fontSize: 13, color: "#111827",
  outline: "none", boxSizing: "border-box", background: "#fff",
};
const inpAmber: React.CSSProperties = { ...inputStyle, borderColor: "#fcd34d", background: "#fffbeb" };
const labelSt: React.CSSProperties = { fontSize: 12, fontWeight: 600, color: "#374151", display: "block", marginBottom: 4 };
const labelAmber: React.CSSProperties = { ...labelSt, color: "#92400e" };
const sH: React.CSSProperties = {
  fontSize: 12, fontWeight: 700, color: "#6b7280", textTransform: "uppercase",
  letterSpacing: "0.06em", margin: "20px 0 10px", paddingBottom: 6, borderBottom: "1px solid #f3f4f6",
};
const sHAmber: React.CSSProperties = { ...sH, color: "#92400e", borderBottomColor: "#fde68a" };
const errStyle: React.CSSProperties = { color: "#dc2626", fontSize: 12, marginTop: 2 };
const grid2: React.CSSProperties = { display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px 14px" };
const grid3: React.CSSProperties = { display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "10px 14px" };

const GRADES = ["S", "A", "B", "C"];
const LANG_LEVELS = ["일반", "전문"];

function formatPhoneNumber(value: string): string {
  const n = value.replace(/\D/g, "");
  if (n.length <= 3) return n;
  if (n.length <= 7) return `${n.slice(0, 3)}-${n.slice(3)}`;
  return `${n.slice(0, 3)}-${n.slice(3, 7)}-${n.slice(7, 11)}`;
}
const FEE_PAYER_OPTIONS = [
  { value: "sender",    label: "송금인 부담 (당사)" },
  { value: "recipient", label: "수취인 부담 (통번역사)" },
  { value: "split",     label: "공동 부담" },
];

const emptySensitive = () => ({
  paymentMethod: "",
  residentFront: "", residentBack: "",
  bankName: "", bankAccount: "", accountHolder: "",
  businessNumber: "", businessName: "", businessOwner: "", taxInvoiceEmail: "",
  paypalEmail: "", englishName: "", country: "", currency: "",
  remittanceMemo: "", addressEn: "", bankNameEn: "", swiftCode: "",
  routingNumber: "", iban: "",
  baseCurrency: "", remittanceFeePayer: "", settlementMemo: "",
  paymentHold: false,
});

// ── 한국 지역 콤보박스 ────────────────────────────────────────────────────
function KoreaRegionCombobox({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [query, setQuery] = useState(value);
  const [open, setOpen] = useState(false);
  const [hoveredIdx, setHoveredIdx] = useState(-1);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => { setQuery(value); }, [value]);

  const filtered = query.trim()
    ? KOREA_ALL_OPTIONS.filter(r => r.includes(query.trim()))
    : [...KOREA_REGIONS];

  const isLegacy = Boolean(value) && !KOREA_ALL_OPTIONS.includes(value);

  useEffect(() => {
    const handle = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
        setQuery(value);
      }
    };
    document.addEventListener("mousedown", handle);
    return () => document.removeEventListener("mousedown", handle);
  }, [value]);

  const handleSelect = (opt: string) => {
    setQuery(opt); onChange(opt); setOpen(false); setHoveredIdx(-1);
  };

  return (
    <div ref={containerRef} style={{ position: "relative" }}>
      <div style={{ position: "relative" }}>
        <input
          type="text" value={query}
          onFocus={() => setOpen(true)}
          onChange={e => { setQuery(e.target.value); setOpen(true); setHoveredIdx(-1); }}
          onKeyDown={e => {
            if (e.key === "Escape") { setOpen(false); setQuery(value); }
            else if (e.key === "Enter" && hoveredIdx >= 0 && filtered[hoveredIdx]) { handleSelect(filtered[hoveredIdx]); }
            else if (e.key === "ArrowDown") { e.preventDefault(); setHoveredIdx(i => Math.min(i + 1, filtered.length - 1)); }
            else if (e.key === "ArrowUp") { e.preventDefault(); setHoveredIdx(i => Math.max(i - 1, 0)); }
          }}
          placeholder="검색 (예: 서울, 경기도, 강남구)"
          style={{ ...inputStyle, fontSize: 13, padding: "7px 32px 7px 10px" }}
        />
        <span style={{ position: "absolute", right: 10, top: "50%", transform: "translateY(-50%)", fontSize: 11, color: "#9ca3af", pointerEvents: "none" }}>▼</span>
      </div>
      {open && (
        <ul style={{
          position: "absolute", top: "calc(100% + 2px)", left: 0, right: 0,
          background: "#fff", border: "1px solid #d1d5db", borderRadius: 8,
          boxShadow: "0 6px 20px rgba(0,0,0,0.13)",
          maxHeight: 220, overflowY: "auto",
          margin: 0, padding: "4px 0", listStyle: "none", zIndex: 9999,
        }}>
          {isLegacy && (
            <li onMouseDown={e => { e.preventDefault(); handleSelect(value); }}
              style={{ padding: "6px 12px", fontSize: 12, cursor: "pointer", color: "#9ca3af", background: "#fafafa", borderBottom: "1px solid #f3f4f6" }}>
              {value} <span style={{ fontSize: 10, color: "#c4b5fd" }}>(기존값)</span>
            </li>
          )}
          {filtered.length === 0 ? (
            <li style={{ padding: "10px 12px", color: "#9ca3af", fontSize: 13 }}>검색 결과 없음</li>
          ) : filtered.map((opt, i) => (
            <li key={opt}
              onMouseDown={e => { e.preventDefault(); handleSelect(opt); }}
              onMouseEnter={() => setHoveredIdx(i)}
              onMouseLeave={() => setHoveredIdx(-1)}
              style={{
                padding: "7px 12px", fontSize: 13, cursor: "pointer",
                display: "flex", alignItems: "center", justifyContent: "space-between",
                background: i === hoveredIdx ? "#eff6ff" : opt === value ? "#f0f9ff" : "transparent",
                color: i === hoveredIdx ? "#1d4ed8" : opt === value ? "#0369a1" : "#374151",
                fontWeight: opt === value ? 600 : 400,
              }}>
              <span>{opt}</span>
              {(KOREA_REGIONS as readonly string[]).includes(opt) && (
                <span style={{ fontSize: 10, color: "#9ca3af", background: "#f3f4f6", borderRadius: 3, padding: "1px 5px" }}>시/도</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ── 해외 지역 콤보박스 ────────────────────────────────────────────────────
function OverseasRegionCombobox({ value, onChange, country }: {
  value: string; onChange: (v: string) => void; country: string;
}) {
  const options: readonly string[] = OVERSEAS_CITIES[country] ?? [];
  const [query, setQuery] = useState(() => options.includes(value) ? value : "");
  const [open, setOpen] = useState(false);
  const [hoveredIdx, setHoveredIdx] = useState(-1);
  const containerRef = useRef<HTMLDivElement>(null);
  const queryRef = useRef(query);
  queryRef.current = query;

  const prevCountry = useRef(country);
  useEffect(() => {
    if (prevCountry.current !== country) {
      prevCountry.current = country;
      const newOpts = OVERSEAS_CITIES[country] ?? [];
      setQuery(newOpts.includes(value) ? value : "");
    }
  }, [country, value]);

  const filtered = query.trim() ? options.filter(r => r.includes(query.trim())) : options;
  const isLegacy = Boolean(value) && !options.includes(value);

  useEffect(() => {
    const handle = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
        const q = queryRef.current.trim();
        if (q && q !== value) onChange(q);
        else if (!q) setQuery(value);
      }
    };
    document.addEventListener("mousedown", handle);
    return () => document.removeEventListener("mousedown", handle);
  }, [value, onChange]);

  const handleSelect = (opt: string) => {
    setQuery(opt); onChange(opt); setOpen(false); setHoveredIdx(-1);
  };

  const placeholder = options.length > 0 ? `${country} 주요 도시 검색 또는 직접 입력` : "지역/도시 직접 입력";

  return (
    <div ref={containerRef} style={{ position: "relative" }}>
      <div style={{ position: "relative" }}>
        <input
          type="text" value={query}
          onFocus={() => setOpen(true)}
          onChange={e => { setQuery(e.target.value); setOpen(true); setHoveredIdx(-1); }}
          onKeyDown={e => {
            if (e.key === "Escape") { setOpen(false); setQuery(value); }
            else if (e.key === "Enter") {
              if (hoveredIdx >= 0 && filtered[hoveredIdx]) { handleSelect(filtered[hoveredIdx]); }
              else if (query.trim()) { onChange(query.trim()); setOpen(false); }
            }
            else if (e.key === "ArrowDown") { e.preventDefault(); setHoveredIdx(i => Math.min(i + 1, filtered.length - 1)); }
            else if (e.key === "ArrowUp") { e.preventDefault(); setHoveredIdx(i => Math.max(i - 1, 0)); }
          }}
          placeholder={placeholder}
          style={{ ...inputStyle, fontSize: 13, padding: "7px 32px 7px 10px" }}
        />
        <span style={{ position: "absolute", right: 10, top: "50%", transform: "translateY(-50%)", fontSize: 11, color: "#9ca3af", pointerEvents: "none" }}>
          {options.length > 0 ? "▼" : "✎"}
        </span>
      </div>
      {open && (
        <ul style={{
          position: "absolute", top: "calc(100% + 2px)", left: 0, right: 0,
          background: "#fff", border: "1px solid #d1d5db", borderRadius: 8,
          boxShadow: "0 6px 20px rgba(0,0,0,0.13)",
          maxHeight: 200, overflowY: "auto",
          margin: 0, padding: "4px 0", listStyle: "none", zIndex: 9999,
        }}>
          {isLegacy && (
            <li onMouseDown={e => { e.preventDefault(); handleSelect(value); }}
              style={{ padding: "6px 12px", fontSize: 12, cursor: "pointer", color: "#9ca3af", background: "#fafafa" }}>
              {value} <span style={{ fontSize: 10, color: "#c4b5fd" }}>(기존값)</span>
            </li>
          )}
          {filtered.length === 0 && query.trim() ? (
            <li style={{ padding: "8px 12px", fontSize: 13, color: "#374151" }}>
              <span style={{ fontWeight: 600, color: "#6366f1" }}>{query}</span>
              <span style={{ color: "#9ca3af", fontSize: 12 }}> — Enter로 저장</span>
            </li>
          ) : filtered.length === 0 && options.length === 0 ? (
            <li style={{ padding: "10px 12px", color: "#9ca3af", fontSize: 13 }}>직접 입력해 주세요</li>
          ) : filtered.map((opt, i) => (
            <li key={opt}
              onMouseDown={e => { e.preventDefault(); handleSelect(opt); }}
              onMouseEnter={() => setHoveredIdx(i)}
              onMouseLeave={() => setHoveredIdx(-1)}
              style={{
                padding: "7px 12px", fontSize: 13, cursor: "pointer",
                background: i === hoveredIdx ? "#eff6ff" : opt === value ? "#f0f9ff" : "transparent",
                color: i === hoveredIdx ? "#1d4ed8" : opt === value ? "#0369a1" : "#374151",
                fontWeight: opt === value ? 600 : 400,
              }}>
              {opt}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function TranslatorCreateModal({ token, permissions = [], onClose, onCreated, onToast }: {
  token: string; permissions?: string[];
  onClose: () => void; onCreated: (translator: any) => void; onToast: (msg: string) => void;
}) {
  const hasPerm = (key: string) => permissions.includes(key) || permissions.includes("*");

  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [rates, setRates] = useState<RateEntryData[]>([]);
  const [rateErrors, setRateErrors] = useState<string[]>([]);
  const [resumeFile, setResumeFile] = useState<File | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [showAnalyzePanel, setShowAnalyzePanel] = useState(false);
  const [docSubTab, setDocSubTab] = useState<"resume" | "id" | "bank">("resume");
  const [idDragOver, setIdDragOver] = useState(false);
  const [bankDragOver, setBankDragOver] = useState(false);
  const [vendorCompanies, setVendorCompanies] = useState<Array<{ id: number; name: string }>>([]);

  // 거주지역 분리 state
  const [regionCountry, setRegionCountry] = useState("대한민국");
  const [regionCity, setRegionCity] = useState("");
  const [regionCountryCustom, setRegionCountryCustom] = useState("");

  // 학력/전공 custom 모드
  const [eduIsCustom, setEduIsCustom] = useState(false);
  const [eduCustom, setEduCustom] = useState("");
  const [majorIsCustom, setMajorIsCustom] = useState(false);
  const [majorCustom, setMajorCustom] = useState("");

  // 전문 정보 UI 제어
  const [pinnedSubTypes, setPinnedSubTypes] = useState<Set<string>>(new Set());
  const [showAllSubTypes, setShowAllSubTypes] = useState(false);
  const [showAllSpecs, setShowAllSpecs] = useState(false);
  const [showOtherSpec, setShowOtherSpec] = useState(false);

  const [form, setForm] = useState({
    email: "", name: "", phone: "",
    languagePairs: "", languageLevel: "",
    education: "", major: "", graduationYear: "", graduationStatus: "",
    specializations: "", grade: "", rating: "",
    bio: "", availabilityStatus: "available",
    affiliatedCompanyId: "",
    settlementType: "",
    profileWorkTypes: "",
    profileSubTypes: "",
    region: "",
  });
  const [langExperiences, setLangExperiences] = useState<LangExpEntry[]>([]);
  const [createdInvite, setCreatedInvite] = useState<{ email: string; inviteToken: string } | null>(null);
  const [sf, setSF] = useState(emptySensitive());
  const backRef = useRef<HTMLInputElement>(null);
  const authH = { Authorization: `Bearer ${token}` };

  useEffect(() => {
    fetch(api("/api/admin/companies?companyType=vendor"), { headers: authH })
      .then(r => r.json())
      .then(data => { if (Array.isArray(data)) setVendorCompanies(data.map((c: any) => ({ id: c.id, name: c.name }))); })
      .catch(() => {});
  }, []);

  const setF = (key: keyof typeof form, val: string) => {
    setForm(p => ({ ...p, [key]: val }));
    setErrors(p => { const n = { ...p }; delete n[key]; return n; });
  };
  const setSf = (key: keyof ReturnType<typeof emptySensitive>, val: string | boolean) =>
    setSF(p => ({ ...p, [key]: val }));

  const validate = () => {
    const e: Record<string, string> = {};
    if (!form.email.trim()) e.email = "이메일을 입력하세요.";
    else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email)) e.email = "올바른 이메일 형식이 아닙니다.";
    if (!form.name.trim()) e.name = "이름을 입력하세요.";
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  const handleTogglePin = (st: string) => {
    if (pinnedSubTypes.has(st)) {
      setPinnedSubTypes(prev => { const n = new Set(prev); n.delete(st); return n; });
    } else if (pinnedSubTypes.size >= 2) {
      onToast("대표 세부유형은 최대 2개까지 선택할 수 있습니다.");
    } else {
      setPinnedSubTypes(prev => new Set(prev).add(st));
    }
  };

  const RESUME_ALLOWED_EXTS = [".pdf", ".hwp", ".hwpx", ".doc", ".docx", ".txt"];
  const handleResumeFile = (file: File | null | undefined) => {
    if (!file) return;
    const ext = file.name.slice(file.name.lastIndexOf(".")).toLowerCase();
    if (!RESUME_ALLOWED_EXTS.includes(ext)) {
      onToast("PDF, HWP, HWPX, DOC, DOCX, TXT 형식만 업로드할 수 있습니다.");
      return;
    }
    setResumeFile(file);
  };

  const handleAnalyzeApply = (result: ResumeAnalysisResult) => {
    const normalizedLang = result.languagePairs ? normalizeLanguages(result.languagePairs) : null;
    const normalizedRegion = (() => {
      const raw = result.region ?? result.address ?? null;
      if (!raw) return null;
      const p = parseRegionStr(raw);
      return buildRegionString(p.country, p.countryCustom, p.city);
    })();

    setForm(prev => ({
      ...prev,
      // 사용자 입력값 우선 — 비어있을 때만 AI 값 적용
      ...(result.name && !prev.name ? { name: result.name } : {}),
      ...(result.phone && !prev.phone ? { phone: result.phone } : {}),
      ...(result.email && !prev.email ? { email: result.email } : {}),
      // 언어: 영어 → 한국어 정규화 (Preview에서 이미 검토됨)
      ...(normalizedLang ? { languagePairs: normalizedLang } : {}),
      ...(result.languageLevel && !prev.languageLevel ? { languageLevel: result.languageLevel } : {}),
      ...(result.education ? { education: result.education } : {}),
      ...(result.major ? { major: result.major } : {}),
      ...(result.graduationYear ? { graduationYear: String(result.graduationYear) } : {}),
      ...(result.graduationStatus && !prev.graduationStatus ? { graduationStatus: result.graduationStatus } : {}),
      ...(result.specializations ? { specializations: result.specializations } : {}),
      ...(result.profileWorkTypes ? { profileWorkTypes: result.profileWorkTypes } : {}),
      ...(result.profileSubTypes ? { profileSubTypes: result.profileSubTypes } : {}),
      // 지역: region 우선, 없으면 address에서 파싱
      ...(normalizedRegion ? { region: normalizedRegion } : {}),
      ...(result.bio && !prev.bio ? { bio: result.bio } : {}),
    }));
    if (result.education) {
      if (!EDUCATION_ALL.includes(result.education)) { setEduIsCustom(true); setEduCustom(result.education); }
      else { setEduIsCustom(false); setEduCustom(""); }
    }
    if (result.major) {
      if (!MAJOR_ALL.includes(result.major)) { setMajorIsCustom(true); setMajorCustom(result.major); }
      else { setMajorIsCustom(false); setMajorCustom(""); }
    }
    const regionRaw = result.region ?? result.address ?? null;
    if (regionRaw) {
      const parsed = parseRegionStr(regionRaw);
      setRegionCountry(parsed.country);
      setRegionCity(parsed.city);
      setRegionCountryCustom(parsed.countryCustom);
    }
    // 언어·국제경험: 현재 비어있을 때만 AI 결과 반영
    if (result.languageExperiences && langExperiences.length === 0) {
      try {
        const parsed = JSON.parse(result.languageExperiences);
        if (Array.isArray(parsed) && parsed.length > 0) setLangExperiences(parsed);
      } catch { /* ignore */ }
    }
    setShowAnalyzePanel(false);
    onToast("AI 분석 결과가 반영되었습니다. 내용을 확인 후 등록하세요.");
  };

  const handleSubmit = async () => {
    if (!validate()) return;
    setSaving(true);
    try {
      const seen = new Set<string>();
      const rErr: string[] = rates.map(_ => "");
      let hasDup = false;
      rates.forEach((r, i) => {
        const src = r.sourceLang === "기타" ? r.sourceCustom.trim() || "기타" : r.sourceLang;
        const tgt = r.targetLang === "기타" ? r.targetCustom.trim() || "기타" : r.targetLang;
        if (src === tgt) { rErr[i] = "출발 언어와 도착 언어가 같을 수 없습니다."; hasDup = true; return; }
        const key = `${r.workType}|${r.subType}|${src}|${tgt}|${r.unit}`;
        if (seen.has(key)) { rErr[i] = "동일한 업무유형+세부유형+출발언어+도착언어+단가단위 조합이 중복됩니다."; hasDup = true; }
        else seen.add(key);
      });
      if (hasDup) { setRateErrors(rErr); return; }

      const profileSubTypesValue = (() => {
        const all = form.profileSubTypes.split(",").map(s => s.trim()).filter(Boolean);
        const reordered = [...all.filter(s => pinnedSubTypes.has(s)), ...all.filter(s => !pinnedSubTypes.has(s))];
        return reordered.join(",") || undefined;
      })();

      const res = await fetch(api("/api/admin/translators"), {
        method: "POST", headers: { ...authH, "Content-Type": "application/json" },
        body: JSON.stringify({
          email: form.email.trim(),
          name: form.name.trim(), phone: form.phone.trim() || undefined,
          region: form.region.trim() || undefined,
          languagePairs: form.languagePairs.trim() || undefined,
          languageLevel: form.languageLevel || undefined,
          specializations: form.specializations.trim() || undefined,
          education: form.education.trim() || undefined,
          major: form.major.trim() || undefined,
          graduationYear: form.graduationYear ? Number(form.graduationYear) : undefined,
          graduationStatus: form.graduationStatus || undefined,
          rating: form.rating ? Number(form.rating) : undefined,
          grade: form.grade || undefined,
          bio: form.bio.trim() || undefined,
          availabilityStatus: form.availabilityStatus,
          affiliatedCompanyId: form.affiliatedCompanyId ? Number(form.affiliatedCompanyId) : undefined,
          settlementType: form.settlementType || undefined,
          profileWorkTypes: form.profileWorkTypes.trim() || undefined,
          profileSubTypes: profileSubTypesValue,
          languageExperiences: langExperiences.length > 0 ? JSON.stringify(langExperiences) : undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        if (res.status === 409) setErrors({ email: data.error });
        else onToast(`오류: ${data.error}`);
        return;
      }
      setCreatedInvite({ email: data.email, inviteToken: data.inviteToken });

      const userId = data.id;

      for (const r of rates) {
        if (!r.workType || !r.unit || !r.rate) continue;
        const src = r.sourceLang === "기타" ? r.sourceCustom.trim() || "기타" : r.sourceLang;
        const tgt = r.targetLang === "기타" ? r.targetCustom.trim() || "기타" : r.targetLang;
        if (!src || !tgt || src === tgt) continue;
        await fetch(api(`/api/admin/translators/${userId}/rates`), {
          method: "POST", headers: { ...authH, "Content-Type": "application/json" },
          body: JSON.stringify({
            workType: r.workType, subType: r.subType.trim() || null,
            language: src, languagePair: tgt,
            unit: r.unit, rate: Number(r.rate),
            currency: r.currency || "KRW",
            vatIncluded: r.vatIncluded ?? false,
            isDefault: r.isDefault ?? false,
            isActive: r.isActive ?? true,
            minPrice: r.minPrice ? Number(r.minPrice) : null,
            baseHours: r.baseHours ? Number(r.baseHours) : null,
            overtimeRate: r.overtimeRate ? Number(r.overtimeRate) : null,
            memo: r.memo || null,
          }),
        });
      }

      if (hasPerm("translator.sensitive") && sf.paymentMethod) {
        const rn = `${sf.residentFront.trim()}${sf.residentBack.trim()}`;
        const sbody: Record<string, unknown> = {
          paymentMethod: sf.paymentMethod || null,
          bankName: sf.bankName || null, bankAccount: sf.bankAccount || null, accountHolder: sf.accountHolder || null,
          businessNumber: sf.businessNumber || null, businessName: sf.businessName || null,
          businessOwner: sf.businessOwner || null, taxInvoiceEmail: sf.taxInvoiceEmail || null,
          paypalEmail: sf.paypalEmail || null, englishName: sf.englishName || null,
          country: sf.country || null, currency: sf.currency || null,
          remittanceMemo: sf.remittanceMemo || null, addressEn: sf.addressEn || null,
          bankNameEn: sf.bankNameEn || null, swiftCode: sf.swiftCode || null,
          routingNumber: sf.routingNumber || null, iban: sf.iban || null,
          baseCurrency: sf.baseCurrency || null, remittanceFeePayer: sf.remittanceFeePayer || null,
          paymentHold: sf.paymentHold, settlementMemo: sf.settlementMemo || null,
        };
        if (rn.length >= 6) sbody.residentNumber = rn;
        await fetch(api(`/api/admin/translators/${userId}/sensitive`), {
          method: "POST", headers: { ...authH, "Content-Type": "application/json" },
          body: JSON.stringify(sbody),
        });
      }

      if (resumeFile) {
        const fd = new FormData();
        fd.append("file", resumeFile);
        await fetch(api(`/api/admin/translators/${userId}/resume-upload`), {
          method: "POST", headers: { Authorization: `Bearer ${token}` }, body: fd,
        }).catch(() => {});
      }

      onToast(`통번역사 "${data.name ?? data.email}"이(가) 등록되었습니다.`);
      onCreated(data);
    } catch { onToast("오류: 등록 실패"); }
    finally { setSaving(false); }
  };

  const SA = ({ label, field, placeholder = "", type = "text", mono = false }: {
    label: string; field: keyof ReturnType<typeof emptySensitive>; placeholder?: string; type?: string; mono?: boolean;
  }) => (
    <div>
      <label style={labelAmber}>{label}</label>
      <input type={type} value={sf[field] as string} onChange={e => setSf(field, e.target.value)}
        placeholder={placeholder}
        style={{ ...inpAmber, fontFamily: mono ? "monospace" : undefined }} />
    </div>
  );

  const isDomesticWith = sf.paymentMethod === "domestic_withholding";
  const isDomesticBiz  = sf.paymentMethod === "domestic_business";
  const isPaypal       = sf.paymentMethod === "overseas_paypal";
  const isBank         = sf.paymentMethod === "overseas_bank";
  const isOther        = sf.paymentMethod === "other";
  const hasMethod      = !!sf.paymentMethod;

  const inviteUrl = createdInvite
    ? `${window.location.origin}/set-password?token=${createdInvite.inviteToken}`
    : "";

  if (createdInvite) {
    return (
      <DraggableModal title="등록 완료" subtitle="초대 링크를 발송하거나 복사해 전달하세요" onClose={onClose} width={600} zIndex={310} bodyPadding="28px 32px">
        <div style={{ textAlign: "center", padding: "8px 0 20px" }}>
          <div style={{ fontSize: 40, marginBottom: 12 }}>✅</div>
          <p style={{ fontSize: 16, fontWeight: 700, color: "#111827", marginBottom: 4 }}>{createdInvite.email}</p>
          <p style={{ fontSize: 13, color: "#6b7280", marginBottom: 24 }}>
            계정이 생성되었습니다. 아래 링크를 통번역사에게 전달하면 비밀번호를 직접 설정할 수 있습니다.
          </p>
          <div style={{ background: "#f3f4f6", borderRadius: 10, padding: "14px 16px", marginBottom: 20, textAlign: "left" }}>
            <p style={{ fontSize: 11, fontWeight: 700, color: "#6b7280", marginBottom: 6, textTransform: "uppercase", letterSpacing: "0.06em" }}>비밀번호 설정 링크</p>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <input readOnly value={inviteUrl} style={{
                flex: 1, padding: "8px 10px", fontSize: 12, fontFamily: "monospace",
                borderRadius: 6, border: "1px solid #d1d5db", background: "#fff", color: "#374151", outline: "none",
              }} onClick={e => (e.target as HTMLInputElement).select()} />
              <button onClick={() => { navigator.clipboard.writeText(inviteUrl); onToast("초대 링크가 복사되었습니다."); }}
                style={{ padding: "8px 14px", borderRadius: 6, border: "1px solid #2563eb", background: "#eff6ff", color: "#1d4ed8", fontSize: 12, fontWeight: 700, cursor: "pointer", whiteSpace: "nowrap" }}>
                복사
              </button>
            </div>
          </div>
          <div style={{ background: "#fef3c7", border: "1px solid #fde68a", borderRadius: 8, padding: "10px 14px", marginBottom: 24, textAlign: "left" }}>
            <p style={{ fontSize: 12, color: "#92400e", margin: 0 }}>
              ⚠️ 이 링크는 비밀번호 설정 전까지만 유효합니다. 설정 완료 후 자동으로 만료됩니다.
            </p>
          </div>
          <PrimaryBtn onClick={onClose} style={{ width: "100%", fontSize: 14, padding: "10px 0" }}>확인</PrimaryBtn>
        </div>
      </DraggableModal>
    );
  }

  return (
    <>
    <DraggableModal title="통번역사 등록" subtitle="초대 기반 계정 생성 — 비밀번호는 통번역사가 직접 설정합니다" onClose={onClose} width={820} zIndex={310} bodyPadding="20px 28px" resizable>

      {/* ── 1. 기본 정보 ── */}
      <p style={sH}>기본 정보</p>
      <div style={{ background: "#f9fafb", borderRadius: 10, border: "1px solid #f3f4f6", padding: "14px 16px", marginBottom: 4 }}>

        {/* 이름 · 휴대폰 */}
        <div style={grid2}>
          <div>
            <label style={labelSt}>이름 <span style={{ color: "#dc2626" }}>*</span></label>
            <input type="text" value={form.name} onChange={e => setF("name", e.target.value)}
              placeholder="홍길동"
              style={{ ...inputStyle, borderColor: errors.name ? "#dc2626" : "#d1d5db" }} />
            {errors.name && <span style={errStyle}>{errors.name}</span>}
          </div>
          <div>
            <label style={labelSt}>휴대폰</label>
            <input type="tel" value={form.phone}
              onChange={e => setF("phone", formatPhoneNumber(e.target.value))}
              placeholder="010-0000-0000" style={inputStyle} />
          </div>
        </div>

        {/* 이메일 */}
        <div style={{ marginTop: 10 }}>
          <label style={labelSt}>이메일 <span style={{ color: "#dc2626" }}>*</span></label>
          <input type="email" value={form.email} onChange={e => setF("email", e.target.value)}
            placeholder="example@email.com"
            style={{ ...inputStyle, borderColor: errors.email ? "#dc2626" : "#d1d5db" }} />
          {errors.email && <span style={errStyle}>{errors.email}</span>}
        </div>

        {/* 학력 · 전공 · 졸업상태 · 졸업년도 */}
        <div style={{ marginTop: 10 }}>
          <div style={{ display: "grid", gridTemplateColumns: "35fr 25fr 20fr 20fr", gap: "0 14px" }}>
            <div>
              <label style={labelSt}>학력</label>
              <ClickSelect
                value={eduIsCustom ? "__custom__" : form.education}
                onChange={v => {
                  if (v === "__custom__") { setEduIsCustom(true); setForm(p => ({ ...p, education: eduCustom })); }
                  else { setEduIsCustom(false); setEduCustom(""); setForm(p => ({ ...p, education: v })); }
                }}
                style={{ width: "100%" }}
                triggerStyle={{ width: "100%", fontSize: 13, padding: "9px 12px", borderRadius: 8, textAlign: "left" }}
                options={[
                  { value: "", label: "선택 안 함" },
                  ...EDUCATION_DOMESTIC.map(s => ({ value: s, label: s })),
                  ...EDUCATION_OVERSEAS.map(s => ({ value: s, label: s })),
                  { value: "__custom__", label: "기타(직접 입력)" },
                ]}
              />
              {eduIsCustom && (
                <input type="text" value={eduCustom}
                  onChange={e => { setEduCustom(e.target.value); setForm(p => ({ ...p, education: e.target.value })); }}
                  placeholder="직접 입력" style={{ ...inputStyle, marginTop: 4 }} />
              )}
            </div>
            <div>
              <label style={labelSt}>전공</label>
              <ClickSelect
                value={majorIsCustom ? "__custom__" : form.major}
                onChange={v => {
                  if (v === "__custom__") { setMajorIsCustom(true); setForm(p => ({ ...p, major: majorCustom })); }
                  else { setMajorIsCustom(false); setMajorCustom(""); setForm(p => ({ ...p, major: v })); }
                }}
                style={{ width: "100%" }}
                triggerStyle={{ width: "100%", fontSize: 13, padding: "9px 12px", borderRadius: 8, textAlign: "left" }}
                options={[
                  { value: "", label: "선택 안 함" },
                  ...MAJOR_LANGUAGE.map(s => ({ value: s, label: s })),
                  ...MAJOR_INTERPRETATION.map(s => ({ value: s, label: s })),
                  ...MAJOR_SPECIALIZED.map(s => ({ value: s, label: s })),
                  { value: "__custom__", label: "기타(직접 입력)" },
                ]}
              />
              {majorIsCustom && (
                <input type="text" value={majorCustom}
                  onChange={e => { setMajorCustom(e.target.value); setForm(p => ({ ...p, major: e.target.value })); }}
                  placeholder="직접 입력" style={{ ...inputStyle, marginTop: 4 }} />
              )}
            </div>
            <div>
              <label style={labelSt}>졸업상태</label>
              <ClickSelect
                value={form.graduationStatus}
                onChange={v => setF("graduationStatus", v)}
                style={{ width: "100%" }}
                triggerStyle={{ width: "100%", fontSize: 13, padding: "9px 12px", borderRadius: 8, textAlign: "left" }}
                options={[
                  { value: "", label: "선택 안 함" },
                  ...GRADUATION_STATUS_OPTIONS.map(s => ({ value: s, label: s })),
                ]}
              />
            </div>
            <div>
              <label style={labelSt}>졸업/예정년도</label>
              <ClickSelect
                value={form.graduationYear}
                onChange={v => setF("graduationYear", v)}
                style={{ width: "100%" }}
                triggerStyle={{ width: "100%", fontSize: 13, padding: "9px 12px", borderRadius: 8, textAlign: "left" }}
                options={[
                  { value: "", label: "선택 안 함" },
                  ...GRAD_YEARS.map(y => ({ value: y, label: y })),
                ]}
              />
            </div>
          </div>
        </div>

        {/* 언어레벨 · 거주국가 · 거주지역/도시 */}
        <div style={{ marginTop: 10, display: "grid", gridTemplateColumns: "1fr 1fr 2fr", gap: "0 14px", alignItems: "start" }}>
          <div>
            <label style={labelSt}>언어 레벨</label>
            <ClickSelect value={form.languageLevel} onChange={v => setF("languageLevel", v)}
              style={{ width: "100%" }} triggerStyle={{ width: "100%", fontSize: 13, padding: "9px 12px", borderRadius: 8 }}
              options={[{ value: "", label: "선택 안 함" }, ...LANG_LEVELS.map(l => ({ value: l, label: l }))]} />
          </div>
          <div>
            <label style={labelSt}>거주국가</label>
            <ClickSelect
              value={regionCountry}
              onChange={c => {
                setRegionCountry(c);
                if (c !== "기타") setRegionCountryCustom("");
                setForm(p => ({ ...p, region: buildRegionString(c, c === "기타" ? "" : "", regionCity) }));
              }}
              style={{ width: "100%" }}
              triggerStyle={{ width: "100%", fontSize: 13, padding: "9px 12px", borderRadius: 8, textAlign: "left" }}
              options={(REGION_COUNTRIES as readonly string[]).map(c => ({ value: c, label: c }))}
            />
            {regionCountry === "기타" && (
              <input type="text" value={regionCountryCustom}
                onChange={e => {
                  const custom = e.target.value;
                  setRegionCountryCustom(custom);
                  setForm(p => ({ ...p, region: buildRegionString("기타", custom, regionCity) }));
                }}
                placeholder="국가명 직접 입력"
                style={{ ...inputStyle, marginTop: 4 }} />
            )}
          </div>
          <div>
            <label style={labelSt}>거주지역/도시</label>
            {regionCountry === "대한민국" ? (
              <KoreaRegionCombobox
                value={regionCity}
                onChange={city => {
                  setRegionCity(city);
                  setForm(p => ({ ...p, region: buildRegionString("대한민국", "", city) }));
                }}
              />
            ) : (
              <OverseasRegionCombobox
                key={regionCountry === "기타" ? `기타-${regionCountryCustom}` : regionCountry}
                value={regionCity}
                country={regionCountry === "기타" ? regionCountryCustom : regionCountry}
                onChange={city => {
                  setRegionCity(city);
                  setForm(p => ({ ...p, region: buildRegionString(regionCountry, regionCountryCustom, city) }));
                }}
              />
            )}
          </div>
        </div>

        {/* 소속업체 */}
        <div style={{ marginTop: 10 }}>
          <label style={labelSt}>소속업체</label>
          <ClickSelect
            value={form.affiliatedCompanyId}
            onChange={v => setF("affiliatedCompanyId", v)}
            style={{ width: "100%" }}
            triggerStyle={{ width: "100%", fontSize: 13, padding: "9px 12px", borderRadius: 8, textAlign: "left" }}
            options={[
              { value: "", label: "소속 없음 (프리랜서)" },
              ...vendorCompanies.map(c => ({ value: String(c.id), label: c.name })),
            ]}
          />
        </div>

        {/* 등급 · 평점 · 가용상태 */}
        <div style={{ marginTop: 10, ...grid3 }}>
          <div>
            <label style={labelSt}>등급</label>
            <ClickSelect value={form.grade} onChange={v => setF("grade", v)}
              style={{ width: "100%" }} triggerStyle={{ width: "100%", fontSize: 13, padding: "9px 12px", borderRadius: 8 }}
              options={[{ value: "", label: "등급 없음" }, ...GRADES.map(g => ({ value: g, label: `${g}등급` }))]} />
          </div>
          <div>
            <label style={labelSt}>평점 (1-5)</label>
            <input type="number" value={form.rating} onChange={e => setF("rating", e.target.value)}
              placeholder="예: 4.5" min={1} max={5} step={0.1} style={inputStyle} />
          </div>
          <div>
            <label style={labelSt}>가용 상태</label>
            <ClickSelect value={form.availabilityStatus} onChange={v => setF("availabilityStatus", v)}
              style={{ width: "100%" }} triggerStyle={{ width: "100%", fontSize: 13, padding: "9px 12px", borderRadius: 8 }}
              options={[
                { value: "available", label: "가능" }, { value: "busy", label: "바쁨" }, { value: "unavailable", label: "불가" },
              ]} />
          </div>
        </div>

        {/* 상세정보 */}
        <div style={{ marginTop: 10 }}>
          <label style={labelSt}>상세정보 (경력·특이사항)</label>
          <textarea value={form.bio} onChange={e => setF("bio", e.target.value)} rows={2}
            placeholder="출신학교, 경력 요약, 전문분야, 통역/번역 특징, 주의사항 등"
            style={{ ...inputStyle, resize: "vertical" }} />
        </div>
      </div>

      {/* ── 2. 전문 정보 ── */}
      <p style={sH}>전문 정보</p>
      <div style={{ background: "#f9fafb", borderRadius: 10, border: "1px solid #f3f4f6", padding: "14px 16px", marginBottom: 4 }}>

        {/* 가능언어 */}
        <div style={{ marginBottom: 10 }}>
          <label style={labelSt}>가능언어</label>
          <input type="text" value={form.languagePairs} onChange={e => setF("languagePairs", e.target.value)}
            placeholder="예: 한국어, 영어, 일본어" style={inputStyle} />
          <span style={{ fontSize: 11, color: "#9ca3af" }}>쉼표로 구분하여 입력</span>
        </div>

        {/* 업무유형 */}
        <div style={{ marginBottom: 10 }}>
          <label style={labelSt}>업무유형 (프로필)</label>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 4 }}>
            {(PROFILE_WORK_TYPES as readonly string[]).map(wt => {
              const selected = form.profileWorkTypes.split(",").map(s => s.trim()).filter(Boolean).includes(wt);
              return (
                <button key={wt} type="button"
                  onClick={() => {
                    const cur = form.profileWorkTypes.split(",").map(s => s.trim()).filter(Boolean);
                    const next = selected ? cur.filter(s => s !== wt) : [...cur, wt];
                    let nextSubTypes = form.profileSubTypes.split(",").map(s => s.trim()).filter(Boolean);
                    if (selected) {
                      const validSubs = new Set(next.flatMap(t => PROFILE_SUB_TYPES_MAP[t] ?? []));
                      nextSubTypes = nextSubTypes.filter(st => validSubs.has(st));
                      setPinnedSubTypes(prev => new Set([...prev].filter(st => validSubs.has(st))));
                    }
                    setShowAllSubTypes(false);
                    setForm(p => ({ ...p, profileWorkTypes: next.join(","), profileSubTypes: nextSubTypes.join(",") }));
                  }}
                  style={{
                    padding: "4px 12px", borderRadius: 20, fontSize: 12, cursor: "pointer",
                    background: selected ? "#7c3aed" : "#f5f3ff",
                    color: selected ? "#fff" : "#7c3aed",
                    border: `1px solid ${selected ? "#7c3aed" : "#ddd8fe"}`,
                    fontWeight: selected ? 700 : 400,
                  }}>
                  {wt}
                </button>
              );
            })}
          </div>
        </div>

        {/* 세부유형 */}
        {(() => {
          const selectedTypes = form.profileWorkTypes.split(",").map(s => s.trim()).filter(Boolean);
          const allSubs = Array.from(new Set(selectedTypes.flatMap(wt => PROFILE_SUB_TYPES_MAP[wt] ?? [])));
          if (allSubs.length === 0) return null;
          const selectedSubSet = new Set(form.profileSubTypes.split(",").map(s => s.trim()).filter(Boolean));
          const sortedSubs = [
            ...allSubs.filter(s => pinnedSubTypes.has(s)),
            ...allSubs.filter(s => selectedSubSet.has(s) && !pinnedSubTypes.has(s)),
            ...allSubs.filter(s => !selectedSubSet.has(s)),
          ];
          const defaultVisible = pinnedSubTypes.size > 0
            ? sortedSubs.filter(s => pinnedSubTypes.has(s))
            : sortedSubs.filter(s => selectedSubSet.has(s)).slice(0, 3);
          const visibleSubs = showAllSubTypes ? sortedSubs : defaultVisible;
          const hiddenCount = sortedSubs.length - visibleSubs.length;
          return (
            <div style={{ marginBottom: 10 }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
                <label style={{ ...labelSt, marginBottom: 0 }}>
                  세부유형 (프로필)
                  <span style={{ fontSize: 10, color: "#9ca3af", fontWeight: 400, marginLeft: 6 }}>☆ 클릭으로 대표 지정 (최대 2개)</span>
                </label>
                {(hiddenCount > 0 || showAllSubTypes) && (
                  <button type="button" onClick={() => setShowAllSubTypes(prev => !prev)}
                    style={{ fontSize: 11, color: "#6366f1", background: "none", border: "1px solid #e0e7ff", borderRadius: 6, cursor: "pointer", padding: "2px 8px" }}>
                    {showAllSubTypes ? "접기" : `추가 ${hiddenCount}개 보기`}
                  </button>
                )}
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                {visibleSubs.map(st => {
                  const sel = selectedSubSet.has(st);
                  const isPinned = pinnedSubTypes.has(st);
                  return (
                    <span key={st} style={{ display: "inline-flex", alignItems: "center", gap: 2 }}>
                      <button type="button"
                        onClick={() => {
                          const cur = form.profileSubTypes.split(",").map(s => s.trim()).filter(Boolean);
                          const next = sel ? cur.filter(s => s !== st) : [...cur, st];
                          if (sel && pinnedSubTypes.has(st)) {
                            setPinnedSubTypes(prev => { const n = new Set(prev); n.delete(st); return n; });
                          }
                          setForm(p => ({ ...p, profileSubTypes: next.join(",") }));
                        }}
                        style={{
                          padding: "2px 7px", borderRadius: 20, fontSize: 10, cursor: "pointer",
                          background: isPinned ? "#065f46" : sel ? "#059669" : "#f0fdf4",
                          color: sel ? "#fff" : "#065f46",
                          border: `1px solid ${isPinned ? "#065f46" : sel ? "#059669" : "#a7f3d0"}`,
                          fontWeight: sel ? 700 : 400,
                        }}>
                        {isPinned && <span style={{ marginRight: 2, fontSize: 9 }}>★</span>}{st}
                      </button>
                      {sel && (
                        <button type="button" onClick={() => handleTogglePin(st)}
                          title={isPinned ? "대표 해제" : "대표로 지정"}
                          style={{ background: "none", border: "none", padding: "0 1px", fontSize: 11, cursor: "pointer", lineHeight: 1, color: isPinned ? "#f59e0b" : "#d1d5db" }}>
                          {isPinned ? "★" : "☆"}
                        </button>
                      )}
                    </span>
                  );
                })}
                {!showAllSubTypes && visibleSubs.length === 0 && (
                  <button type="button" onClick={() => setShowAllSubTypes(true)}
                    style={{ fontSize: 11, color: "#6366f1", background: "none", border: "1px dashed #c7d2fe", borderRadius: 6, cursor: "pointer", padding: "3px 10px" }}>
                    + 세부유형 선택
                  </button>
                )}
              </div>
            </div>
          );
        })()}

        {/* 전문분야 */}
        {(() => {
          const parseList = (s: string) => s.split(",").map(x => x.trim()).filter(Boolean);
          const selected = new Set(parseList(form.specializations));
          const presetSet = new Set<string>(SPECIALIZATION_PRESETS);
          const customVals = parseList(form.specializations).filter(x => !presetSet.has(x));
          const allPresets = SPECIALIZATION_PRESETS as readonly string[];
          const SPEC_FIRST_ROW = 6;
          const sortedPresets = [...allPresets.filter(t => selected.has(t)), ...allPresets.filter(t => !selected.has(t))];
          const visiblePresets = showAllSpecs ? sortedPresets : sortedPresets.slice(0, SPEC_FIRST_ROW);
          const hiddenCount = (sortedPresets.length - visiblePresets.length) + (showAllSpecs ? 0 : 1);

          const togglePreset = (tag: string) => {
            const cur = parseList(form.specializations);
            const next = cur.includes(tag) ? cur.filter(x => x !== tag) : [...cur, tag];
            setForm(p => ({ ...p, specializations: next.join(",") }));
          };
          const handleOtherToggle = () => {
            if (showOtherSpec) {
              const presets = parseList(form.specializations).filter(x => presetSet.has(x));
              setForm(p => ({ ...p, specializations: presets.join(",") }));
              setShowOtherSpec(false);
            } else { setShowOtherSpec(true); }
          };
          const handleCustomChange = (text: string) => {
            const presets = parseList(form.specializations).filter(x => presetSet.has(x));
            const customs = text.split(",").map(x => x.trim()).filter(Boolean);
            setForm(p => ({ ...p, specializations: [...presets, ...customs].join(",") }));
          };
          const tagStyle = (isSelected: boolean, colors: { bg: string; bgOff: string; fg: string; fgOff: string; border: string; borderOff: string }): React.CSSProperties => ({
            padding: "2px 8px", borderRadius: 20, fontSize: 11, cursor: "pointer",
            background: isSelected ? colors.bg : colors.bgOff,
            color: isSelected ? colors.fg : colors.fgOff,
            border: `1px solid ${isSelected ? colors.border : colors.borderOff}`,
            fontWeight: isSelected ? 700 : 400,
          });
          return (
            <div>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
                <label style={{ ...labelSt, marginBottom: 0 }}>전문분야</label>
                <button type="button" onClick={() => setShowAllSpecs(prev => !prev)}
                  style={{ fontSize: 11, color: "#6366f1", background: "none", border: "1px solid #e0e7ff", borderRadius: 6, cursor: "pointer", padding: "2px 8px" }}>
                  {showAllSpecs ? "접기" : `+${hiddenCount}개 보기`}
                </button>
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
                {visiblePresets.map(tag => {
                  const isSelected = selected.has(tag);
                  const isGeneral = tag === "다분야 가능";
                  return (
                    <button key={tag} type="button" onClick={() => togglePreset(tag)}
                      style={tagStyle(isSelected, isGeneral
                        ? { bg: "#059669", bgOff: "#ecfdf5", fg: "#fff", fgOff: "#065f46", border: "#059669", borderOff: "#a7f3d0" }
                        : { bg: "#2563eb", bgOff: "#eff6ff", fg: "#fff", fgOff: "#2563eb", border: "#2563eb", borderOff: "#bfdbfe" }
                      )}>{tag}</button>
                  );
                })}
                {showAllSpecs && (
                  <button type="button" onClick={handleOtherToggle}
                    style={tagStyle(showOtherSpec, { bg: "#7c3aed", bgOff: "#f5f3ff", fg: "#fff", fgOff: "#7c3aed", border: "#7c3aed", borderOff: "#ddd8fe" })}>
                    기타
                  </button>
                )}
              </div>
              {showAllSpecs && showOtherSpec && (
                <input type="text" value={customVals.join(", ")} onChange={e => handleCustomChange(e.target.value)}
                  placeholder="예: 게임, 방산전자, 우주항공"
                  style={{ ...inputStyle, marginTop: 6 }} />
              )}
            </div>
          );
        })()}
      </div>

      {/* ── 3. 이력서&증빙서류 ── */}
      <p style={sH}>이력서&증빙서류</p>
      <div style={{ background: "#f9fafb", borderRadius: 10, border: "1px solid #f3f4f6", padding: "14px 16px", marginBottom: 4 }}>

        {/* 서류 유형 탭 */}
        <div style={{ display: "flex", gap: 6, marginBottom: 14, borderBottom: "1px solid #e5e7eb", paddingBottom: 10 }}>
          {([
            { key: "resume", label: "📄 이력서" },
            { key: "id",     label: "🪪 신분증" },
            { key: "bank",   label: "🏦 통장사본" },
          ] as const).map(({ key, label }) => (
            <button key={key} type="button"
              onClick={() => setDocSubTab(key)}
              style={{
                padding: "5px 14px", borderRadius: 20, fontSize: 12, cursor: "pointer",
                background: docSubTab === key ? "#0ea5e9" : "#f0f9ff",
                color: docSubTab === key ? "#fff" : "#0369a1",
                border: `1px solid ${docSubTab === key ? "#0ea5e9" : "#bae6fd"}`,
                fontWeight: docSubTab === key ? 700 : 400,
              }}>
              {label}
            </button>
          ))}
        </div>

        {/* ① 이력서 탭 */}
        {docSubTab === "resume" && (<>
          {resumeFile && (
            <div style={{
              display: "flex", alignItems: "center", gap: 8,
              padding: "8px 12px", marginBottom: 10,
              background: "#f0fdf4", borderRadius: 8, border: "1px solid #a7f3d0",
            }}>
              <span style={{ fontSize: 16, flexShrink: 0 }}>📄</span>
              <span style={{ fontSize: 12, color: "#065f46", fontWeight: 600, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>
                {resumeFile.name}
              </span>
              <div style={{ display: "flex", gap: 4, flexShrink: 0 }}>
                <button type="button" onClick={() => setShowAnalyzePanel(true)}
                  style={{ fontSize: 11, padding: "3px 8px", borderRadius: 5, border: "1px solid #059669", background: "#f0fdf4", cursor: "pointer", color: "#065f46", fontWeight: 600, whiteSpace: "nowrap" }}>
                  ✨ AI 분석
                </button>
                <button type="button" onClick={() => setResumeFile(null)}
                  style={{ fontSize: 11, padding: "3px 8px", borderRadius: 5, border: "1px solid #fca5a5", background: "#fff5f5", cursor: "pointer", color: "#b91c1c", whiteSpace: "nowrap" }}>
                  삭제
                </button>
              </div>
            </div>
          )}
          <div
            onDragOver={e => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={e => { e.preventDefault(); setDragOver(false); handleResumeFile(e.dataTransfer.files?.[0]); }}
            style={{
              border: `2px dashed ${dragOver ? "#059669" : "#d1d5db"}`,
              borderRadius: 8, padding: "14px 16px",
              background: dragOver ? "#f0fdf4" : "#fff",
              transition: "border-color 0.15s, background 0.15s",
              textAlign: "center" as const,
            }}>
            <p style={{ fontSize: 11, color: dragOver ? "#059669" : "#9ca3af", margin: "0 0 8px", fontWeight: dragOver ? 600 : 400 }}>
              {dragOver ? "여기에 파일을 놓으세요" : "파일을 드래그하거나 아래 버튼으로 선택"}
            </p>
            <label style={{ fontSize: 12, padding: "5px 12px", borderRadius: 6, border: "1px solid #d1d5db", background: "#fff", cursor: "pointer", color: "#374151", display: "inline-block" }}>
              파일 선택
              <input type="file" hidden
                accept=".pdf,.hwp,.hwpx,.doc,.docx,.txt,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain,application/haansofthwp,application/x-hwp,application/vnd.hancom.hwp,application/vnd.hancom.hwpx"
                onChange={e => handleResumeFile(e.target.files?.[0])} />
            </label>
            <p style={{ fontSize: 11, color: "#9ca3af", margin: "6px 0 0" }}>PDF · HWP · HWPX · DOC · DOCX · TXT (최대 10 MB)</p>
          </div>
          {!resumeFile && (
            <p style={{ fontSize: 11, color: "#9ca3af", margin: "6px 0 0" }}>
              이력서 선택 후 ✨ AI 분석으로 프로필 정보를 자동으로 채울 수 있습니다.
            </p>
          )}
        </>)}

        {/* ② 신분증 탭 */}
        {docSubTab === "id" && (
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
              <label style={{ fontSize: 12, fontWeight: 600, color: "#374151" }}>신분증 파일</label>
              <span style={{ fontSize: 10, color: "#fff", background: "#f59e0b", borderRadius: 10, padding: "1px 8px", fontWeight: 700 }}>준비 중</span>
            </div>
            <div
              onDragOver={e => { e.preventDefault(); setIdDragOver(true); }}
              onDragLeave={() => setIdDragOver(false)}
              onDrop={e => { e.preventDefault(); setIdDragOver(false); }}
              style={{
                border: `2px dashed ${idDragOver ? "#f59e0b" : "#d1d5db"}`,
                borderRadius: 8, padding: "24px 14px",
                background: idDragOver ? "#fffbeb" : "#f9fafb",
                textAlign: "center" as const,
                transition: "border-color 0.15s, background 0.15s",
              }}>
              <div style={{ fontSize: 28, marginBottom: 6 }}>🪪</div>
              <p style={{ fontSize: 12, color: "#6b7280", margin: "0 0 4px" }}>
                {idDragOver ? "여기에 파일을 놓으세요" : "신분증 업로드"}
              </p>
              <p style={{ fontSize: 11, color: "#9ca3af", margin: 0 }}>JPG · PNG · PDF (최대 10 MB)</p>
            </div>
            <div style={{ marginTop: 10, padding: "10px 14px", background: "#fffbeb", borderRadius: 8, border: "1px solid #fde68a" }}>
              <p style={{ fontSize: 11, color: "#92400e", margin: "0 0 4px", fontWeight: 700 }}>🔐 민감정보 보안 정책</p>
              <p style={{ fontSize: 11, color: "#78350f", margin: 0, lineHeight: 1.6 }}>신분증은 민감개인정보입니다. 향후 업로드 시 접근권한 관리 · 감사로그 · 승인 이력이 자동 기록됩니다.</p>
            </div>
            <div style={{ marginTop: 8, padding: "10px 14px", background: "#f0f9ff", borderRadius: 8, border: "1px solid #bae6fd" }}>
              <p style={{ fontSize: 11, color: "#0369a1", margin: "0 0 3px", fontWeight: 700 }}>✨ AI 분석 예정 항목</p>
              <p style={{ fontSize: 11, color: "#0c4a6e", margin: 0, lineHeight: 1.6 }}>이름 · 주민등록번호 · 생년월일 · 주소 → 관리자 검수 → 승인 반영</p>
            </div>
          </div>
        )}

        {/* ③ 통장사본 탭 */}
        {docSubTab === "bank" && (
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
              <label style={{ fontSize: 12, fontWeight: 600, color: "#374151" }}>통장사본 파일</label>
              <span style={{ fontSize: 10, color: "#fff", background: "#f59e0b", borderRadius: 10, padding: "1px 8px", fontWeight: 700 }}>준비 중</span>
            </div>
            <div
              onDragOver={e => { e.preventDefault(); setBankDragOver(true); }}
              onDragLeave={() => setBankDragOver(false)}
              onDrop={e => { e.preventDefault(); setBankDragOver(false); }}
              style={{
                border: `2px dashed ${bankDragOver ? "#059669" : "#d1d5db"}`,
                borderRadius: 8, padding: "24px 14px",
                background: bankDragOver ? "#f0fdf4" : "#f9fafb",
                textAlign: "center" as const,
                transition: "border-color 0.15s, background 0.15s",
              }}>
              <div style={{ fontSize: 28, marginBottom: 6 }}>🏦</div>
              <p style={{ fontSize: 12, color: "#6b7280", margin: "0 0 4px" }}>
                {bankDragOver ? "여기에 파일을 놓으세요" : "통장사본 업로드"}
              </p>
              <p style={{ fontSize: 11, color: "#9ca3af", margin: 0 }}>JPG · PNG · PDF (최대 10 MB)</p>
            </div>
            <div style={{ marginTop: 10, padding: "10px 14px", background: "#fffbeb", borderRadius: 8, border: "1px solid #fde68a" }}>
              <p style={{ fontSize: 11, color: "#92400e", margin: "0 0 4px", fontWeight: 700 }}>🔐 민감정보 보안 정책</p>
              <p style={{ fontSize: 11, color: "#78350f", margin: 0, lineHeight: 1.6 }}>통장사본은 금융정보입니다. 향후 업로드 시 접근권한 관리 · 감사로그 · 승인 이력이 자동 기록됩니다.</p>
            </div>
            <div style={{ marginTop: 8, padding: "10px 14px", background: "#f0f9ff", borderRadius: 8, border: "1px solid #bae6fd" }}>
              <p style={{ fontSize: 11, color: "#0369a1", margin: "0 0 3px", fontWeight: 700 }}>✨ AI 분석 예정 항목</p>
              <p style={{ fontSize: 11, color: "#0c4a6e", margin: 0, lineHeight: 1.6 }}>은행명 · 예금주 · 계좌번호 → 관리자 검수 → 승인 반영</p>
            </div>
          </div>
        )}

      </div>

      {/* ── 4. 언어·국제경험 ── */}
      <p style={sH}>언어·국제경험</p>
      <div style={{ background: "#f9fafb", borderRadius: 10, border: "1px solid #f3f4f6", padding: "14px 16px", marginBottom: 4 }}>
        <TranslatorLangExpSection entries={langExperiences} onChange={setLangExperiences} />
      </div>

      {/* ── 5. 단가 등록 ── */}
      <p style={sH}>단가 등록</p>
      {rates.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 10 }}>
          {rates.map((r, i) => (
            <TranslatorRateEntryCard
              key={i} value={r}
              onChange={patch => {
                setRates(p => p.map((x, idx) => idx === i ? { ...x, ...patch } : x));
                setRateErrors(p => { const n = [...p]; n[i] = ""; return n; });
              }}
              onRemove={() => { setRates(p => p.filter((_, idx) => idx !== i)); setRateErrors(p => p.filter((_, idx) => idx !== i)); }}
              error={rateErrors[i]}
            />
          ))}
        </div>
      )}
      <button
        onClick={() => setRates(p => [...p, emptyRateEntry()])}
        style={{ fontSize: 13, fontWeight: 600, padding: "8px 16px", borderRadius: 8, border: "1.5px dashed #9ca3af", background: "#f9fafb", color: "#374151", cursor: "pointer", display: "flex", alignItems: "center", gap: 6 }}>
        + 단가 추가
      </button>

      {/* ── 5. 정산/지급 정보 (권한자만) ── */}
      {hasPerm("translator.sensitive") && (
        <>
          <p style={sHAmber}>
            🔒 정산/지급 정보
            <span style={{ marginLeft: 8, fontSize: 11, fontWeight: 400, color: "#9ca3af", textTransform: "none", letterSpacing: 0 }}>
              암호화 저장 · admin/finance 권한만 열람 가능 · 나중에 입력해도 됩니다
            </span>
          </p>
          <div style={{ background: "#fff7ed", border: "1px solid #fed7aa", borderRadius: 10, padding: "16px 18px" }}>
            {/* 정산유형 */}
            <p style={{ fontSize: 12, fontWeight: 700, color: "#92400e", margin: "0 0 8px" }}>정산유형</p>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 6, marginBottom: 16 }}>
              {SETTLEMENT_TYPES.map(st => (
                <button key={st.value} onClick={() => setF("settlementType", st.value === form.settlementType ? "" : st.value)}
                  style={{
                    padding: "8px 6px", borderRadius: 8, fontSize: 11, cursor: "pointer", textAlign: "center", lineHeight: 1.3,
                    border: form.settlementType === st.value ? `2px solid ${st.color}` : "1.5px solid #fde68a",
                    background: form.settlementType === st.value ? st.bg : "#fffbeb",
                    color: form.settlementType === st.value ? st.color : "#92400e",
                    fontWeight: form.settlementType === st.value ? 700 : 400,
                  }}>{st.label}</button>
              ))}
            </div>

            <p style={{ fontSize: 12, fontWeight: 700, color: "#92400e", margin: "0 0 10px" }}>지급방식</p>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 6, marginBottom: 16 }}>
              {PAYMENT_METHODS.map(m => (
                <button key={m.value} onClick={() => setSf("paymentMethod", m.value === sf.paymentMethod ? "" : m.value)}
                  style={{
                    padding: "8px 6px", borderRadius: 8, fontSize: 11, cursor: "pointer", textAlign: "center", lineHeight: 1.3,
                    border: sf.paymentMethod === m.value ? "2px solid #d97706" : "1.5px solid #fde68a",
                    background: sf.paymentMethod === m.value ? "#fde68a" : "#fffbeb",
                    color: sf.paymentMethod === m.value ? "#78350f" : "#92400e",
                    fontWeight: sf.paymentMethod === m.value ? 700 : 400,
                  }}>{m.label}</button>
              ))}
            </div>

            {isDomesticWith && (
              <>
                <p style={{ fontSize: 11, fontWeight: 700, color: "#92400e", margin: "0 0 8px", textTransform: "uppercase", letterSpacing: "0.06em" }}>주민등록번호</p>
                <div style={{ marginBottom: 12 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <input type="password" value={sf.residentFront}
                      onChange={e => { const v = e.target.value.replace(/\D/g, "").slice(0, 6); setSf("residentFront", v); if (v.length === 6) backRef.current?.focus(); }}
                      placeholder="앞 6자리" maxLength={6} autoComplete="off"
                      style={{ width: 110, padding: "9px 12px", borderRadius: 8, border: "1px solid #fcd34d", fontSize: 13, textAlign: "center", fontFamily: "monospace", letterSpacing: 2, boxSizing: "border-box", background: "#fffbeb" }} />
                    <span style={{ fontSize: 18, color: "#d97706", fontWeight: 700 }}>-</span>
                    <input ref={backRef} type="password" value={sf.residentBack}
                      onChange={e => setSf("residentBack", e.target.value.replace(/\D/g, "").slice(0, 7))}
                      placeholder="뒤 7자리" maxLength={7} autoComplete="off"
                      style={{ width: 125, padding: "9px 12px", borderRadius: 8, border: "1px solid #fcd34d", fontSize: 13, textAlign: "center", fontFamily: "monospace", letterSpacing: 2, boxSizing: "border-box", background: "#fffbeb" }} />
                    <span style={{ fontSize: 11, color: "#b45309" }}>AES-256 암호화</span>
                  </div>
                </div>
                <p style={{ fontSize: 11, fontWeight: 700, color: "#92400e", margin: "0 0 8px", textTransform: "uppercase", letterSpacing: "0.06em" }}>계좌정보</p>
                <div style={{ ...grid3, marginBottom: 4 }}>
                  {SA({ label: "은행명", field: "bankName", placeholder: "국민은행" })}
                  {SA({ label: "예금주", field: "accountHolder", placeholder: "홍길동" })}
                  {SA({ label: "계좌번호", field: "bankAccount", placeholder: "123-456-789012", mono: true })}
                </div>
              </>
            )}

            {isDomesticBiz && (
              <>
                <p style={{ fontSize: 11, fontWeight: 700, color: "#92400e", margin: "0 0 8px", textTransform: "uppercase", letterSpacing: "0.06em" }}>사업자 정보</p>
                <div style={{ ...grid2, marginBottom: 12 }}>
                  {SA({ label: "사업자등록번호", field: "businessNumber", placeholder: "000-00-00000", mono: true })}
                  {SA({ label: "상호", field: "businessName", placeholder: "(주)회사명" })}
                  {SA({ label: "대표자명", field: "businessOwner", placeholder: "홍길동" })}
                  {SA({ label: "세금계산서 이메일", field: "taxInvoiceEmail", placeholder: "tax@company.com", type: "email" })}
                </div>
                <p style={{ fontSize: 11, fontWeight: 700, color: "#92400e", margin: "0 0 8px", textTransform: "uppercase", letterSpacing: "0.06em" }}>계좌정보</p>
                <div style={{ ...grid3, marginBottom: 4 }}>
                  {SA({ label: "은행명", field: "bankName", placeholder: "국민은행" })}
                  {SA({ label: "예금주", field: "accountHolder", placeholder: "홍길동" })}
                  {SA({ label: "계좌번호", field: "bankAccount", placeholder: "123-456-789012", mono: true })}
                </div>
              </>
            )}

            {isPaypal && (
              <>
                <p style={{ fontSize: 11, fontWeight: 700, color: "#92400e", margin: "0 0 8px", textTransform: "uppercase", letterSpacing: "0.06em" }}>PayPal 정보</p>
                <div style={{ ...grid2, marginBottom: 12 }}>
                  {SA({ label: "PayPal 계정 이메일", field: "paypalEmail", placeholder: "paypal@email.com", type: "email" })}
                  {SA({ label: "영문이름 (Full Name)", field: "englishName", placeholder: "Hong Gil Dong" })}
                  {SA({ label: "국가", field: "country", placeholder: "South Korea" })}
                  <div>
                    <label style={labelAmber}>통화</label>
                    <ClickSelect value={sf.currency} onChange={v => setSf("currency", v)}
                      style={{ width: "100%" }} triggerStyle={{ ...inpAmber, width: "100%", boxSizing: "border-box" as const }}
                      options={[{ value: "", label: "선택 안 함" }, ...CURRENCIES.map(c => ({ value: c, label: c }))]} />
                  </div>
                </div>
                {SA({ label: "송금 메모 (선택)", field: "remittanceMemo", placeholder: "프로젝트명 또는 메모" })}
              </>
            )}

            {isBank && (
              <>
                <p style={{ fontSize: 11, fontWeight: 700, color: "#92400e", margin: "0 0 8px", textTransform: "uppercase", letterSpacing: "0.06em" }}>수취인 정보</p>
                <div style={{ ...grid2, marginBottom: 12 }}>
                  {SA({ label: "영문이름 (Full Name)", field: "englishName", placeholder: "Hong Gil Dong" })}
                  {SA({ label: "국가", field: "country", placeholder: "United States" })}
                  <div>
                    <label style={labelAmber}>통화</label>
                    <ClickSelect value={sf.currency} onChange={v => setSf("currency", v)}
                      style={{ width: "100%" }} triggerStyle={{ ...inpAmber, width: "100%", boxSizing: "border-box" as const }}
                      options={[{ value: "", label: "선택 안 함" }, ...CURRENCIES.map(c => ({ value: c, label: c }))]} />
                  </div>
                  {SA({ label: "거주지 영문주소", field: "addressEn", placeholder: "123 Main St, City, State" })}
                </div>
                <p style={{ fontSize: 11, fontWeight: 700, color: "#92400e", margin: "0 0 8px", textTransform: "uppercase", letterSpacing: "0.06em" }}>해외 은행 정보</p>
                <div style={{ ...grid2, marginBottom: 12 }}>
                  {SA({ label: "은행명(영문)", field: "bankNameEn", placeholder: "Bank of America" })}
                  {SA({ label: "계좌번호", field: "bankAccount", placeholder: "Account Number", mono: true })}
                  {SA({ label: "SWIFT Code", field: "swiftCode", placeholder: "AAAABBCC", mono: true })}
                  {SA({ label: "Routing Number", field: "routingNumber", placeholder: "021000021", mono: true })}
                </div>
                {SA({ label: "IBAN (선택)", field: "iban", placeholder: "GB33BUKB20201555555555", mono: true })}
              </>
            )}

            {isOther && SA({ label: "정산 방식 설명", field: "settlementMemo", placeholder: "지급 방식 및 기타 정보를 입력하세요" })}

            {hasMethod && (
              <div style={{ marginTop: 14, paddingTop: 12, borderTop: "1px dashed #fde68a" }}>
                <div style={{ ...grid2, marginBottom: 10 }}>
                  <div>
                    <label style={labelAmber}>기본 통화</label>
                    <ClickSelect value={sf.baseCurrency} onChange={v => setSf("baseCurrency", v)}
                      style={{ width: "100%" }} triggerStyle={{ ...inpAmber, width: "100%", boxSizing: "border-box" as const }}
                      options={[{ value: "", label: "선택 안 함" }, ...CURRENCIES.map(c => ({ value: c, label: c }))]} />
                  </div>
                  {(isPaypal || isBank) && (
                    <div>
                      <label style={labelAmber}>해외송금 수수료 부담</label>
                      <ClickSelect value={sf.remittanceFeePayer} onChange={v => setSf("remittanceFeePayer", v)}
                        style={{ width: "100%" }} triggerStyle={{ ...inpAmber, width: "100%", boxSizing: "border-box" as const }}
                        options={[{ value: "", label: "선택 안 함" }, ...FEE_PAYER_OPTIONS.map(f => ({ value: f.value, label: f.label }))]} />
                    </div>
                  )}
                </div>
                <div style={{ marginBottom: 8 }}>
                  <label style={labelAmber}>정산 메모 (내부용)</label>
                  <input value={sf.settlementMemo} onChange={e => setSf("settlementMemo", e.target.value)}
                    placeholder="특이사항, 지급 조건 등" style={inpAmber} />
                </div>
              </div>
            )}
          </div>
        </>
      )}

      {/* ── 액션 버튼 ── */}
      <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", marginTop: 20, paddingTop: 16, borderTop: "1px solid #f3f4f6" }}>
        <GhostBtn onClick={onClose} style={{ fontSize: 14, padding: "10px 20px" }}>취소</GhostBtn>
        <PrimaryBtn onClick={handleSubmit} disabled={saving} style={{ fontSize: 14, padding: "10px 24px" }}>
          {saving ? "등록 중..." : "통번역사 등록"}
        </PrimaryBtn>
      </div>
    </DraggableModal>

    {/* ── AI 분석 패널 ── */}
    {showAnalyzePanel && resumeFile && (
      <ResumeAnalyzePanel
        token={token}
        file={resumeFile}
        autoStart={true}
        currentValues={{
          languagePairs: form.languagePairs || null,
          education: form.education || null,
          major: form.major || null,
          graduationYear: form.graduationYear ? Number(form.graduationYear) : null,
          specializations: form.specializations || null,
          profileWorkTypes: form.profileWorkTypes || null,
          profileSubTypes: form.profileSubTypes || null,
          region: form.region || null,
          bio: form.bio || null,
        }}
        onToast={onToast}
        onClose={() => setShowAnalyzePanel(false)}
        onApply={handleAnalyzeApply}
      />
    )}
  </>
  );
}
