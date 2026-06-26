import React, { useState, useEffect, useRef } from "react";
import { api, TranslatorProfile, TranslatorRate, NoteEntry, normalizeLanguages, LangExpEntry, parseLangExperiences } from "../../lib/constants";
import { PrimaryBtn, GhostBtn, ClickSelect } from "../ui";
import { DraggableModal } from "./DraggableModal";
import { SensitiveInfoModal, SETTLEMENT_TYPES } from "./SensitiveInfoModal";
import { TranslatorLangExpSection } from "./TranslatorLangExpSection";
import {
  ALL_RATE_UNITS as ALL_UNITS,
  getRateUnitLabel as getUnitLabel,
  SERVICE_TYPES as PROFILE_WORK_TYPES,
  SUB_SERVICE_TYPES as PROFILE_SUB_TYPES_MAP,
  SPECIALIZATION_PRESETS,
} from "./translatorRateConstants";
import { TranslatorRateEntryCard, RateEntryData, emptyRateEntry } from "./TranslatorRateEntryCard";
import { ResumeAnalyzePanel, ResumeAnalysisResult } from "./ResumeAnalyzePanel";
import { TranslatorEvidenceDocumentsSection } from "./TranslatorEvidenceDocumentsSection";
import { DocumentPreviewModal } from "./DocumentPreviewModal";

// ── 이력서 파일 형식 정책 ──────────────────────────────────────────────────────
const RESUME_ALLOWED_EXTS = [".pdf", ".doc", ".docx", ".txt", ".hwp", ".hwpx"] as const;
const RESUME_PREVIEWABLE_EXTS = [".pdf", ".txt"] as const;
const RESUME_ACCEPT = ".pdf,.hwp,.hwpx,.doc,.docx,.txt,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain,application/haansofthwp,application/x-hwp,application/vnd.hancom.hwp,application/vnd.hancom.hwpx";
const RESUME_HINT = "PDF · HWP · HWPX · DOC · DOCX · TXT (최대 10 MB)";
const RESUME_UPLOAD_ERROR_MSG = "PDF, HWP, HWPX, DOC, DOCX, TXT 형식만 업로드할 수 있습니다.";

function getResumeExt(resumeUrl: string | null | undefined): string {
  if (!resumeUrl) return "";
  const dot = resumeUrl.lastIndexOf(".");
  return dot >= 0 ? resumeUrl.slice(dot).toLowerCase() : "";
}

function canPreviewResume(ext: string): boolean {
  return (RESUME_PREVIEWABLE_EXTS as readonly string[]).includes(ext);
}

function getResumeDisplayName(resumeUrl: string | null | undefined, fileName: string | null): string {
  if (fileName) return fileName;
  if (!resumeUrl) return "이력서";
  const lastSlash = resumeUrl.lastIndexOf("/");
  const nameWithExt = lastSlash >= 0 ? resumeUrl.slice(lastSlash + 1) : resumeUrl;
  const extIndex = nameWithExt.lastIndexOf(".");
  const ext = extIndex >= 0 ? nameWithExt.slice(extIndex).toLowerCase() : "";
  return `이력서${ext}`;
}

const inputStyle: React.CSSProperties = {
  width: "100%", padding: "9px 12px", borderRadius: 8,
  border: "1px solid #d1d5db", fontSize: 14, color: "#111827",
  outline: "none", boxSizing: "border-box", background: "#fff",
};

const GRADE_OPTIONS = ["S", "A", "B", "C"];
const LANG_LEVEL_OPTIONS = ["일반", "전문"];

const EDUCATION_DOMESTIC = [
  "한국외국어대학교 통번역대학원",
  "이화여자대학교 통역번역대학원",
  "서울외국어대학원대학교 통번역대학원",
  "중앙대학교 국제대학원",
  "부산외국어대학교 통번역대학원",
  "제주대학교 통번역대학원",
  "선문대학교 통번역대학원",
  "계명대학교 통번역대학원",
];
const EDUCATION_OVERSEAS = [
  "Macquarie University - Translation & Interpreting",
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

const isGraduateInterpreterEducation = (education: string) =>
  EDUCATION_ALL.includes(education) ||
  education.includes("통번역대학원") ||
  education.includes("통역번역대학원");

const MAJOR_LANGUAGE = ["한영과", "한중과", "한일과", "한불과", "한독과", "한서과", "한노과", "한아과", "한영통번역", "한중통번역", "한일통번역"];
const MAJOR_INTERPRETATION = ["통번역학", "전문통번역학", "국제회의통역", "국제회의전공", "통역전공", "번역전공", "통번역전공"];
const MAJOR_SPECIALIZED = ["의료통역전공", "법률통번역전공", "영상번역전공", "AI번역전공"];
const MAJOR_ALL = [...MAJOR_LANGUAGE, ...MAJOR_INTERPRETATION, ...MAJOR_SPECIALIZED];

const _CURRENT_YEAR = new Date().getFullYear();
const GRAD_YEARS = Array.from({ length: _CURRENT_YEAR + 5 - 1979 }, (_, i) => String(_CURRENT_YEAR + 5 - i));

const GRADUATION_STATUS_OPTIONS = ["졸업", "졸업예정", "재학중", "수료", "중퇴", "기타"];

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
  // 서울특별시 (25구)
  "서울특별시 강남구", "서울특별시 강동구", "서울특별시 강북구", "서울특별시 강서구",
  "서울특별시 관악구", "서울특별시 광진구", "서울특별시 구로구", "서울특별시 금천구",
  "서울특별시 노원구", "서울특별시 도봉구", "서울특별시 동대문구", "서울특별시 동작구",
  "서울특별시 마포구", "서울특별시 서대문구", "서울특별시 서초구", "서울특별시 성동구",
  "서울특별시 성북구", "서울특별시 송파구", "서울특별시 양천구", "서울특별시 영등포구",
  "서울특별시 용산구", "서울특별시 은평구", "서울특별시 종로구", "서울특별시 중구",
  "서울특별시 중랑구",
  // 경기도
  "경기도 수원시", "경기도 수원시 장안구", "경기도 수원시 권선구", "경기도 수원시 팔달구", "경기도 수원시 영통구",
  "경기도 성남시", "경기도 성남시 수정구", "경기도 성남시 중원구", "경기도 성남시 분당구",
  "경기도 고양시", "경기도 고양시 덕양구", "경기도 고양시 일산동구", "경기도 고양시 일산서구",
  "경기도 용인시", "경기도 용인시 처인구", "경기도 용인시 기흥구", "경기도 용인시 수지구",
  "경기도 안양시", "경기도 안양시 만안구", "경기도 안양시 동안구",
  "경기도 안산시", "경기도 안산시 상록구", "경기도 안산시 단원구",
  "경기도 의정부시", "경기도 부천시", "경기도 광명시", "경기도 평택시",
  "경기도 동두천시", "경기도 과천시", "경기도 구리시", "경기도 남양주시",
  "경기도 오산시", "경기도 시흥시", "경기도 군포시", "경기도 의왕시",
  "경기도 하남시", "경기도 파주시", "경기도 이천시", "경기도 안성시",
  "경기도 김포시", "경기도 화성시", "경기도 광주시", "경기도 양주시",
  "경기도 포천시", "경기도 여주시", "경기도 연천군", "경기도 가평군", "경기도 양평군",
  // 인천광역시
  "인천광역시 중구", "인천광역시 동구", "인천광역시 미추홀구", "인천광역시 연수구",
  "인천광역시 남동구", "인천광역시 부평구", "인천광역시 계양구", "인천광역시 서구",
  "인천광역시 강화군", "인천광역시 옹진군",
  // 부산광역시
  "부산광역시 중구", "부산광역시 서구", "부산광역시 동구", "부산광역시 영도구",
  "부산광역시 부산진구", "부산광역시 동래구", "부산광역시 남구", "부산광역시 북구",
  "부산광역시 해운대구", "부산광역시 사하구", "부산광역시 금정구", "부산광역시 강서구",
  "부산광역시 연제구", "부산광역시 수영구", "부산광역시 사상구", "부산광역시 기장군",
  // 대구광역시
  "대구광역시 중구", "대구광역시 동구", "대구광역시 서구", "대구광역시 남구",
  "대구광역시 북구", "대구광역시 수성구", "대구광역시 달서구", "대구광역시 달성군",
  // 대전광역시
  "대전광역시 동구", "대전광역시 중구", "대전광역시 서구", "대전광역시 유성구", "대전광역시 대덕구",
  // 광주광역시
  "광주광역시 동구", "광주광역시 서구", "광주광역시 남구", "광주광역시 북구", "광주광역시 광산구",
  // 울산광역시
  "울산광역시 중구", "울산광역시 남구", "울산광역시 동구", "울산광역시 북구", "울산광역시 울주군",
  // 세종특별자치시
  "세종특별자치시",
  // 강원특별자치도
  "강원특별자치도 춘천시", "강원특별자치도 원주시", "강원특별자치도 강릉시",
  "강원특별자치도 동해시", "강원특별자치도 태백시", "강원특별자치도 속초시",
  "강원특별자치도 삼척시", "강원특별자치도 홍천군", "강원특별자치도 횡성군",
  "강원특별자치도 영월군", "강원특별자치도 평창군", "강원특별자치도 정선군",
  "강원특별자치도 철원군", "강원특별자치도 화천군", "강원특별자치도 양구군",
  "강원특별자치도 인제군", "강원특별자치도 고성군", "강원특별자치도 양양군",
  // 충청북도
  "충청북도 청주시", "충청북도 청주시 상당구", "충청북도 청주시 서원구", "충청북도 청주시 흥덕구", "충청북도 청주시 청원구",
  "충청북도 충주시", "충청북도 제천시", "충청북도 보은군", "충청북도 옥천군",
  "충청북도 영동군", "충청북도 증평군", "충청북도 진천군", "충청북도 괴산군",
  "충청북도 음성군", "충청북도 단양군",
  // 충청남도
  "충청남도 천안시", "충청남도 천안시 동남구", "충청남도 천안시 서북구",
  "충청남도 공주시", "충청남도 보령시", "충청남도 아산시", "충청남도 서산시",
  "충청남도 논산시", "충청남도 계룡시", "충청남도 당진시", "충청남도 금산군",
  "충청남도 부여군", "충청남도 서천군", "충청남도 청양군", "충청남도 홍성군",
  "충청남도 예산군", "충청남도 태안군",
  // 전북특별자치도
  "전북특별자치도 전주시", "전북특별자치도 전주시 완산구", "전북특별자치도 전주시 덕진구",
  "전북특별자치도 군산시", "전북특별자치도 익산시", "전북특별자치도 정읍시",
  "전북특별자치도 남원시", "전북특별자치도 김제시", "전북특별자치도 완주군",
  "전북특별자치도 진안군", "전북특별자치도 무주군", "전북특별자치도 장수군",
  "전북특별자치도 임실군", "전북특별자치도 순창군", "전북특별자치도 고창군", "전북특별자치도 부안군",
  // 전라남도
  "전라남도 목포시", "전라남도 여수시", "전라남도 순천시", "전라남도 나주시", "전라남도 광양시",
  "전라남도 담양군", "전라남도 곡성군", "전라남도 구례군", "전라남도 고흥군",
  "전라남도 보성군", "전라남도 화순군", "전라남도 장흥군", "전라남도 강진군",
  "전라남도 해남군", "전라남도 영암군", "전라남도 무안군", "전라남도 함평군",
  "전라남도 영광군", "전라남도 장성군", "전라남도 완도군", "전라남도 진도군", "전라남도 신안군",
  // 경상북도
  "경상북도 포항시", "경상북도 포항시 남구", "경상북도 포항시 북구",
  "경상북도 경주시", "경상북도 김천시", "경상북도 안동시", "경상북도 구미시",
  "경상북도 영주시", "경상북도 영천시", "경상북도 상주시", "경상북도 문경시",
  "경상북도 경산시", "경상북도 군위군", "경상북도 의성군", "경상북도 청송군",
  "경상북도 영양군", "경상북도 영덕군", "경상북도 청도군", "경상북도 고령군",
  "경상북도 성주군", "경상북도 칠곡군", "경상북도 예천군", "경상북도 봉화군",
  "경상북도 울진군", "경상북도 울릉군",
  // 경상남도
  "경상남도 창원시", "경상남도 창원시 의창구", "경상남도 창원시 성산구", "경상남도 창원시 마산합포구",
  "경상남도 창원시 마산회원구", "경상남도 창원시 진해구",
  "경상남도 진주시", "경상남도 통영시", "경상남도 사천시", "경상남도 김해시",
  "경상남도 밀양시", "경상남도 거제시", "경상남도 양산시", "경상남도 의령군",
  "경상남도 함안군", "경상남도 창녕군", "경상남도 고성군", "경상남도 남해군",
  "경상남도 하동군", "경상남도 산청군", "경상남도 함양군", "경상남도 거창군", "경상남도 합천군",
  // 제주특별자치도
  "제주특별자치도 제주시", "제주특별자치도 서귀포시",
];

// 시/도 + 시/군/구 통합 목록 (시/도 먼저)
const KOREA_ALL_OPTIONS: readonly string[] = [...KOREA_REGIONS, ...KOREA_REGION_DISTRICTS];

const OVERSEAS_CITIES: Record<string, readonly string[]> = {
  "일본": ["도쿄", "오사카", "요코하마", "나고야", "후쿠오카", "교토", "고베", "삿포로", "히로시마", "센다이", "사이타마", "치바", "가와사키", "기타큐슈"],
  "미국": ["캘리포니아주 로스앤젤레스", "캘리포니아주 샌프란시스코", "캘리포니아주 샌디에이고", "캘리포니아주 산호세", "뉴욕주 뉴욕", "뉴저지주 저지시티", "일리노이주 시카고", "텍사스주 댈러스", "텍사스주 휴스턴", "텍사스주 오스틴", "워싱턴주 시애틀", "조지아주 애틀랜타", "매사추세츠주 보스턴", "워싱턴 D.C.", "버지니아주", "메릴랜드주", "플로리다주 마이애미"],
  "중국": ["베이징", "상하이", "광저우", "선전", "항저우", "난징", "칭다오", "톈진", "청두", "충칭", "우한", "시안", "쑤저우", "다롄", "선양"],
  "대만": ["타이베이", "신베이", "타이중", "타이난", "가오슝", "신주"],
  "홍콩": ["홍콩", "구룡", "신계"],
  "싱가포르": ["싱가포르"],
  "말레이시아": ["쿠알라룸푸르", "조호르바루", "페낭", "말라카", "코타키나발루"],
  "태국": ["방콕", "치앙마이", "푸켓", "파타야"],
  "베트남": ["하노이", "호치민", "다낭", "하이퐁", "나트랑"],
  "인도네시아": ["자카르타", "수라바야", "발리", "반둥", "메단"],
  "필리핀": ["마닐라", "세부", "클락", "다바오"],
  "인도": ["뉴델리", "뭄바이", "벵갈루루", "첸나이", "하이데라바드", "푸네", "구르가온"],
  "영국": ["런던", "맨체스터", "버밍엄", "에든버러", "글래스고", "리즈"],
  "독일": ["베를린", "프랑크푸르트", "뮌헨", "함부르크", "뒤셀도르프", "슈투트가르트", "쾰른"],
  "프랑스": ["파리", "리옹", "마르세유", "니스", "툴루즈"],
  "이탈리아": ["로마", "밀라노", "베네치아", "피렌체", "토리노"],
  "스페인": ["마드리드", "바르셀로나", "발렌시아", "세비야"],
  "네덜란드": ["암스테르담", "로테르담", "헤이그", "에인트호번"],
  "벨기에": ["브뤼셀", "앤트워프", "겐트"],
  "스위스": ["취리히", "제네바", "바젤", "로잔"],
  "오스트리아": ["빈", "잘츠부르크", "그라츠"],
  "러시아": ["모스크바", "상트페테르부르크", "블라디보스토크"],
  "캐나다": ["토론토", "밴쿠버", "몬트리올", "오타와", "캘거리", "에드먼턴"],
  "호주": ["시드니", "멜버른", "브리즈번", "퍼스", "애들레이드", "캔버라"],
  "뉴질랜드": ["오클랜드", "웰링턴", "크라이스트처치"],
  "UAE": ["두바이", "아부다비"],
  "사우디아라비아": ["리야드", "제다", "담맘"],
  "카타르": ["도하"],
  "멕시코": ["멕시코시티", "몬테레이", "과달라하라", "티후아나"],
  "브라질": ["상파울루", "리우데자네이루", "브라질리아", "쿠리치바"],
};

type EmailEntry = { email: string; isPrimary: boolean; error: string };
const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function formatPhoneNumber(value: string): string {
  const n = value.replace(/\D/g, "");
  if (n.length <= 3) return n;
  if (n.length <= 7) return `${n.slice(0, 3)}-${n.slice(3)}`;
  return `${n.slice(0, 3)}-${n.slice(3, 7)}-${n.slice(7, 11)}`;
}

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
    return { country: "기타", city: part1, countryCustom: fromPart2 };
  }

  // 단일 값: 한국어 국가 목록 직접 매칭
  if ((REGION_COUNTRIES as readonly string[]).slice(0, -1).includes(regionStr)) return { country: regionStr, city: "", countryCustom: "" };
  // 영어 국가명 단일 값 ("South Korea" 등)
  const mappedCountry = resolveCountry(regionStr);
  if ((REGION_COUNTRIES as readonly string[]).includes(mappedCountry)) return { country: mappedCountry, city: "", countryCustom: "" };
  // 알 수 없는 값 → 대한민국 지역으로 처리
  return { country: "대한민국", city: regionStr, countryCustom: "" };
}

function buildRegionString(country: string, countryCustom: string, city: string): string {
  const label = country === "기타" ? countryCustom.trim() : country;
  if (!label) return city.trim();
  return city.trim() ? `${label} / ${city.trim()}` : label;
}

function KoreaRegionCombobox({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [query, setQuery] = useState(value);
  const [open, setOpen] = useState(false);
  const [hoveredIdx, setHoveredIdx] = useState(-1);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => { setQuery(value); }, [value]);

  const filtered = query.trim()
    ? KOREA_ALL_OPTIONS.filter(r => r.includes(query.trim()))
    : [...KOREA_REGIONS]; // 기본값: 시/도 17개 표시

  const isLegacy = Boolean(value) && !KOREA_ALL_OPTIONS.includes(value);

  useEffect(() => {
    const handle = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
        setQuery(value); // 선택 없이 닫히면 저장값으로 복원
      }
    };
    document.addEventListener("mousedown", handle);
    return () => document.removeEventListener("mousedown", handle);
  }, [value]);

  const handleSelect = (opt: string) => {
    setQuery(opt);
    onChange(opt);
    setOpen(false);
    setHoveredIdx(-1);
  };

  return (
    <div ref={containerRef} style={{ position: "relative" }}>
      <div style={{ position: "relative" }}>
        <input
          type="text"
          value={query}
          onFocus={() => setOpen(true)}
          onChange={e => { setQuery(e.target.value); setOpen(true); setHoveredIdx(-1); }}
          onKeyDown={e => {
            if (e.key === "Escape") { setOpen(false); setQuery(value); }
            else if (e.key === "Enter" && hoveredIdx >= 0 && filtered[hoveredIdx]) { handleSelect(filtered[hoveredIdx]); }
            else if (e.key === "ArrowDown") { e.preventDefault(); setHoveredIdx(i => Math.min(i + 1, filtered.length - 1)); }
            else if (e.key === "ArrowUp") { e.preventDefault(); setHoveredIdx(i => Math.max(i - 1, 0)); }
          }}
          placeholder="검색 (예: 서울, 경기도, 강남구, 분당)"
          style={{ ...inputStyle, fontSize: 13, padding: "7px 32px 7px 10px" }}
        />
        <span style={{ position: "absolute", right: 10, top: "50%", transform: "translateY(-50%)", fontSize: 11, color: "#9ca3af", pointerEvents: "none" }}>▼</span>
      </div>
      {open && (
        <ul style={{
          position: "absolute", top: "calc(100% + 2px)", left: 0, right: 0,
          background: "#fff", border: "1px solid #d1d5db", borderRadius: 8,
          boxShadow: "0 6px 20px rgba(0,0,0,0.13)",
          maxHeight: 240, overflowY: "auto",
          margin: 0, padding: "4px 0", listStyle: "none", zIndex: 9999,
        }}>
          {isLegacy && (
            <li
              onMouseDown={e => { e.preventDefault(); handleSelect(value); }}
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
                <span style={{ fontSize: 10, color: "#9ca3af", background: "#f3f4f6", borderRadius: 3, padding: "1px 5px", flexShrink: 0, marginLeft: 6 }}>시/도</span>
              )}
            </li>
          ))}
          {!query.trim() && (
            <li style={{ padding: "5px 12px", fontSize: 11, color: "#9ca3af", borderTop: "1px solid #f3f4f6", textAlign: "center" as const }}>
              검색 시 시/도·시/군/구 모두 표시됩니다
            </li>
          )}
        </ul>
      )}
    </div>
  );
}

function OverseasRegionCombobox({ value, onChange, country }: {
  value: string;
  onChange: (v: string) => void;
  country: string;
}) {
  const options: readonly string[] = OVERSEAS_CITIES[country] ?? [];
  const [query, setQuery] = useState(() => options.includes(value) ? value : "");
  const [open, setOpen] = useState(false);
  const [hoveredIdx, setHoveredIdx] = useState(-1);
  const containerRef = useRef<HTMLDivElement>(null);
  const queryRef = useRef(query);
  queryRef.current = query;
  const mountedRef = useRef(false);

  // 마운트 후 value 변경(선택/저장) 시 동기화 — 마운트 첫 실행은 스킵(스마트 초기화 유지)
  useEffect(() => {
    if (!mountedRef.current) { mountedRef.current = true; return; }
    setQuery(value);
  }, [value]);

  // 해외 국가 전환 시 검색어 초기화 → 새 국가 도시 목록 즉시 표시
  const prevCountry = useRef(country);
  useEffect(() => {
    if (prevCountry.current !== country) {
      prevCountry.current = country;
      const newOpts = OVERSEAS_CITIES[country] ?? [];
      setQuery(newOpts.includes(value) ? value : "");
    }
  }, [country, value]);

  const filtered = query.trim()
    ? options.filter(r => r.includes(query.trim()))
    : options;

  const isLegacy = Boolean(value) && !options.includes(value);

  useEffect(() => {
    const handle = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
        const q = queryRef.current.trim();
        // 직접 입력값 저장 (선택 없이 닫혀도 타이핑한 값 유지)
        if (q && q !== value) onChange(q);
        else if (!q) setQuery(value);
      }
    };
    document.addEventListener("mousedown", handle);
    return () => document.removeEventListener("mousedown", handle);
  }, [value, onChange]);

  const handleSelect = (opt: string) => {
    setQuery(opt);
    onChange(opt);
    setOpen(false);
    setHoveredIdx(-1);
  };

  const placeholder = options.length > 0
    ? `${country} 주요 도시 검색 또는 직접 입력`
    : "지역/도시 직접 입력";

  return (
    <div ref={containerRef} style={{ position: "relative" }}>
      <div style={{ position: "relative" }}>
        <input
          type="text"
          value={query}
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
          maxHeight: 220, overflowY: "auto",
          margin: 0, padding: "4px 0", listStyle: "none", zIndex: 9999,
        }}>
          {isLegacy && (
            <li onMouseDown={e => { e.preventDefault(); handleSelect(value); }}
              style={{ padding: "6px 12px", fontSize: 12, cursor: "pointer", color: "#9ca3af", background: "#fafafa", borderBottom: "1px solid #f3f4f6" }}>
              {value} <span style={{ fontSize: 10, color: "#c4b5fd" }}>(기존값)</span>
            </li>
          )}
          {filtered.length === 0 && query.trim() ? (
            <li style={{ padding: "8px 12px", fontSize: 13, color: "#374151" }}>
              <span style={{ fontWeight: 600, color: "#6366f1" }}>{query}</span>
              <span style={{ color: "#9ca3af", fontSize: 12 }}> — Enter로 직접 저장</span>
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
          {options.length > 0 && (
            <li style={{ padding: "5px 12px", fontSize: 11, color: "#9ca3af", borderTop: "1px solid #f3f4f6", textAlign: "center" as const }}>
              목록에 없으면 직접 입력 후 Enter
            </li>
          )}
        </ul>
      )}
    </div>
  );
}

export function TranslatorDetailModal({ userId, userEmail, token, permissions = [], onClose, onToast, onDeleted, onSaved }: {
  userId: number; userEmail: string; token: string;
  permissions?: string[];
  onClose: () => void; onToast: (msg: string) => void;
  onDeleted?: () => void; onSaved?: () => void;
}) {
  const hasPerm = (key: string) => permissions.includes(key);
  const [profile, setProfile] = useState<TranslatorProfile | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleteCanForce] = useState(false);
  const [activating, setActivating] = useState(false);
  const [permanentDeleting, setPermanentDeleting] = useState(false);
  const [permanentDeleteError, setPermanentDeleteError] = useState<string | null>(null);
  const [userInfo, setUserInfo] = useState<{ name: string; email: string; isActive: boolean; invitePending?: boolean } | null>(null);
  const [reinviting, setReinviting] = useState(false);
  const [rates, setRates] = useState<TranslatorRate[]>([]);
  const [notes, setNotes] = useState<NoteEntry[]>([]);
  const [emailEntries, setEmailEntries] = useState<EmailEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [noteText, setNoteText] = useState("");
  const [addingNote, setAddingNote] = useState(false);
  const [rateForm, setRateForm] = useState<RateEntryData>(emptyRateEntry());
  const [addingRate, setAddingRate] = useState(false);
  const [showSensitive, setShowSensitive] = useState(false);
  const [resumeUploading, setResumeUploading] = useState(false);
  const [resumeDeleting, setResumeDeleting] = useState(false);
  const [showAllSubTypes, setShowAllSubTypes] = useState(false);
  const [showAllSpecs, setShowAllSpecs] = useState(false);
  const [regionCountry, setRegionCountry] = useState("대한민국");
  const [regionCity, setRegionCity] = useState("");
  const [regionCountryCustom, setRegionCountryCustom] = useState("");
  const [pinnedSubTypes, setPinnedSubTypes] = useState<Set<string>>(new Set());
  const [showOtherSpec, setShowOtherSpec] = useState(false);
  const [showAnalyzePanel, setShowAnalyzePanel] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [docSubTab, setDocSubTab] = useState<"resume" | "id" | "bank">("resume");
  const [resumeFileName, setResumeFileName] = useState<string | null>(null);
  const [resumePreview, setResumePreview] = useState<{ url: string; fileName: string } | null>(null);
  const [eduIsCustom, setEduIsCustom] = useState(false);
  const [eduCustom, setEduCustom] = useState("");
  const [majorIsCustom, setMajorIsCustom] = useState(false);
  const [majorCustom, setMajorCustom] = useState("");
  const [collapsed, setCollapsed] = useState({
    resume: true,
    operational: true,
    operations: true,
    rates: true,
  });
  const toggleSection = (key: keyof typeof collapsed) =>
    setCollapsed(p => ({ ...p, [key]: !p[key] }));
  const [langExperiences, setLangExperiences] = useState<LangExpEntry[]>([]);

  const [form, setForm] = useState({
    name: "",
    phone: "",
    languagePairs: "", languageLevel: "", specializations: "", education: "", major: "",
    graduationYear: "", graduationStatus: "", region: "", grade: "", rating: "", availabilityStatus: "available",
    bio: "",
    affiliatedCompanyId: "" as string,
    settlementType: "",
    profileWorkTypes: "",
    profileSubTypes: "",
    operationalStatus: "normal",
    operationalNote: "",
    reassignmentAllowed: true,
  });
  const [vendorCompanies, setVendorCompanies] = useState<Array<{ id: number; name: string }>>([]);

  const authH = { Authorization: `Bearer ${token}` };

  const handleResumeUpload = async (file: File) => {
    const ext = file.name.slice(file.name.lastIndexOf(".")).toLowerCase();
    if (!(RESUME_ALLOWED_EXTS as readonly string[]).includes(ext)) {
      onToast(RESUME_UPLOAD_ERROR_MSG);
      return;
    }
    if (profile?.resumeUrl && !window.confirm("기존 이력서를 새 파일로 교체하시겠습니까?")) return;
    setResumeUploading(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const r = await fetch(api(`/api/admin/translators/${userId}/resume-upload`), {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: fd,
      });
      const d = await r.json();
      if (r.ok) {
        setProfile(p => p ? { ...p, resumeUrl: d.resumeUrl } : p);
        setResumeFileName(d.fileName ?? null);
        onToast("이력서가 업로드되었습니다.");
      } else {
        onToast(`오류: ${d.error}`);
      }
    } catch { onToast("오류: 이력서 업로드 실패"); }
    finally { setResumeUploading(false); }
  };

  const load = async () => {
    setLoading(true);
    try {
      const [dRes, nRes, vcRes] = await Promise.all([
        fetch(api(`/api/admin/translators/${userId}`), { headers: authH }),
        fetch(api(`/api/admin/notes?entityType=translator&entityId=${userId}`), { headers: authH }),
        fetch(api(`/api/admin/companies?companyType=vendor`), { headers: authH }),
      ]);
      const [dData, nData, vcData] = await Promise.all([dRes.json(), nRes.json(), vcRes.json()]);
      if (vcRes.ok && Array.isArray(vcData)) {
        setVendorCompanies(vcData.map((c: { id: number; name: string }) => ({ id: c.id, name: c.name })));
      }
      if (dRes.ok) {
        const u = dData.user;
        setUserInfo({ name: u?.name ?? "", email: u?.email ?? userEmail, isActive: u?.isActive ?? true, invitePending: dData.user?.inviteStatus === "pending" });
        const p: TranslatorProfile | null = dData.profile;
        setProfile(p);
        setRates(Array.isArray(dData.rates) ? dData.rates : []);
        // 이메일 목록 구성
        const allEmails: Array<{ email: string; isPrimary: boolean }> = Array.isArray(dData.emails) ? dData.emails : [];
        const fallbackPrimary = u?.email ?? userEmail;
        let entries: EmailEntry[];
        if (allEmails.length > 0) {
          entries = allEmails.map(e => ({ email: e.email, isPrimary: e.isPrimary, error: "" }));
        } else {
          // translator_emails 없으면 users.email을 대표로
          entries = [{ email: fallbackPrimary, isPrimary: true, error: "" }];
        }
        // 대표 없으면 첫 번째를 대표로
        if (!entries.some(e => e.isPrimary)) entries[0].isPrimary = true;
        // 대표 이메일을 최상단으로 정렬
        entries.sort((a, b) => (b.isPrimary ? 1 : 0) - (a.isPrimary ? 1 : 0));
        setEmailEntries(entries);

        // 언어레벨 "비즈니스" → "일반" 정규화
        const rawLevel = p?.languageLevel ?? "";
        const normalizedLevel = rawLevel === "비즈니스" ? "일반" : rawLevel;
        setForm({
          name: u?.name ?? "",
          phone: formatPhoneNumber(p?.phone ?? ""),
          languagePairs: p?.languagePairs ?? "", languageLevel: normalizedLevel,
          specializations: p?.specializations ?? "", education: p?.education ?? "", major: p?.major ?? "",
          graduationYear: p?.graduationYear ? String(p.graduationYear) : "",
          graduationStatus: p?.graduationStatus ?? "",
          region: p?.region ?? "", grade: p?.grade ?? "",
          rating: p?.rating ? String(p.rating) : "",
          availabilityStatus: p?.availabilityStatus ?? "available",
          bio: p?.bio ?? "",
          affiliatedCompanyId: p?.affiliatedCompanyId ? String(p.affiliatedCompanyId) : "",
          settlementType: p?.settlementType ?? "",
          profileWorkTypes: p?.profileWorkTypes ?? "",
          profileSubTypes: p?.profileSubTypes ?? "",
          operationalStatus: p?.operationalStatus ?? "normal",
          operationalNote: p?.operationalNote ?? "",
          reassignmentAllowed: p?.reassignmentAllowed !== false,
        });
        // 앞 2개 = 대표 세부유형
        const rawSubs = (p?.profileSubTypes ?? "").split(",").map(s => s.trim()).filter(Boolean);
        setPinnedSubTypes(new Set(rawSubs.slice(0, 2)));
        setLangExperiences(parseLangExperiences((p as any)?.languageExperiences));
        // 거주지역 파싱
        const parsedRegion = parseRegionStr(p?.region ?? "");
        setRegionCountry(parsedRegion.country);
        setRegionCity(parsedRegion.city);
        setRegionCountryCustom(parsedRegion.countryCustom);
        // 기타 전문분야 입력창: 기존 데이터에 preset 외 값이 있으면 열어둠
        const existingSpecs = (p?.specializations ?? "").split(",").map(s => s.trim()).filter(Boolean);
        setShowOtherSpec(existingSpecs.some(s => !(SPECIALIZATION_PRESETS as readonly string[]).includes(s)));
        // 학력/전공 — 기존 데이터가 preset 외 값이면 custom 모드로 초기화
        const loadedEdu = p?.education ?? "";
        if (loadedEdu && !EDUCATION_ALL.includes(loadedEdu)) {
          setEduIsCustom(true); setEduCustom(loadedEdu);
        } else {
          setEduIsCustom(false); setEduCustom("");
        }
        const loadedMajor = p?.major ?? "";
        if (loadedMajor && !MAJOR_ALL.includes(loadedMajor)) {
          setMajorIsCustom(true); setMajorCustom(loadedMajor);
        } else {
          setMajorIsCustom(false); setMajorCustom("");
        }
      }
      if (nRes.ok) setNotes(Array.isArray(nData) ? nData : []);
    } catch { onToast("오류: 통번역사 정보 불러오기 실패"); }
    finally { setLoading(false); }
  };

  useEffect(() => { load(); }, [userId]);

  const handleTogglePin = (st: string) => {
    if (pinnedSubTypes.has(st)) {
      setPinnedSubTypes(prev => { const n = new Set(prev); n.delete(st); return n; });
    } else if (pinnedSubTypes.size >= 2) {
      onToast("대표 세부유형은 최대 2개까지 선택할 수 있습니다.");
    } else {
      setPinnedSubTypes(prev => new Set(prev).add(st));
    }
  };

  const handleSave = async () => {
    // 이메일 검증
    const validated = emailEntries.map(e => {
      const t = e.email.trim().toLowerCase();
      if (!t) return { ...e, error: "이메일을 입력하세요." };
      if (!emailRegex.test(t)) return { ...e, error: "올바른 이메일 형식이 아닙니다." };
      return { ...e, error: "" };
    });
    if (validated.some(e => e.error)) { setEmailEntries(validated); return; }

    // 중복 검사
    const allNorm = validated.map(e => e.email.trim().toLowerCase());
    if (new Set(allNorm).size !== allNorm.length) {
      onToast("동일한 이메일이 중복 입력되어 있습니다."); return;
    }

    // 대표 이메일 1개 확인
    const primaryCount = validated.filter(e => e.isPrimary).length;
    if (primaryCount !== 1) {
      onToast("대표 이메일은 반드시 1개여야 합니다."); return;
    }

    setSaving(true);
    // ④ PATCH payload로 보내는 name
    console.log(`[NAME-TRACE][4] handleSave PATCH payload name="${form.name.trim() || "null"}" (form.name raw="${form.name}")`);
    try {
      const res = await fetch(api(`/api/admin/translators/${userId}`), {
        method: "PATCH", headers: { ...authH, "Content-Type": "application/json" },
        body: JSON.stringify({
          ...form,
          name: form.name.trim() || null,
          phone: form.phone.trim() || null,
          graduationYear: form.graduationYear ? Number(form.graduationYear) : null,
          rating: form.rating ? Number(form.rating) : null,
          grade: form.grade || null,
          languageLevel: form.languageLevel || null,
          affiliatedCompanyId: form.affiliatedCompanyId ? Number(form.affiliatedCompanyId) : null,
          settlementType: form.settlementType || null,
          profileWorkTypes: form.profileWorkTypes.trim() || null,
          profileSubTypes: (() => {
            const all = form.profileSubTypes.split(",").map(s => s.trim()).filter(Boolean);
            const reordered = [...all.filter(s => pinnedSubTypes.has(s)), ...all.filter(s => !pinnedSubTypes.has(s))];
            return reordered.join(",") || null;
          })(),
          operationalStatus: form.operationalStatus || "normal",
          operationalNote: form.operationalNote.trim() || null,
          reassignmentAllowed: form.reassignmentAllowed,
          languageExperiences: langExperiences.length > 0 ? JSON.stringify(langExperiences) : null,
          emails: validated.map(e => ({ email: e.email.trim().toLowerCase(), isPrimary: e.isPrimary })),
        }),
      });
      const data = await res.json();
      if (!res.ok) { onToast(`오류: ${data.error}`); return; }
      // name이 변경된 경우 userInfo 동기화
      if (form.name.trim()) setUserInfo(prev => prev ? { ...prev, name: form.name.trim() } : prev);
      setProfile(data);
      // 저장 응답값으로 form state 갱신 (학력/전공/졸업연도/전문분야 포함)
      setForm(prev => ({
        ...prev,
        education: data.education ?? "",
        major: data.major ?? "",
        graduationYear: data.graduationYear ? String(data.graduationYear) : "",
        graduationStatus: data.graduationStatus ?? "",
        specializations: data.specializations ?? "",
        languagePairs: data.languagePairs ?? "",
        languageLevel: data.languageLevel ?? "",
        region: data.region ?? "",
        grade: data.grade ?? "",
        rating: data.rating ? String(data.rating) : "",
        availabilityStatus: data.availabilityStatus ?? "available",
        bio: data.bio ?? "",
        affiliatedCompanyId: data.affiliatedCompanyId ? String(data.affiliatedCompanyId) : "",
        settlementType: data.settlementType ?? "",
        profileWorkTypes: data.profileWorkTypes ?? "",
        profileSubTypes: data.profileSubTypes ?? "",
        operationalStatus: data.operationalStatus ?? "normal",
        operationalNote: data.operationalNote ?? "",
        reassignmentAllowed: data.reassignmentAllowed !== false,
      }));
      // 저장된 profileSubTypes 기준으로 pins 재동기화 (앞 N개 유지)
      const savedSubs = (data.profileSubTypes ?? "").split(",").map((s: string) => s.trim()).filter(Boolean);
      setPinnedSubTypes(prev => new Set(savedSubs.slice(0, prev.size)));
      // 학력/전공 custom 상태 동기화
      const savedEdu = data.education ?? "";
      if (savedEdu && !EDUCATION_ALL.includes(savedEdu)) { setEduIsCustom(true); setEduCustom(savedEdu); }
      else { setEduIsCustom(false); setEduCustom(""); }
      const savedMajor = data.major ?? "";
      if (savedMajor && !MAJOR_ALL.includes(savedMajor)) { setMajorIsCustom(true); setMajorCustom(savedMajor); }
      else { setMajorIsCustom(false); setMajorCustom(""); }
      // 거주지역 state 재동기화
      const savedRegion = parseRegionStr(data.region ?? "");
      setRegionCountry(savedRegion.country);
      setRegionCity(savedRegion.city);
      setRegionCountryCustom(savedRegion.countryCustom);
      // 대표 이메일 변경 시 userInfo 갱신
      const newPrimary = validated.find(e => e.isPrimary)?.email.trim().toLowerCase() ?? "";
      if (newPrimary) setUserInfo(prev => prev ? { ...prev, email: newPrimary } : prev);
      onToast("통번역사 프로필이 저장되었습니다.");
      onSaved?.();
    } catch { onToast("오류: 저장 실패"); }
    finally { setSaving(false); }
  };

  const handleAddRate = async () => {
    if (!rateForm.workType || !rateForm.rate) { onToast("업무유형과 기본단가를 입력하세요."); return; }
    const subTypeVal = rateForm.subType.trim() || null;
    const srcLang = rateForm.sourceLang === "기타" ? rateForm.sourceCustom.trim() || "기타" : rateForm.sourceLang;
    const tgtLang = rateForm.targetLang === "기타" ? rateForm.targetCustom.trim() || "기타" : rateForm.targetLang;
    if (!srcLang || !tgtLang) { onToast("출발 언어와 도착 언어를 모두 선택하세요."); return; }
    if (srcLang === tgtLang) { onToast("출발 언어와 도착 언어가 같을 수 없습니다."); return; }
    const isDuplicate = rates.some(r =>
      r.serviceType === rateForm.workType &&
      (r.subType ?? null) === subTypeVal &&
      (r.language ?? null) === srcLang &&
      (r.languagePair ?? null) === tgtLang &&
      r.unit === rateForm.unit,
    );
    if (isDuplicate) { onToast("동일한 조합(업무유형+세부유형+출발언어+도착언어+단가단위)의 단가가 이미 존재합니다."); return; }
    setAddingRate(true);
    try {
      const res = await fetch(api(`/api/admin/translators/${userId}/rates`), {
        method: "POST", headers: { ...authH, "Content-Type": "application/json" },
        body: JSON.stringify({
          workType: rateForm.workType,
          subType: subTypeVal,
          language: srcLang,
          languagePair: tgtLang,
          unit: rateForm.unit,
          rate: Number(rateForm.rate),
          currency: rateForm.currency,
          vatIncluded: rateForm.vatIncluded,
          isDefault: rateForm.isDefault,
          isActive: rateForm.isActive,
          minPrice: rateForm.minPrice ? Number(rateForm.minPrice) : null,
          baseHours: rateForm.baseHours ? Number(rateForm.baseHours) : null,
          overtimeRate: rateForm.overtimeRate ? Number(rateForm.overtimeRate) : null,
          memo: rateForm.memo || null,
        }),
      });
      const data = await res.json();
      if (!res.ok) { onToast(`오류: ${data.error}`); return; }
      setRates(prev => [data, ...prev]);
      setRateForm(emptyRateEntry());
      onToast("단가가 추가되었습니다.");
    } catch { onToast("오류: 단가 추가 실패"); }
    finally { setAddingRate(false); }
  };

  const handleDeleteRate = async (rateId: number) => {
    try {
      await fetch(api(`/api/admin/translators/${userId}/rates/${rateId}`), { method: "DELETE", headers: authH });
      setRates(prev => prev.filter(r => r.id !== rateId));
      onToast("단가가 삭제되었습니다.");
    } catch { onToast("오류: 단가 삭제 실패"); }
  };

  const handleAddNote = async () => {
    if (!noteText.trim()) return;
    setAddingNote(true);
    try {
      const res = await fetch(api("/api/admin/notes"), {
        method: "POST", headers: { ...authH, "Content-Type": "application/json" },
        body: JSON.stringify({ entityType: "translator", entityId: userId, content: noteText.trim() }),
      });
      const data = await res.json();
      if (!res.ok) { onToast(`오류: ${data.error}`); return; }
      setNotes(prev => [data, ...prev]);
      setNoteText("");
      onToast("메모가 추가되었습니다.");
    } catch { onToast("오류: 메모 추가 실패"); }
    finally { setAddingNote(false); }
  };

  const sH: React.CSSProperties = {
    fontSize: 14, fontWeight: 700, color: "#111827",
    borderLeft: "3px solid #6366f1", paddingLeft: 10,
    margin: 0, lineHeight: 1.5,
  };
  const labelSt: React.CSSProperties = { fontSize: 12, color: "#6b7280", display: "block", marginBottom: 3 };
  const secRow = (label: string, collapseKey?: keyof typeof collapsed, extra?: React.ReactNode): React.ReactNode => (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", margin: "18px 0 8px" }}>
      <p style={sH}>{label}</p>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        {extra}
        {collapseKey && (
          <button type="button" onClick={() => toggleSection(collapseKey)}
            style={{ fontSize: 12, color: "#6b7280", background: "none", border: "1px solid #e5e7eb", borderRadius: 6, cursor: "pointer", padding: "2px 10px", display: "flex", alignItems: "center", gap: 4 }}>
            <span style={{ fontSize: 10 }}>{collapsed[collapseKey] ? "▶" : "▼"}</span>
            {collapsed[collapseKey] ? "펼치기" : "접기"}
          </button>
        )}
      </div>
    </div>
  );
  const handleReinvite = async () => {
    setReinviting(true);
    try {
      const res = await fetch(api(`/api/admin/translators/${userId}/reinvite`), { method: "POST", headers: authH });
      const data = await res.json();
      if (!res.ok) { onToast(`오류: ${data.error}`); return; }
      const inviteUrl = `${window.location.origin}/set-password?token=${data.inviteToken}`;
      await navigator.clipboard.writeText(inviteUrl);
      onToast("새 초대 링크가 생성되어 클립보드에 복사되었습니다.");
      setUserInfo(prev => prev ? { ...prev, invitePending: true } : prev);
    } catch { onToast("오류: 초대 링크 재생성 실패"); }
    finally { setReinviting(false); }
  };

  const handleActivate = async () => {
    if (!confirm("이 통번역사를 다시 활성화하시겠습니까?")) return;
    setActivating(true);
    try {
      const res = await fetch(api(`/api/admin/translators/${userId}/activate`), {
        method: "PATCH", headers: authH,
      });
      const data = await res.json();
      if (!res.ok) {
        onToast(data.error ?? "활성화 중 오류가 발생했습니다.");
        return;
      }
      onToast("통번역사가 활성화되었습니다.");
      setUserInfo(prev => prev ? { ...prev, isActive: true } : prev);
      setForm(prev => ({ ...prev, availabilityStatus: "available" }));
      onDeleted?.(); // 목록 새로고침
    } catch (err) {
      console.error("[PATCH /activate] 예외:", err);
      onToast("오류가 발생했습니다. 관리자에게 문의하세요.");
    } finally {
      setActivating(false);
    }
  };

  const handlePermanentDelete = async () => {
    const ok = confirm(
      "⚠️ 이 작업은 되돌릴 수 없습니다.\n\n" +
      "테스트 데이터인 경우에만 완전삭제하세요.\n\n" +
      "정말 완전삭제하시겠습니까?"
    );
    if (!ok) return;
    setPermanentDeleting(true);
    setPermanentDeleteError(null);
    try {
      const res = await fetch(api(`/api/admin/translators/${userId}/permanent`), {
        method: "DELETE", headers: authH,
      });
      const data = await res.json();
      if (!res.ok) {
        setPermanentDeleteError(data.error ?? "완전삭제 중 오류가 발생했습니다.");
        return;
      }
      onToast("통번역사가 완전삭제되었습니다.");
      onClose();
      onDeleted?.();
    } catch (err) {
      console.error("[DELETE /permanent] 예외:", err);
      setPermanentDeleteError("오류가 발생했습니다. 관리자에게 문의하세요.");
    } finally {
      setPermanentDeleting(false);
    }
  };

  const handleDeleteTranslator = async () => {
    if (!confirm("이 통번역사를 비활성 처리하시겠습니까?\n기존 단가, 정산, 작업 데이터는 보존됩니다.")) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      const res = await fetch(api(`/api/admin/translators/${userId}`), {
        method: "DELETE", headers: authH,
      });
      const data = await res.json();
      if (!res.ok) {
        const msg = data.error ?? "비활성 처리 중 오류가 발생했습니다. 관리자에게 문의하세요.";
        console.error("[DELETE /admin/translators]", res.status, data);
        setDeleteError(msg);
        return;
      }
      onToast("통번역사가 비활성 처리되었습니다.");
      onDeleted?.();
      onClose();
    } catch (err) {
      console.error("[DELETE /admin/translators] 예외:", err);
      setDeleteError("오류가 발생했습니다. 관리자에게 문의하세요.");
    } finally {
      setDeleting(false);
    }
  };

  return (
    <>
    <DraggableModal title="통번역사 상세" onClose={onClose} width={860} height="88vh" zIndex={300} bodyPadding="20px 28px" resizable
      headerExtra={
        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 4 }}>
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <button onClick={handleSave} disabled={saving}
              style={{ fontSize: 12, padding: "4px 14px", background: saving ? "#a5b4fc" : "#6366f1", color: "#fff", border: "none", borderRadius: 6, cursor: saving ? "not-allowed" : "pointer", fontWeight: 700 }}>
              {saving ? "저장 중…" : "프로필 저장"}
            </button>
            {userInfo?.isActive === false ? (
              <button onClick={handleActivate} disabled={activating || permanentDeleting}
                style={{ fontSize: 11, padding: "3px 10px", background: "#d1fae5", color: "#065f46", border: "1px solid #6ee7b7", borderRadius: 6, cursor: "pointer", fontWeight: 700 }}>
                {activating ? "처리 중…" : "활성화"}
              </button>
            ) : (
              <button onClick={() => handleDeleteTranslator()} disabled={deleting || permanentDeleting}
                style={{ fontSize: 11, padding: "3px 10px", background: "#fee2e2", color: "#dc2626", border: "1px solid #fca5a5", borderRadius: 6, cursor: "pointer", fontWeight: 600 }}>
                {deleting ? "처리 중…" : "비활성 처리"}
              </button>
            )}
            <button onClick={handlePermanentDelete} disabled={permanentDeleting || deleting || activating}
              style={{ fontSize: 11, padding: "3px 10px", background: "#7f1d1d", color: "#fff", border: "1px solid #991b1b", borderRadius: 6, cursor: "pointer", fontWeight: 700, opacity: (permanentDeleting || deleting || activating) ? 0.6 : 1 }}>
              {permanentDeleting ? "삭제 중…" : "완전삭제"}
            </button>
          </div>
          {(deleteError || permanentDeleteError) && (
            <div style={{ fontSize: 11, color: "#dc2626", maxWidth: 300, textAlign: "right", lineHeight: 1.4 }}>
              {permanentDeleteError ?? deleteError}
            </div>
          )}
          {userInfo?.isActive === false && (
            <span style={{ fontSize: 10, color: "#9ca3af", background: "#f3f4f6", borderRadius: 4, padding: "1px 6px" }}>
              비활성 상태
            </span>
          )}
        </div>
      }
    >
      {loading ? <p style={{ color: "#9ca3af", textAlign: "center", padding: "32px 0" }}>불러오는 중...</p> : (
        <>
          {/* ═══════════════════════════════════════════
              1. 프로필 요약 카드 (읽기 전용)
          ═══════════════════════════════════════════ */}
          <div style={{
            background: "#f0f9ff",
            border: "1px solid #bae6fd",
            borderRadius: 12,
            padding: "14px 18px",
            marginBottom: 18,
            marginTop: 12,
            display: "flex",
            flexWrap: "wrap",
            gap: "8px 20px",
            alignItems: "center",
          }}>
            <span style={{ fontSize: 17, fontWeight: 700, color: "#0c4a6e" }}>
              {form.name || userInfo?.name || "—"}
            </span>
            {form.languagePairs && (
              <div style={{ display: "flex", flexWrap: "wrap", gap: 3, alignItems: "center" }}>
                {normalizeLanguages(form.languagePairs).split(",").map(s => s.trim()).filter(Boolean).map((lang, i) => (
                  <span key={i} style={{ fontSize: 12, background: "#e0f2fe", color: "#0369a1", borderRadius: 20, padding: "2px 8px", fontWeight: 600 }}>
                    {lang}
                  </span>
                ))}
              </div>
            )}
            {pinnedSubTypes.size > 0 && (
              <div style={{ display: "flex", gap: 3, alignItems: "center" }}>
                {[...pinnedSubTypes].map(st => (
                  <span key={st} style={{ fontSize: 12, background: "#ecfdf5", color: "#065f46", borderRadius: 20, padding: "2px 8px", fontWeight: 700, border: "1px solid #a7f3d0" }}>
                    ★ {st}
                  </span>
                ))}
              </div>
            )}
            {form.specializations && (() => {
              const specs = form.specializations.split(",").map(s => s.trim()).filter(Boolean);
              if (specs.length === 0) return null;
              const visible = specs.slice(0, 3);
              const hiddenCount = specs.length - visible.length;
              return (
                <span style={{ fontSize: 12, color: "#92400e", fontWeight: 600, background: "#fef3c7", borderRadius: 6, padding: "2px 8px", display: "inline-flex", alignItems: "center", gap: 3 }}>
                  🏷 {visible.join(" · ")}
                  {hiddenCount > 0 && <span style={{ color: "#9ca3af", fontWeight: 400, fontSize: 11 }}>+{hiddenCount}</span>}
                </span>
              );
            })()}
            {form.rating && (
              <span style={{ fontSize: 13, fontWeight: 700, color: "#d97706" }}>★ {form.rating}</span>
            )}
            {form.grade && (
              <span style={{ fontSize: 12, background: "#fef3c7", color: "#92400e", borderRadius: 20, padding: "2px 9px", fontWeight: 700 }}>
                {form.grade}등급
              </span>
            )}
            <span style={{
              fontSize: 12, borderRadius: 20, padding: "2px 9px", fontWeight: 700,
              background: userInfo?.isActive === false ? "#f3f4f6" : form.availabilityStatus === "available" ? "#d1fae5" : form.availabilityStatus === "busy" ? "#fef3c7" : "#fee2e2",
              color: userInfo?.isActive === false ? "#9ca3af" : form.availabilityStatus === "available" ? "#065f46" : form.availabilityStatus === "busy" ? "#92400e" : "#991b1b",
            }}>
              {userInfo?.isActive === false ? "불가" : form.availabilityStatus === "available" ? "가능" : form.availabilityStatus === "busy" ? "바쁨" : "불가"}
            </span>
            {userInfo?.isActive === false ? (
              <span style={{ fontSize: 12, borderRadius: 20, padding: "2px 9px", fontWeight: 700, background: "#f3f4f6", color: "#9ca3af", border: "1px solid #e5e7eb" }}>
                비활성
              </span>
            ) : form.operationalStatus && form.operationalStatus !== "normal" && (
              <span style={{
                fontSize: 12, borderRadius: 20, padding: "2px 9px", fontWeight: 700,
                background: form.operationalStatus === "warning" ? "#fefce8" : form.operationalStatus === "hold" ? "#f0f9ff" : "#fef2f2",
                color: form.operationalStatus === "warning" ? "#854d0e" : form.operationalStatus === "hold" ? "#075985" : "#991b1b",
                border: `1px solid ${form.operationalStatus === "warning" ? "#fde047" : form.operationalStatus === "hold" ? "#bae6fd" : "#fca5a5"}`,
              }}>
                {form.operationalStatus === "warning" ? "⚠️ 주의" : form.operationalStatus === "hold" ? "⏸ 보류" : "🚫 제외"}
              </span>
            )}
            {!form.reassignmentAllowed && (
              <span style={{ fontSize: 12, background: "#fee2e2", color: "#991b1b", borderRadius: 20, padding: "2px 9px", fontWeight: 700, border: "1px solid #fca5a5" }}>
                재배정 불가
              </span>
            )}
            {form.settlementType && (() => {
              const st = SETTLEMENT_TYPES.find(s => s.value === form.settlementType);
              return (
                <span style={{
                  fontSize: 12, borderRadius: 20, padding: "2px 9px", fontWeight: 700,
                  background: st?.bg ?? "#f3f4f6", color: st?.color ?? "#374151",
                  border: `1px solid ${st?.border ?? "#d1d5db"}`,
                }}>
                  💳 {st?.label ?? form.settlementType}
                </span>
              );
            })()}
            {/* 핵심정보 요약 — 두 번째 줄 (있을 때만) */}
            {(form.education || form.major || pinnedSubTypes.size > 0 || form.specializations || form.bio) && (
              <div style={{ width: "100%", display: "flex", gap: "4px 14px", flexWrap: "wrap", borderTop: "1px solid #bae6fd", paddingTop: 6, marginTop: 2, alignItems: "center" }}>
                {form.education && (
                  <span style={{ fontSize: 11, color: "#0369a1" }}>🎓 {form.education}</span>
                )}
                {form.major && (
                  <span style={{ fontSize: 11, color: "#0369a1" }}>📚 {form.major}</span>
                )}
                {form.graduationStatus && (() => {
                  const displayStatus = form.graduationStatus === "졸업예정" && form.graduationYear && Number(form.graduationYear) < _CURRENT_YEAR
                    ? "졸업" : form.graduationStatus;
                  return (
                    <span style={{ fontSize: 11, color: "#6b7280" }}>
                      🎓 {displayStatus}{form.graduationYear ? ` ${form.graduationYear}` : ""}
                    </span>
                  );
                })()}
                {pinnedSubTypes.size > 0 && (
                  <span style={{ fontSize: 11, color: "#065f46", fontWeight: 600 }}>
                    ⭐ {[...pinnedSubTypes].join(" / ")}
                  </span>
                )}
                {form.bio && (
                  <span style={{ fontSize: 11, color: "#374151", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "100%" }}>
                    ✎ {form.bio.length > 60 ? form.bio.slice(0, 60) + "…" : form.bio}
                  </span>
                )}
              </div>
            )}
          </div>

          {/* ═══════════════════════════════════════════
              2. 기본 정보
          ═══════════════════════════════════════════ */}
          {secRow("기본 정보", undefined,
            userInfo?.invitePending ? (
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span style={{ display: "inline-flex", alignItems: "center", gap: 4, background: "#fef3c7", color: "#92400e", borderRadius: 20, padding: "2px 8px", fontSize: 11, fontWeight: 700 }}>⏳ 초대 대기</span>
                <button onClick={handleReinvite} disabled={reinviting}
                  style={{ fontSize: 11, padding: "2px 8px", borderRadius: 6, border: "1px solid #d1d5db", background: "#f9fafb", color: "#374151", cursor: reinviting ? "not-allowed" : "pointer", fontWeight: 600 }}>
                  {reinviting ? "처리 중..." : "🔗 링크 재발급"}
                </button>
              </div>
            ) : (
              <span style={{ display: "inline-flex", alignItems: "center", gap: 4, background: "#d1fae5", color: "#065f46", borderRadius: 20, padding: "2px 8px", fontSize: 11, fontWeight: 700 }}>✓ 계정 활성</span>
            )
          )}
          <div style={{ background: "#f9fafb", borderRadius: 10, border: "1px solid #f3f4f6", padding: "14px 16px", marginBottom: 4 }}>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px 20px" }}>
              {/* 이름 + 휴대폰 같은 줄 */}
              <div>
                <label style={{ ...labelSt, fontSize: 11 }}>이름</label>
                <input type="text" value={form.name} onChange={e => setForm(p => ({ ...p, name: e.target.value }))}
                  placeholder="이름 입력" style={{ ...inputStyle, fontSize: 13, padding: "7px 10px" }} />
              </div>
              <div>
                <label style={{ ...labelSt, fontSize: 11 }}>휴대폰번호</label>
                <input type="tel" value={form.phone} onChange={e => setForm(p => ({ ...p, phone: formatPhoneNumber(e.target.value) }))}
                  placeholder="010-0000-0000" style={{ ...inputStyle, fontSize: 13, padding: "7px 10px" }} />
              </div>
              {/* 이메일 — 인라인 +/- 버튼, 별도 추가줄 없음 */}
              <div style={{ gridColumn: "1 / -1" }}>
                <label style={{ ...labelSt, fontSize: 11 }}>
                  이메일 <span style={{ color: "#9ca3af", fontWeight: 400 }}>(대표 이메일은 로그인에 사용됨)</span>
                </label>
                <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                  {emailEntries.map((entry, i) => (
                    <div key={i}>
                      <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
                        <input type="email" value={entry.email}
                          onChange={e => setEmailEntries(p => p.map((x, idx) => idx === i ? { ...x, email: e.target.value, error: "" } : x))}
                          placeholder="이메일 주소"
                          style={{ ...inputStyle, fontSize: 13, padding: "6px 10px", flex: 1, borderColor: entry.error ? "#dc2626" : "#d1d5db" }}
                        />
                        {entry.isPrimary ? (
                          <span style={{ fontSize: 11, fontWeight: 700, padding: "4px 8px", borderRadius: 6, background: "#dbeafe", color: "#1d4ed8", whiteSpace: "nowrap", border: "1px solid #bfdbfe" }}>★ 대표</span>
                        ) : (
                          <button onClick={() => setEmailEntries(p => {
                              const sel = { ...p[i], isPrimary: true };
                              const rest = p.filter((_, idx) => idx !== i).map(x => ({ ...x, isPrimary: false }));
                              return [sel, ...rest];
                            })}
                            style={{ fontSize: 11, padding: "4px 8px", borderRadius: 6, border: "1px solid #d1d5db", background: "#f9fafb", color: "#374151", cursor: "pointer", whiteSpace: "nowrap" }}>
                            대표 지정
                          </button>
                        )}
                        <button onClick={() => setEmailEntries(p => [...p, { email: "", isPrimary: false, error: "" }])}
                          style={{ fontSize: 14, fontWeight: 700, padding: "2px 8px", borderRadius: 6, border: "1px solid #d1d5db", background: "#f9fafb", color: "#374151", cursor: "pointer", lineHeight: 1.4 }}
                          title="이메일 추가">+</button>
                        <button disabled={entry.isPrimary && emailEntries.length === 1}
                          onClick={() => {
                            const next = emailEntries.filter((_, idx) => idx !== i);
                            if (entry.isPrimary && next.length > 0) next[0].isPrimary = true;
                            setEmailEntries(next);
                          }}
                          style={{ fontSize: 14, fontWeight: 700, padding: "2px 8px", borderRadius: 6, border: "1px solid #fca5a5", background: "none", lineHeight: 1.4,
                            color: (entry.isPrimary && emailEntries.length === 1) ? "#d1d5db" : "#dc2626",
                            cursor: (entry.isPrimary && emailEntries.length === 1) ? "not-allowed" : "pointer" }}
                          title="이메일 삭제">−</button>
                      </div>
                      {entry.error && <p style={{ color: "#dc2626", fontSize: 11, margin: "3px 0 0" }}>{entry.error}</p>}
                    </div>
                  ))}
                </div>
              </div>
              {/* 학력 · 전공 · 졸업상태 · 졸업/예정년도 */}
              <div style={{ gridColumn: "1 / -1" }}>
                <div style={{ display: "grid", gridTemplateColumns: "35fr 25fr 20fr 20fr", gap: "0 16px" }}>
                  {/* 학력 */}
                  <div>
                    <label style={{ ...labelSt, fontSize: 11 }}>학력</label>
                    <ClickSelect
                      value={eduIsCustom ? "__custom__" : form.education}
                      onChange={v => {
                        if (v === "__custom__") { setEduIsCustom(true); setForm(p => ({ ...p, education: eduCustom })); }
                        else { setEduIsCustom(false); setEduCustom(""); setForm(p => ({ ...p, education: v })); }
                      }}
                      style={{ width: "100%" }}
                      triggerStyle={{ width: "100%", fontSize: 13, padding: "7px 10px", borderRadius: 8 }}
                      searchable
                      options={[
                        { value: "", label: "선택 안 함" },
                        { value: "§국내§", label: "── 국내 ──", disabled: true },
                        ...EDUCATION_DOMESTIC.map(s => ({ value: s, label: s })),
                        { value: "§해외§", label: "── 해외 ──", disabled: true },
                        ...EDUCATION_OVERSEAS.map(s => ({ value: s, label: s })),
                        { value: "__custom__", label: "기타(직접 입력)" },
                      ]}
                    />
                    {eduIsCustom && (
                      <input type="text" value={eduCustom}
                        onChange={e => { setEduCustom(e.target.value); setForm(p => ({ ...p, education: e.target.value })); }}
                        placeholder="직접 입력"
                        style={{ ...inputStyle, fontSize: 13, padding: "7px 10px", marginTop: 4 }} />
                    )}
                  </div>
                  {/* 전공 */}
                  <div>
                    <label style={{ ...labelSt, fontSize: 11 }}>전공</label>
                    <ClickSelect
                      value={majorIsCustom ? "__custom__" : form.major}
                      onChange={v => {
                        if (v === "__custom__") { setMajorIsCustom(true); setForm(p => ({ ...p, major: majorCustom })); }
                        else { setMajorIsCustom(false); setMajorCustom(""); setForm(p => ({ ...p, major: v })); }
                      }}
                      style={{ width: "100%" }}
                      triggerStyle={{ width: "100%", fontSize: 13, padding: "7px 10px", borderRadius: 8 }}
                      options={[
                        { value: "", label: "선택 안 함" },
                        { value: "§언어§", label: "── 언어계열 ──", disabled: true },
                        ...MAJOR_LANGUAGE.map(s => ({ value: s, label: s })),
                        { value: "§통대§", label: "── 통대계열 ──", disabled: true },
                        ...MAJOR_INTERPRETATION.map(s => ({ value: s, label: s })),
                        { value: "§전문§", label: "── 전문분야계열 ──", disabled: true },
                        ...MAJOR_SPECIALIZED.map(s => ({ value: s, label: s })),
                        { value: "__custom__", label: "기타(직접 입력)" },
                      ]}
                    />
                    {majorIsCustom && (
                      <input type="text" value={majorCustom}
                        onChange={e => { setMajorCustom(e.target.value); setForm(p => ({ ...p, major: e.target.value })); }}
                        placeholder="직접 입력"
                        style={{ ...inputStyle, fontSize: 13, padding: "7px 10px", marginTop: 4 }} />
                    )}
                  </div>
                  {/* 졸업상태 */}
                  <div>
                    <label style={{ ...labelSt, fontSize: 11 }}>졸업상태</label>
                    <ClickSelect
                      value={form.graduationStatus}
                      onChange={v => setForm(p => ({ ...p, graduationStatus: v }))}
                      style={{ width: "100%" }}
                      triggerStyle={{ width: "100%", fontSize: 13, padding: "7px 10px", borderRadius: 8 }}
                      options={[
                        { value: "", label: "선택 안 함" },
                        ...GRADUATION_STATUS_OPTIONS.map(s => ({ value: s, label: s })),
                      ]}
                    />
                    {/* 자동감지: 졸업예정 + 과거년도 → 졸업으로 표시 (DB 값은 변경 안 함) */}
                    {form.graduationStatus === "졸업예정" && form.graduationYear && Number(form.graduationYear) < _CURRENT_YEAR && (
                      <span style={{ fontSize: 10, color: "#059669", display: "block", marginTop: 3, fontWeight: 600 }}>
                        ✓ 졸업 (자동감지)
                      </span>
                    )}
                  </div>
                  {/* 졸업/예정년도 */}
                  <div>
                    <label style={{ ...labelSt, fontSize: 11 }}>졸업/예정년도</label>
                    <ClickSelect
                      value={form.graduationYear}
                      onChange={v => setForm(p => ({ ...p, graduationYear: v }))}
                      style={{ width: "100%" }}
                      triggerStyle={{ width: "100%", fontSize: 13, padding: "7px 10px", borderRadius: 8 }}
                      searchable
                      options={[
                        { value: "", label: "선택 안 함" },
                        ...GRAD_YEARS.map(y => ({ value: y, label: y })),
                      ]}
                    />
                  </div>
                </div>
              </div>
              {/* 언어레벨 | 거주국가 | 거주지역/도시 — 3컬럼 한 줄 */}
              <div style={{ gridColumn: "1 / -1", display: "grid", gridTemplateColumns: "1fr 1fr 2fr", gap: "0 16px", alignItems: "start" }}>
                <div>
                  <label style={{ ...labelSt, fontSize: 11 }}>언어 레벨</label>
                  <ClickSelect value={form.languageLevel} onChange={v => setForm(p => ({ ...p, languageLevel: v }))}
                    style={{ width: "100%" }} triggerStyle={{ width: "100%", fontSize: 13, padding: "7px 10px", borderRadius: 8 }}
                    options={[{ value: "", label: "선택 안 함" }, ...LANG_LEVEL_OPTIONS.map(l => ({ value: l, label: l }))]} />
                </div>
                <div>
                  <label style={{ ...labelSt, fontSize: 11 }}>거주국가</label>
                  <ClickSelect
                    value={regionCountry}
                    onChange={c => {
                      setRegionCountry(c);
                      if (c !== "기타") setRegionCountryCustom("");
                      setForm(p => ({ ...p, region: buildRegionString(c, c === "기타" ? "" : "", regionCity) }));
                    }}
                    style={{ width: "100%" }}
                    triggerStyle={{ width: "100%", fontSize: 13, padding: "7px 10px", borderRadius: 8 }}
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
                      style={{ ...inputStyle, fontSize: 12, padding: "6px 10px", marginTop: 4 }} />
                  )}
                </div>
                <div>
                  <label style={{ ...labelSt, fontSize: 11 }}>거주지역/도시</label>
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
              <div>
                <label style={{ ...labelSt, fontSize: 11 }}>소속업체</label>
                <ClickSelect
                  value={form.affiliatedCompanyId}
                  onChange={v => setForm(p => ({ ...p, affiliatedCompanyId: v }))}
                  style={{ width: "100%" }}
                  triggerStyle={{ width: "100%", fontSize: 13, padding: "7px 10px", borderRadius: 8 }}
                  searchable
                  options={[
                    { value: "", label: "소속 없음 (프리랜서)" },
                    ...vendorCompanies.map(c => ({ value: String(c.id), label: c.name })),
                  ]}
                />
              </div>
              {/* 상세정보 */}
              <div style={{ gridColumn: "1 / -1" }}>
                <label style={{ ...labelSt, fontSize: 11 }}>상세정보</label>
                <input type="text" value={form.bio} onChange={e => setForm(p => ({ ...p, bio: e.target.value }))}
                  placeholder="예: 10년 이상의 전문 통역·번역 경력"
                  style={{ ...inputStyle, fontSize: 13, padding: "7px 10px" }} />
              </div>
            </div>
          </div>

          {/* ═══════════════════════════════════════════
              3. 전문 정보
          ═══════════════════════════════════════════ */}
          {secRow("전문 정보")}
          <div style={{ background: "#f9fafb", borderRadius: 10, border: "1px solid #f3f4f6", padding: "14px 16px", marginBottom: 16 }}>
            {/* 가능언어 */}
            <div style={{ marginBottom: 10 }}>
              <label style={{ ...labelSt, fontSize: 11 }}>가능언어 <span style={{ color: "#9ca3af", fontWeight: 400 }}>(수정 가능)</span></label>
              <input
                type="text"
                value={form.languagePairs}
                onChange={e => setForm(p => ({ ...p, languagePairs: e.target.value }))}
                placeholder="예: 한국어, 영어, 일본어"
                style={{ ...inputStyle, fontSize: 13, padding: "7px 10px" }}
              />
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
            {/* 세부유형 — 대표(pinned) 중심 UI: 기본은 pinned만 노출, 클릭 시 전체 펼침 */}
            {(() => {
              const selectedTypes = form.profileWorkTypes.split(",").map(s => s.trim()).filter(Boolean);
              const allSubs = Array.from(new Set(
                selectedTypes.flatMap(wt => PROFILE_SUB_TYPES_MAP[wt] ?? [])
              ));
              if (allSubs.length === 0) return null;
              const selectedSubSet = new Set(form.profileSubTypes.split(",").map(s => s.trim()).filter(Boolean));
              const sortedSubs = [
                ...allSubs.filter(s => pinnedSubTypes.has(s)),
                ...allSubs.filter(s => selectedSubSet.has(s) && !pinnedSubTypes.has(s)),
                ...allSubs.filter(s => !selectedSubSet.has(s)),
              ];
              // 기본: pinned만 표시. pinned 없으면 selected 최대 3개
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
                      <span style={{ fontSize: 10, color: "#9ca3af", fontWeight: 400, marginLeft: 6 }}>
                        ☆ 클릭으로 대표 지정 (최대 2개)
                      </span>
                    </label>
                    {(hiddenCount > 0 || showAllSubTypes) && (
                      <button type="button" onClick={() => setShowAllSubTypes(prev => !prev)}
                        style={{ fontSize: 11, color: "#6366f1", background: "none", border: "1px solid #e0e7ff", borderRadius: 6, cursor: "pointer", padding: "2px 8px", whiteSpace: "nowrap" }}>
                        {showAllSubTypes ? "접기" : `추가 ${hiddenCount}개 보기`}
                      </button>
                    )}
                  </div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                    {visibleSubs.map(st => {
                      const selected = selectedSubSet.has(st);
                      const isPinned = pinnedSubTypes.has(st);
                      const isBlockedForGraduate = !selected && st === "일반번역" && !!form.education && isGraduateInterpreterEducation(form.education);
                      return (
                        <span key={st} style={{ display: "inline-flex", alignItems: "center", gap: 2 }}>
                          <button type="button"
                            title={isBlockedForGraduate ? "통번역대학원 출신 전문 통번역사는 일반번역으로 분류하지 않습니다. 전문번역을 선택해 주세요." : undefined}
                            onClick={() => {
                              if (isBlockedForGraduate) {
                                alert("통번역대학원 출신 전문 통번역사는 일반번역으로 분류하지 않습니다.\n전문번역을 선택해 주세요.");
                                return;
                              }
                              const cur = form.profileSubTypes.split(",").map(s => s.trim()).filter(Boolean);
                              const next = selected ? cur.filter(s => s !== st) : [...cur, st];
                              if (selected && pinnedSubTypes.has(st)) {
                                setPinnedSubTypes(prev => { const n = new Set(prev); n.delete(st); return n; });
                              }
                              setForm(p => ({ ...p, profileSubTypes: next.join(",") }));
                            }}
                            style={{
                              padding: "2px 7px", borderRadius: 20, fontSize: 10, cursor: isBlockedForGraduate ? "not-allowed" : "pointer",
                              background: isBlockedForGraduate ? "#fef2f2" : isPinned ? "#065f46" : selected ? "#059669" : "#f0fdf4",
                              color: isBlockedForGraduate ? "#fca5a5" : selected ? "#fff" : "#065f46",
                              border: `1px solid ${isBlockedForGraduate ? "#fca5a5" : isPinned ? "#065f46" : selected ? "#059669" : "#a7f3d0"}`,
                              fontWeight: selected ? 700 : 400,
                              opacity: isBlockedForGraduate ? 0.6 : 1,
                            }}>
                            {isPinned && <span style={{ marginRight: 2, fontSize: 9 }}>★</span>}{st}
                          </button>
                          {selected && (
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

              // 선택된 프리셋 우선 표시, 그 다음 미선택 순서
              const sortedPresets = [
                ...allPresets.filter(t => selected.has(t)),
                ...allPresets.filter(t => !selected.has(t)),
              ];
              const visiblePresets = showAllSpecs ? sortedPresets : sortedPresets.slice(0, SPEC_FIRST_ROW);
              // 숨겨진 수 = 나머지 프리셋 + 기타 버튼 (접힌 상태에서만)
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
                } else {
                  setShowOtherSpec(true);
                }
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
                      style={{ fontSize: 11, color: "#6366f1", background: "none", border: "1px solid #e0e7ff", borderRadius: 6, cursor: "pointer", padding: "2px 8px", whiteSpace: "nowrap" }}>
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
                    <input
                      type="text"
                      value={customVals.join(", ")}
                      onChange={e => handleCustomChange(e.target.value)}
                      placeholder="예: 게임, 방산전자, 우주항공, 환경"
                      style={{ ...inputStyle, fontSize: 13, padding: "7px 10px", marginTop: 6 }}
                    />
                  )}
                </div>
              );
            })()}
          </div>

          {/* ═══ 4. 언어·국제경험 ═══ */}
          {secRow("언어·국제경험")}
          <div style={{ background: "#f9fafb", borderRadius: 10, border: "1px solid #f3f4f6", padding: "14px 16px", marginBottom: 16 }}>
            <TranslatorLangExpSection entries={langExperiences} onChange={setLangExperiences} />
          </div>

          {/* ═══ 5. 이력서&증빙서류 (기본 접힘) ═══ */}
          {secRow("이력서&증빙서류", "resume")}
          {!collapsed.resume && (
          <div style={{ background: "#f9fafb", borderRadius: 10, border: "1px solid #f3f4f6", padding: "14px 16px", marginBottom: 10 }}>

            {/* ── 서류 유형 탭 ── */}
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

            {/* ── ① 이력서 ── */}
            {docSubTab === "resume" && (
            <div style={{ marginBottom: 12 }}>
              <label style={labelSt}>이력서 파일</label>
              {profile?.resumeUrl ? (
                <div style={{
                  display: "flex", alignItems: "center", gap: 8,
                  padding: "8px 12px", marginBottom: 8,
                  background: "#f0fdf4", borderRadius: 8, border: "1px solid #a7f3d0",
                }}>
                  <span style={{ fontSize: 16, flexShrink: 0 }}>📄</span>
                  <span
                    title={getResumeDisplayName(profile.resumeUrl, resumeFileName)}
                    style={{
                      fontSize: 12, color: "#065f46", fontWeight: 600,
                      flex: 1, overflow: "hidden", textOverflow: "ellipsis",
                      whiteSpace: "nowrap", minWidth: 0,
                    }}
                  >
                    {getResumeDisplayName(profile.resumeUrl, resumeFileName)}
                  </span>
                  <div style={{ display: "flex", gap: 4, flexShrink: 0 }}>
                    {canPreviewResume(getResumeExt(profile.resumeUrl)) && (
                      <button
                        type="button"
                        disabled={resumeUploading || resumeDeleting}
                        aria-label="이력서 미리보기"
                        onClick={async () => {
                          const ext = getResumeExt(profile.resumeUrl);
                          if (ext === ".pdf") {
                            // PDF: 프록시 URL로 pdf.js 썸네일 + 새 탭 열기
                            const proxyUrl =
                              api(`/api/admin/translators/${userId}/resume-download?inline=true`) +
                              `&token=${encodeURIComponent(token)}`;
                            setResumePreview({
                              url: proxyUrl,
                              fileName: getResumeDisplayName(profile.resumeUrl, resumeFileName),
                            });
                          } else {
                            // 기타 (txt 등): GCS URL로 새 탭 열기
                            try {
                              const r = await fetch(api(`/api/admin/translators/${userId}/resume-url`), { headers: authH });
                              const d = await r.json();
                              if (!r.ok) { onToast(`오류: ${d.error}`); return; }
                              if (!d.downloadUrl) { onToast("미리보기 URL을 가져올 수 없습니다."); return; }
                              window.open(d.downloadUrl, "_blank", "noopener,noreferrer");
                            } catch {
                              onToast("오류: URL 생성 실패");
                            }
                          }
                        }}
                        style={{ fontSize: 11, padding: "3px 8px", borderRadius: 5, border: "1px solid #d1d5db", background: "#fff", cursor: "pointer", color: "#374151", whiteSpace: "nowrap" }}>
                        미리보기
                      </button>
                    )}
                    <button
                      type="button"
                      disabled={resumeUploading || resumeDeleting}
                      aria-label="이력서 다운로드"
                      onClick={() => {
                        const a = document.createElement("a");
                        a.href = api(`/api/admin/translators/${userId}/resume-download`) + `?token=${encodeURIComponent(token)}`;
                        a.style.display = "none";
                        document.body.appendChild(a);
                        a.click();
                        document.body.removeChild(a);
                      }}
                      style={{ fontSize: 11, padding: "3px 8px", borderRadius: 5, border: "1px solid #d1d5db", background: "#fff", cursor: "pointer", color: "#374151", whiteSpace: "nowrap" }}>
                      다운로드
                    </button>
                    <button
                      type="button"
                      disabled={resumeDeleting || resumeUploading}
                      aria-label="이력서 삭제"
                      onClick={async () => {
                        if (!window.confirm("이력서를 삭제하시겠습니까?")) return;
                        setResumeDeleting(true);
                        try {
                          const r = await fetch(api(`/api/admin/translators/${userId}/resume`), { method: "DELETE", headers: authH });
                          if (r.ok) {
                            setProfile(p => p ? { ...p, resumeUrl: null } : p);
                            setResumeFileName(null);
                            onToast("이력서가 삭제되었습니다.");
                          } else { const d = await r.json(); onToast(`오류: ${d.error}`); }
                        } catch { onToast("오류: 이력서 삭제 실패"); }
                        finally { setResumeDeleting(false); }
                      }}
                      style={{ fontSize: 11, padding: "3px 8px", borderRadius: 5, border: "1px solid #fca5a5", background: "#fff5f5", cursor: "pointer", color: "#b91c1c", whiteSpace: "nowrap" }}>
                      {resumeDeleting ? "삭제 중..." : "삭제"}
                    </button>
                    <button
                      type="button"
                      onClick={() => setShowAnalyzePanel(true)}
                      aria-label="AI 이력서 분석"
                      data-testid="btn-open-analyze"
                      style={{ fontSize: 11, padding: "3px 8px", borderRadius: 5, border: "1px solid #059669", background: "#f0fdf4", cursor: "pointer", color: "#065f46", fontWeight: 600, whiteSpace: "nowrap" }}>
                      ✨ AI 분석
                    </button>
                  </div>
                </div>
              ) : (
                <p style={{ fontSize: 12, color: "#9ca3af", margin: "0 0 6px" }}>이력서 없음 — 아래에서 업로드해 주세요.</p>
              )}
              <div
                onDragOver={e => { e.preventDefault(); setDragOver(true); }}
                onDragLeave={() => setDragOver(false)}
                onDrop={e => {
                  e.preventDefault();
                  setDragOver(false);
                  const file = e.dataTransfer.files?.[0];
                  if (file) handleResumeUpload(file);
                }}
                style={{
                  border: `2px dashed ${dragOver ? "#059669" : "#d1d5db"}`,
                  borderRadius: 8,
                  padding: "10px 14px",
                  background: dragOver ? "#f0fdf4" : "#f9fafb",
                  transition: "border-color 0.15s, background 0.15s",
                  textAlign: "center" as const,
                  opacity: resumeUploading ? 0.6 : 1,
                  pointerEvents: resumeUploading ? "none" : "auto",
                }}
              >
                <p style={{ fontSize: 11, color: dragOver ? "#059669" : "#9ca3af", margin: "0 0 8px", fontWeight: dragOver ? 600 : 400 }}>
                  {resumeUploading ? "업로드 중..." : dragOver ? "여기에 파일을 놓으세요" : `파일을 드래그하거나 아래 버튼으로 선택 (${RESUME_HINT})`}
                </p>
                <label
                  style={{ fontSize: 12, padding: "5px 12px", borderRadius: 6, border: "1px solid #d1d5db", background: "#fff", cursor: resumeUploading ? "not-allowed" : "pointer", color: "#374151", display: "inline-block" }}
                  aria-label="파일 선택"
                >
                  {resumeUploading ? "업로드 중..." : "파일 선택"}
                  <input
                    type="file"
                    accept={RESUME_ACCEPT}
                    disabled={resumeUploading}
                    onChange={e => {
                      const file = e.target.files?.[0];
                      e.target.value = "";
                      if (file) handleResumeUpload(file);
                    }}
                    style={{ display: "none" }}
                  />
                </label>
              </div>
            </div>
            )} {/* docSubTab === "resume" */}

            {/* ── ② 신분증 ── */}
            {docSubTab === "id" && (
            <div>
              <label style={labelSt}>신분증 파일</label>
              <TranslatorEvidenceDocumentsSection
                docType="id_card"
                mode="detail"
                translatorId={userId}
                token={token}
                onToast={onToast}
                onAnalysisApplied={() => load()}
              />
            </div>
            )} {/* docSubTab === "id" */}

            {/* ── ③ 통장사본 ── */}
            {docSubTab === "bank" && (
            <div>
              <label style={labelSt}>통장사본 파일</label>
              <TranslatorEvidenceDocumentsSection
                docType="bankbook"
                mode="detail"
                translatorId={userId}
                token={token}
                onToast={onToast}
              />
            </div>
            )} {/* docSubTab === "bank" */}

          </div>
          )} {/* !collapsed.resume */}

          {/* ═══ 6. 운영 정보 — 통합 섹션 (기본 접힘) ═══ */}
          {secRow("운영 정보", "operational")}
          {!collapsed.operational && (
            <div style={{ background: "#f9fafb", borderRadius: 10, border: "1px solid #f3f4f6", padding: "14px 16px", marginBottom: 10 }}>
              {/* 등급 / 평점 / 가용상태 */}
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "10px 16px", marginBottom: 12 }}>
                <div>
                  <label style={labelSt}>등급</label>
                  <ClickSelect value={form.grade} onChange={v => setForm(p => ({ ...p, grade: v }))}
                    style={{ width: "100%" }} triggerStyle={{ width: "100%", fontSize: 13, padding: "7px 10px", borderRadius: 8 }}
                    options={[{ value: "", label: "등급 없음" }, ...GRADE_OPTIONS.map(g => ({ value: g, label: `${g}등급` }))]} />
                </div>
                <div>
                  <label style={labelSt}>평점 (1-5)</label>
                  <input type="number" value={form.rating} onChange={e => setForm(p => ({ ...p, rating: e.target.value }))}
                    placeholder="예: 4.5" style={{ ...inputStyle, fontSize: 13, padding: "7px 10px" }} />
                </div>
                <div>
                  <label style={labelSt}>가용 상태</label>
                  {userInfo?.isActive === false ? (
                    <div style={{ padding: "7px 10px", borderRadius: 8, border: "1px solid #e5e7eb", background: "#f9fafb", fontSize: 13, color: "#9ca3af", fontWeight: 600 }}>
                      불가 (활성화 후 변경 가능)
                    </div>
                  ) : (
                    <ClickSelect value={form.availabilityStatus} onChange={v => setForm(p => ({ ...p, availabilityStatus: v }))}
                      style={{ width: "100%" }} triggerStyle={{ width: "100%", fontSize: 13, padding: "7px 10px", borderRadius: 8 }}
                      options={[
                        { value: "available", label: "가능" }, { value: "busy", label: "바쁨" }, { value: "unavailable", label: "불가" },
                      ]} />
                  )}
                </div>
              </div>
              {/* 운영상태 / 재배정 */}
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px 16px", marginBottom: 12 }}>
                <div>
                  <label style={labelSt}>운영상태</label>
                  {userInfo?.isActive === false ? (
                    <div style={{ padding: "7px 10px", borderRadius: 8, border: "1px solid #e5e7eb", background: "#f9fafb", fontSize: 13, color: "#9ca3af", fontWeight: 600 }}>
                      비활성 (활성화 후 변경 가능)
                    </div>
                  ) : (
                    <ClickSelect value={form.operationalStatus} onChange={v => setForm(p => ({ ...p, operationalStatus: v }))}
                      style={{ width: "100%" }} triggerStyle={{ width: "100%", fontSize: 13, padding: "7px 10px", borderRadius: 8 }}
                      options={[
                        { value: "normal",   label: "✅ 정상" },
                        { value: "warning",  label: "⚠️ 주의" },
                        { value: "hold",     label: "⏸ 보류" },
                        { value: "excluded", label: "🚫 제외" },
                      ]} />
                  )}
                </div>
                <div>
                  <label style={labelSt}>재배정 가능 여부</label>
                  <ClickSelect value={form.reassignmentAllowed ? "true" : "false"}
                    onChange={v => setForm(p => ({ ...p, reassignmentAllowed: v === "true" }))}
                    style={{ width: "100%" }} triggerStyle={{ width: "100%", fontSize: 13, padding: "7px 10px", borderRadius: 8 }}
                    options={[{ value: "true", label: "가능" }, { value: "false", label: "불가" }]} />
                </div>
              </div>
              {/* 운영메모 */}
              <div>
                <label style={labelSt}>운영메모 <span style={{ color: "#9ca3af", fontWeight: 400 }}>(내부 전용 — 외부 비공개)</span></label>
                <textarea value={form.operationalNote} onChange={e => setForm(p => ({ ...p, operationalNote: e.target.value }))}
                  rows={3} placeholder="컴플레인 이력, 운영 리스크, 관리자 메모 등"
                  style={{ ...inputStyle, fontSize: 13, padding: "8px 10px", resize: "vertical" }} />
              </div>
            </div>
          )}

          {/* ── 단가 관리 (기본 접힘) ── */}
          {secRow("단가 관리", "rates")}
          {!collapsed.rates && (
            <>
              <div style={{ marginBottom: 10 }}>
                <TranslatorRateEntryCard
                  value={rateForm}
                  onChange={patch => setRateForm(p => ({ ...p, ...patch }))}
                  actionLabel="+ 추가"
                  onAction={handleAddRate}
                  actionLoading={addingRate}
                />
              </div>
              {rates.length > 0 ? (
                <div style={{ display: "flex", flexDirection: "column", gap: 4, marginBottom: 16 }}>
                  {rates.map(r => (
                    <div key={r.id} style={{ display: "flex", gap: 8, alignItems: "center", padding: "8px 12px", background: r.isActive === false ? "#f3f4f6" : "#f9fafb", borderRadius: 8, border: "1px solid #f3f4f6", fontSize: 13, flexWrap: "wrap", opacity: r.isActive === false ? 0.65 : 1 }}>
                      <span style={{ fontWeight: 700, color: "#374151", minWidth: 40 }}>{r.serviceType}</span>
                      {r.subType && <span style={{ color: "#6366f1", fontWeight: 600, minWidth: 52 }}>{r.subType}</span>}
                      {(r.language || r.languagePair) && (
                        <span style={{ color: "#3b82f6", minWidth: 60 }}>{r.language ?? "??"}{r.languagePair ? ` → ${r.languagePair}` : ""}</span>
                      )}
                      <span style={{ color: "#6b7280", minWidth: 40 }}>{getUnitLabel(r.unit)}</span>
                      <span style={{ fontWeight: 700, color: "#059669", minWidth: 80 }}>{r.rate.toLocaleString()}{r.currency !== "KRW" ? ` ${r.currency}` : "원"}</span>
                      {r.vatIncluded && <span style={{ fontSize: 11, background: "#fef3c7", color: "#92400e", borderRadius: 4, padding: "1px 5px" }}>VAT포함</span>}
                      {r.isDefault && <span style={{ fontSize: 11, background: "#dbeafe", color: "#1d4ed8", borderRadius: 4, padding: "1px 5px" }}>기본</span>}
                      {r.isActive === false && <span style={{ fontSize: 11, background: "#f3f4f6", color: "#9ca3af", borderRadius: 4, padding: "1px 5px" }}>비활성</span>}
                      {r.memo && <span style={{ color: "#9ca3af", fontSize: 12, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.memo}</span>}
                      {!r.memo && <span style={{ flex: 1 }} />}
                      <button onClick={() => handleDeleteRate(r.id)} style={{ background: "none", border: "none", color: "#dc2626", fontSize: 12, cursor: "pointer", padding: "2px 4px" }}>삭제</button>
                    </div>
                  ))}
                </div>
              ) : <p style={{ color: "#9ca3af", fontSize: 13, padding: "6px 0 14px" }}>등록된 단가가 없습니다.</p>}
            </>
          )}

          {/* ── 하단 바 ── */}
          <div style={{ marginTop: 16, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            {hasPerm("translator.sensitive") ? (
              <button onClick={() => setShowSensitive(true)}
                style={{ display: "flex", alignItems: "center", gap: 6, background: "#fffbeb", border: "1px solid #fcd34d", borderRadius: 8, padding: "8px 14px", fontSize: 13, fontWeight: 600, color: "#92400e", cursor: "pointer" }}>
                🔒 정산 정보 관리
              </button>
            ) : <span />}
            <GhostBtn onClick={onClose} style={{ fontSize: 14, padding: "9px 20px" }}>닫기</GhostBtn>
          </div>
        </>
      )}
    </DraggableModal>

    {showSensitive && hasPerm("translator.sensitive") && (
      <SensitiveInfoModal
        userId={userId}
        userName={profile?.bio ? `${userEmail} (${profile.bio})` : userEmail}
        token={token}
        onClose={() => setShowSensitive(false)}
        onToast={onToast}
        initialSettlementType={form.settlementType}
        onSettlementTypeSaved={(t) => setForm(p => ({ ...p, settlementType: t }))}
      />
    )}

    {showAnalyzePanel && (
      <ResumeAnalyzePanel
        userId={userId}
        token={token}
        hasResume={!!profile?.resumeUrl}
        autoStart={true}
        currentValues={{
          name: form.name || null,
          phone: form.phone || null,
          languagePairs: form.languagePairs || null,
          languageLevel: form.languageLevel || null,
          education: form.education || null,
          major: form.major || null,
          graduationYear: form.graduationYear ? Number(form.graduationYear) : null,
          graduationStatus: form.graduationStatus || null,
          specializations: form.specializations || null,
          profileWorkTypes: form.profileWorkTypes || null,
          profileSubTypes: form.profileSubTypes || null,
          region: form.region || null,
          bio: form.bio || null,
        }}
        onToast={onToast}
        onClose={() => setShowAnalyzePanel(false)}
        onApply={(result: ResumeAnalysisResult) => {
          const normalizedLang = result.languagePairs ? normalizeLanguages(result.languagePairs) : null;
          const normalizedRegion = (() => {
            const raw = result.region ?? result.address ?? null;
            if (!raw) return null;
            const p = parseRegionStr(raw);
            return buildRegionString(p.country, p.countryCustom, p.city);
          })();

          setForm(prev => {
            // ③ onApply 실행 전 prev.name vs AI result.name
            console.log(`[NAME-TRACE][3] onApply DetailModal prevName="${prev.name}" resultName="${result.name ?? "null"}" willApplyName=${!!(result.name && !prev.name)}`);
            return ({
            ...prev,
            // 사용자 입력값 우선 — 비어있을 때만 AI 값 적용
            ...(result.name && !prev.name ? { name: result.name } : {}),
            ...(result.phone && !prev.phone ? { phone: formatPhoneNumber(result.phone) } : {}),
            // 언어: 영어 → 한국어 정규화 후 적용
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
          });});
          // 학력/전공 preset 외 값 → custom 모드 동기화
          if (result.education) {
            if (!EDUCATION_ALL.includes(result.education)) { setEduIsCustom(true); setEduCustom(result.education); }
            else { setEduIsCustom(false); setEduCustom(""); }
          }
          if (result.major) {
            if (!MAJOR_ALL.includes(result.major)) { setMajorIsCustom(true); setMajorCustom(result.major); }
            else { setMajorIsCustom(false); setMajorCustom(""); }
          }
          // 지역 콤보박스 UI 상태 동기화
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
        }}
      />
    )}

    {resumePreview && (
      <DocumentPreviewModal
        url={resumePreview.url}
        fileName={resumePreview.fileName}
        onClose={() => setResumePreview(null)}
      />
    )}
    </>
  );
}
