/**
 * 거래처 Excel 다운로드 / 대량등록 템플릿 정의 (공통 엔진 excelExport.ts 사용).
 *
 * 다운로드: 목록 API(GET /admin/companies, page 파라미터 없이 = 전체 매칭)의 행을 그대로 출력.
 *  · 현재 companies 스키마에 없는 파생/시스템 필드(영문명·국가·기업규모·등급·거래상태·담당PM·
 *    유입경로·최초/최근거래일·누적견적건수·최근12개월매출·현재미수금·주요서비스)는 값을 지어내지
 *    않고 빈 컬럼으로 둔다(§3). 존재하는 값만 채운다.
 *  · 누적판매건수 = projectCount, 누적매출액 = totalPayment(목록 API 제공 파생값)만 사용.
 */
import { exportDataset, downloadTemplate, todayStamp, type ExcelColumn, type TemplateColumn } from './excelExport';

// 목록 API 행 형태(필요한 필드만 느슨하게 선언).
export interface CompanyExportRow {
  id: number;
  name?: string | null;
  businessNumber?: string | null;
  representativeName?: string | null;
  email?: string | null;
  phone?: string | null;
  industry?: string | null;
  businessCategory?: string | null;
  address?: string | null;
  website?: string | null;
  notes?: string | null;
  registeredAt?: string | null;
  companyType?: string | null;      // client | vendor
  customerType?: string | null;     // CORPORATE | PUBLIC | INDIVIDUAL
  createdAt?: string | null;
  projectCount?: number | null;     // 누적판매건수(파생)
  totalPayment?: number | null;     // 누적매출액(파생)
}

/** 거래처구분 표시값: 외주업체 우선, 그 외 customerType 라벨. */
function classifyLabel(row: CompanyExportRow): string {
  if (row.companyType === 'vendor') return '외주업체';
  switch ((row.customerType ?? 'CORPORATE').toUpperCase()) {
    case 'PUBLIC': return '공공기관';
    case 'INDIVIDUAL': return '개인';
    default: return '기업';
  }
}

// 다운로드 컬럼(§3 권장 순서). 값이 없는 파생/시스템 컬럼은 빈 문자열을 반환한다(빈 셀).
const EXPORT_COLUMNS: ExcelColumn<CompanyExportRow>[] = [
  { header: '거래처코드', value: () => '' },
  { header: '거래처명', value: 'name' },
  { header: '영문명', value: () => '' },
  { header: '사업자등록번호', value: 'businessNumber' },
  { header: '국가', value: () => '' },
  { header: '거래처구분', value: (r) => classifyLabel(r) },
  { header: '기업규모', value: () => '' },
  { header: '산업군', value: () => '' },
  { header: '업태', value: 'industry' },
  { header: '업종', value: 'businessCategory' },
  { header: '대표자명', value: 'representativeName' },
  { header: '거래처등급', value: () => '' },
  { header: '거래상태', value: () => '' },
  { header: '담당PM', value: () => '' },
  { header: '유입경로', value: () => '' },
  { header: '대표전화', value: 'phone' },
  { header: '대표이메일', value: 'email' },
  { header: '홈페이지', value: 'website' },
  { header: '주소', value: 'address' },
  { header: '최초거래일', value: () => '' },
  { header: '최근거래일', value: () => '' },
  { header: '누적견적건수', value: () => '' },
  { header: '누적판매건수', value: (r) => (typeof r.projectCount === 'number' ? r.projectCount : ''), type: 'number' },
  { header: '누적매출액', value: (r) => (typeof r.totalPayment === 'number' ? r.totalPayment : ''), type: 'number' },
  { header: '최근12개월매출', value: () => '' },
  { header: '현재미수금', value: () => '' },
  { header: '주요서비스', value: () => '' },
  { header: '등록일', value: (r) => r.registeredAt || r.createdAt || '', type: 'date' },
  { header: '비고', value: 'notes' },
];

/** 현재 검색/필터가 적용된 전체 거래처 행을 .xlsx 로 다운로드. */
export function exportCompanies(rows: CompanyExportRow[]): void {
  exportDataset<CompanyExportRow>({
    filename: `VERITAS_거래처_${todayStamp()}.xlsx`,
    sheetName: '거래처',
    columns: EXPORT_COLUMNS,
    rows,
  });
}

// ── 대량등록 템플릿 ────────────────────────────────────────────────────────
// 입력 대상은 현재 companies 에 실제 존재하는 컬럼만(§ 스키마 무변경 결정).
//  · 파생/시스템 필드(거래처코드·최초/최근거래일·누적*·주요서비스·등록일 자동)는 템플릿에서 제외.
//  · 거래처구분은 기존 UI 표준값(기업/공공기관/개인)만 허용 — 새 taxonomy 미생성(§5).
const TEMPLATE_COLUMNS: TemplateColumn[] = [
  { header: '거래처명', required: true, example: '(주)베리타스', note: '필수. 상호명' },
  { header: '거래처구분', example: '기업', allowed: ['기업', '공공기관', '개인'], note: '미입력 시 기업으로 등록' },
  { header: '사업자등록번호', example: '123-45-67890', note: '선택. 10자리(하이픈 무관). 없으면 거래처명으로 중복확인' },
  { header: '대표자명', example: '홍길동' },
  { header: '대표전화', example: '02-1234-5678' },
  { header: '대표이메일', example: 'contact@veritas.co.kr' },
  { header: '홈페이지', example: 'https://veritas.co.kr' },
  { header: '업태', example: '서비스업' },
  { header: '업종', example: '번역·통역' },
  { header: '주소', example: '서울특별시 강남구 …' },
  { header: '등록일', example: '2026-01-31', note: '선택. 미입력 시 오늘' },
  { header: '비고', example: '' },
];

/** 거래처 대량등록 빈 템플릿 다운로드. */
export function downloadCompanyTemplate(): void {
  downloadTemplate({
    filename: 'VERITAS_거래처_대량등록_템플릿.xlsx',
    sheetName: '거래처등록',
    columns: TEMPLATE_COLUMNS,
  });
}
