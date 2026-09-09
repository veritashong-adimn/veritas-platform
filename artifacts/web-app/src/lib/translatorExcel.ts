/**
 * 통번역사 Excel 다운로드 / 대량등록 템플릿 (공통 엔진 excelExport.ts 재사용 — 거래처/담당자와 동일 패턴).
 *
 * 다운로드: 통번역사 목록 API(GET /admin/translators, 검색/필터 전체)의 행을 그대로 출력.
 *  · 민감정보(주민번호·은행/계좌·예금주·해외송금·SWIFT·IBAN·거주국가·영문명 등)는 컬럼 자체를 넣지 않는다(§4·§5·§14).
 *  · 현재 schema/관계로 계산 불가능한 파생·미존재 필드(통번역사코드·인력구분·언어방향·세부전문분야·경력년수·
 *    주요경력·학교·통번역대학원여부·담당PM·수행/지급 파생·주요서비스·주요산업 등)는 값을 지어내지 않고 빈칸(§3).
 */
import { exportDataset, downloadTemplate, todayStamp, type ExcelColumn, type TemplateColumn } from './excelExport';

// 목록 API 행 형태(비민감 필드만 느슨하게 선언).
export interface TranslatorExportRow {
  id: number;
  name?: string | null;
  email?: string | null;
  phone?: string | null;
  region?: string | null;
  languagePairs?: string | null;
  specializations?: string | null;
  profileWorkTypes?: string | null;
  education?: string | null;
  major?: string | null;
  graduationYear?: number | null;
  grade?: string | null;
  rating?: number | null;
  availabilityStatus?: string | null;
  bio?: string | null;
  createdAt?: string | null;
}

// 다운로드 컬럼(§3 권장 순서). 민감정보·근거 없는 파생값은 빈 셀.
const EXPORT_COLUMNS: ExcelColumn<TranslatorExportRow>[] = [
  { header: '통번역사코드', value: () => '' },
  { header: '성명', value: 'name' },
  { header: '영문명', value: () => '' },              // 민감(translator_sensitive) — 제외
  { header: '활동상태', value: 'availabilityStatus' },
  { header: '인력구분', value: () => '' },
  { header: '휴대폰', value: 'phone' },
  { header: '이메일', value: 'email' },
  { header: '거주국가', value: () => '' },            // 민감 — 제외
  { header: '활동지역', value: 'region' },
  { header: '언어', value: 'languagePairs' },
  { header: '언어방향', value: () => '' },
  { header: '가능서비스', value: 'profileWorkTypes' },
  { header: '전문분야', value: 'specializations' },
  { header: '세부전문분야', value: () => '' },
  { header: '경력년수', value: () => '' },
  { header: '주요경력', value: () => '' },
  { header: '최종학력', value: 'education' },
  { header: '학교', value: () => '' },
  { header: '전공', value: 'major' },
  { header: '졸업년도', value: (r) => (typeof r.graduationYear === 'number' ? r.graduationYear : ''), type: 'number' },
  { header: '통번역대학원여부', value: () => '' },
  { header: '인력등급', value: 'grade' },
  { header: '내부평가', value: (r) => (typeof r.rating === 'number' ? r.rating : ''), type: 'number' },
  { header: '담당PM', value: () => '' },
  { header: '최초수행일', value: () => '' },
  { header: '최근수행일', value: () => '' },
  { header: '누적수행건수', value: () => '' },
  { header: '최근12개월수행건수', value: () => '' },
  { header: '누적수행금액', value: () => '' },
  { header: '누적지급액', value: () => '' },
  { header: '최근지급일', value: () => '' },
  { header: '주요서비스', value: () => '' },
  { header: '주요산업', value: () => '' },
  { header: '등록일', value: (r) => r.createdAt || '', type: 'date' },
  { header: '상세정보', value: 'bio' },
  { header: '비고', value: () => '' },
];

/** 현재 검색/필터가 적용된 전체 통번역사 행을 .xlsx 로 다운로드. */
export function exportTranslators(rows: TranslatorExportRow[]): void {
  exportDataset<TranslatorExportRow>({
    filename: `VERITAS_통번역사_${todayStamp()}.xlsx`,
    sheetName: '통번역사',
    columns: EXPORT_COLUMNS,
    rows,
  });
}

// ── 대량등록 템플릿 ────────────────────────────────────────────────────────
// Native 입력은 현재 profiles/users 에 실존하는 비민감 필드만(§6·스키마 무변경 결정).
//  · 통번역사코드·등록일(시스템 생성)·수행/지급 파생·민감 지급정보는 제외.
//  · 상세정보(bio)는 원문 보존 — 여러 컬럼으로 강제 분해하지 않는다(§7).
const TEMPLATE_COLUMNS: TemplateColumn[] = [
  { header: '성명', required: true, example: '홍길동', note: '필수' },
  { header: '이메일', required: true, example: 'hong@veritas.co.kr', note: '필수. 통번역사 생성 키(중복판정 강한 신호)' },
  { header: '영문명', example: 'Gildong Hong', note: '검색용 별칭으로 저장' },
  { header: '휴대폰', example: '010-1234-5678', note: '중복판정 강한 신호' },
  { header: '활동지역', example: '서울' },
  { header: '언어', example: '한국어, 영어', note: '쉼표 구분(구조화 migration 전까지 원문 보존)' },
  { header: '가능서비스', example: '순차통역, 일반번역' },
  { header: '전문분야', example: '제약·바이오, 법률' },
  { header: '최종학력', example: '석사' },
  { header: '전공', example: '통번역학' },
  { header: '졸업년도', example: '2018' },
  { header: '인력등급', example: 'A' },
  { header: '가용상태', example: 'available', note: '미입력 시 available' },
  { header: '상세정보', example: '주요경력·특수경험 등 자유 서술(원문 보존)' },
];

/** 통번역사 대량등록 빈 템플릿 다운로드. */
export function downloadTranslatorTemplate(): void {
  downloadTemplate({
    filename: 'VERITAS_통번역사_대량등록_템플릿.xlsx',
    sheetName: '통번역사등록',
    columns: TEMPLATE_COLUMNS,
  });
}
