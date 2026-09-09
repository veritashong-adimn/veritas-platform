/**
 * 담당자 Excel 다운로드 / 대량등록 템플릿 정의 (공통 엔진 excelExport.ts 재사용 — 거래처와 동일 패턴).
 *
 * 다운로드: 담당자 목록 API(GET /admin/contacts, page 없이 = 검색/필터 전체 매칭)의 행을 그대로 출력.
 *  · 현재 contacts 스키마/관계로 계산 불가능한 파생/미존재 필드(담당자코드·담당자역할·담당자상태·
 *    고객중요도·담당PM·유입경로·최초/최근거래일·건수·매출·주요서비스·수신가능)는 값을 지어내지 않고
 *    빈 컬럼으로 둔다(§3). 실제 존재하는 값만 채운다.
 */
import { exportDataset, downloadTemplate, todayStamp, type ExcelColumn, type TemplateColumn } from './excelExport';

// 목록 API 행 형태(필요한 필드만 느슨하게 선언).
export interface ContactExportRow {
  id: number;
  name?: string | null;
  companyName?: string | null;
  companyBusinessNumber?: string | null;
  department?: string | null;
  position?: string | null;
  mobile?: string | null;
  officePhone?: string | null;
  email?: string | null;
  memo?: string | null;
  notes?: string | null;
  registeredAt?: string | null;
  createdAt?: string | null;
}

// 다운로드 컬럼(§3 권장 순서). 값 없는 파생/시스템 컬럼은 빈 문자열(빈 셀).
const EXPORT_COLUMNS: ExcelColumn<ContactExportRow>[] = [
  { header: '담당자코드', value: () => '' },
  { header: '거래처명', value: 'companyName' },
  { header: '사업자등록번호', value: 'companyBusinessNumber' },
  { header: '담당자명', value: 'name' },
  { header: '부서', value: 'department' },
  { header: '직책', value: 'position' },
  { header: '담당자역할', value: () => '' },
  { header: '휴대폰', value: 'mobile' },
  { header: '회사전화', value: 'officePhone' },
  { header: '이메일', value: 'email' },
  { header: '담당자상태', value: () => '' },
  { header: '고객중요도', value: () => '' },
  { header: '담당PM', value: () => '' },
  { header: '유입경로', value: () => '' },
  { header: '최초거래일', value: () => '' },
  { header: '최근거래일', value: () => '' },
  { header: '누적견적건수', value: () => '' },
  { header: '누적판매건수', value: () => '' },
  { header: '누적매출액', value: () => '' },
  { header: '최근12개월매출', value: () => '' },
  { header: '주요서비스', value: () => '' },
  { header: '이메일수신가능', value: () => '' },
  { header: 'SMS수신가능', value: () => '' },
  { header: '등록일', value: (r) => r.registeredAt || r.createdAt || '', type: 'date' },
  { header: '메모', value: (r) => r.memo || r.notes || '' },
];

/** 현재 검색/필터가 적용된 전체 담당자 행을 .xlsx 로 다운로드. */
export function exportContacts(rows: ContactExportRow[]): void {
  exportDataset<ContactExportRow>({
    filename: `VERITAS_담당자_${todayStamp()}.xlsx`,
    sheetName: '담당자',
    columns: EXPORT_COLUMNS,
    rows,
  });
}

// ── 대량등록 템플릿 ────────────────────────────────────────────────────────
// 입력 대상은 현재 contacts 에 실제 존재하는 컬럼 + 거래처 연결 식별정보만(§5·스키마 무변경 결정).
//  · 담당자코드·등록일(시스템 생성)·파생필드는 제외.
//  · 담당자역할/담당자상태/고객중요도/담당PM/유입경로/수신가능은 현재 스키마에 없어 이번 템플릿에서 제외
//    (앱에서 별도 관리 예정). 가짜 컬럼을 넣어 무시하지 않는다.
const TEMPLATE_COLUMNS: TemplateColumn[] = [
  { header: '사업자등록번호', example: '123-45-67890', note: '거래처 연결용. 10자리(하이픈 무관). 사업자번호 또는 거래처명 중 하나 이상 필요' },
  { header: '거래처명', example: '(주)베리타스', note: '거래처 연결용. 사업자번호가 없으면 거래처명으로 연결(동일명 여러 개면 확인필요)' },
  { header: '담당자명', required: true, example: '홍길동', note: '필수' },
  { header: '부서', example: '경영지원팀' },
  { header: '직책', example: '팀장' },
  { header: '휴대폰', example: '010-1234-5678', note: '중복판정 강한 신호(동일 거래처 기준)' },
  { header: '회사전화', example: '02-1234-5678', note: '대표/부서 전화일 수 있어 개인 식별키로 쓰지 않음' },
  { header: '이메일', example: 'hong@veritas.co.kr', note: '중복판정 강한 신호(동일 거래처 기준)' },
  { header: '메모', example: '' },
];

/** 담당자 대량등록 빈 템플릿 다운로드. */
export function downloadContactTemplate(): void {
  downloadTemplate({
    filename: 'VERITAS_담당자_대량등록_템플릿.xlsx',
    sheetName: '담당자등록',
    columns: TEMPLATE_COLUMNS,
  });
}
