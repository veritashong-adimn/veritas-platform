import React, { useState, useCallback, useRef } from 'react';
import { TranslatorImportApprovalPanel } from './TranslatorImportApprovalPanel';
import { PartyImportBatches } from './PartyImportBatches';
import { CompanyReviewList } from './CompanyReviewList';
// ④ 최종 등록은 통합 판정(실행 로직과 동일)만 표시한다. 구 Master 재구축 기준 요약·드라이런은 판정이 달라 혼동을 주므로 숨김(실행 경로도 차단됨).
const SHOW_LEGACY_REBUILD_FINAL = false;
import './readTableView.css';
import { api } from '../../lib/constants';
import { Card, PrimaryBtn, GhostBtn, confirmDialog } from '../ui';
import { BackToListButton } from './BackToListButton';
import { downloadCompanyTemplate } from '../../lib/companyExcel';
import { downloadContactTemplate } from '../../lib/contactExcel';
import { downloadTranslatorTemplate } from '../../lib/translatorExcel';
import { downloadQuoteTemplate } from '../../lib/quoteExcel';

// ─── 안전 유틸 ────────────────────────────────────────────────────────────────
// 서버 응답의 형태가 예상과 다르거나(구버전 배포·enum 불일치) 일부 필드가 비어도
// 화면 전체가 크래시되지 않도록 방어적으로 값을 정규화한다.
/** 숫자로 안전 변환(undefined/NaN → 0). SummaryCard 등 표시용. */
function safeNum(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

// ─── 거래처·담당자 대량등록(홈택스 엑셀) 공통 페이지 ──────────────────────────
// 4단계: 파일 업로드 → 분석 → 미리보기 → 등록 실행. 거래처/담당자 공용이며
// 실제 엔드포인트·컬럼 매핑만 entity 별 config 로 분리한다.
//
// 등록 방식(mode):
//   new_only(기본) → 신규만 등록. 기존 데이터는 변경하지 않음.
//   update         → 신규 등록 + 사업자번호/담당자키 기준 기존 데이터 업데이트.

export type BulkImportEntity = 'company' | 'contact' | 'translator' | 'quote';

type RowStatus = 'new' | 'identical' | 'update' | 'needs_review' | 'duplicate_file' | 'conflict' | 'error';
type ImportMode = 'new_only' | 'update';

interface FieldChange { old: string; new: string; }

interface AnalyzedRow {
  rowNumber: number;
  status: RowStatus;
  reason?: string;
  warning?: string;   // 경고(저장 가능하나 확인 필요) — status 와 독립(§9)
  existingId?: number | null;
  matchMethod?: 'rrn' | 'email' | 'phone' | 'name';   // 통번역사: 연결 근거(요구사항1)
  reviewCategory?: 'same_person' | 'homonym' | 'file_internal' | 'undecidable' | 'legacy_no_email' | 'excluded_master';  // needs_review 세분(요구사항3)
  changeSummary?: string;   // 통번역사: 보완/충돌 필드 요약(컬럼 외 필드 포함)
  residentMasked?: string;  // 통번역사: 엑셀 원본 주민번호 마스킹 표기(원문 아님) — 없으면 미전달 → '-' 표시
  masterInactive?: boolean; // 통번역사: 매칭된 기존 Master 가 비활성 인력인지(요구사항4)
  changes?: Record<string, FieldChange>;
  // 개인고객 중복 후보의 매칭 기존 레코드(§9) — 사유 칸에 함께 표시.
  matchDetail?: { id: number; name: string; email: string | null; phone: string | null; fields: string[] } | null;
  [key: string]: unknown;
}

interface Summary { total: number; new: number; identical: number; update: number; needsReview?: number; duplicateFile: number; conflict?: number; error: number; warning?: number; }

// 통번역사 전용 진단(읽기전용 · 미리보기 전용) — 단순화 기준 핵심 요약 + A~F 보고서.
interface TranslatorDiagnostics {
  linkedPersons: number;        // 기존 Master 연결(동일인 확정) 고유 인원
  newPersons: number;           // 신규 등록 가능 고유 인원
  exceptionPersons: number;     // 예외 검토 고유 인원
  updatablePersons: number;     // 업데이트 가능 고유 인원
  errorBreakdown: Record<string, number>;
  conflictFieldCounts: Record<string, number>;   // 동일인 확정 후 실제 변경 필드별 건수
  fillFieldCounts: Record<string, number>;        // 공란 보완 필드별 건수
  legacyMappedTotal: number; legacyLinkedInFile: number;
  report: {
    rowsTotal: number;
    A_nameRrn: number;
    B_nameEmail: number;
    C_namePhone: number;
    D_updatable: number;
    E_newRegistrable: number;
    F_exception: number;
    legacyNotInFile: number;
    reconciliation: { bucketSum: number; rowsTotal: number; reconciled: boolean; buckets: Record<string, number> };
  };
}

// 진단 통계(읽기전용, 2단계 조사): 사업자번호 canonical 기준 그룹 통계. 거래처 대량등록(company)에서만 반환.
//   개인고객(INDIVIDUAL) 파일이면 mode==="individual" 로 오고, 사업자번호 패널 대신 개인고객 통계를 표시한다(§11).
interface ImportDiagnostics {
  mode?: 'business' | 'individual';
  totalRows: number;
  rowsNoBiz: number;
  rowsInvalidBiz: number;
  rowsWithValidBiz: number;
  uniqueBizGroups: number;
  dupGroupCount: number;
  dupGroupRowCount: number;
  singleBizGroupCount: number;
  groupsDiffPhone: number;
  groupsDiffEmail: number;
  reviewConflictGroups: number;
  dbBizExactMatchUnique: number;
  newUniqueBiz: number;
  finalUniqueMasters: number;
  // 개인고객 전용(§11) — mode==="individual" 일 때 의미 있음.
  indivTotalRows?: number;
  indivUniqueCandidates?: number;
  indivNewRegistrable?: number;
  indivFileExactDup?: number;
  indivHomonymGroups?: number;
  indivDbExactDup?: number;
  indivPhoneOnly?: number;
  indivEmailOnly?: number;
  indivErrors?: number;
}

interface AnalyzeResponse {
  // 거래처·담당자: 고유 대상 기준 6개 항목 + 실행 승인 토큰
  uniqueSummary?: { uniqueTotal: number; counts: { same: number; new: number; update: number; review: number; individual?: number; excluded: number }; rows: number; duplicateRows: number; excludedReasons: Record<string, number> };
  planToken?: string;
  fileName: string;
  sheetName: string;
  headerRowIndex: number;
  columnMap: Record<string, string | null>;
  summary: Summary;
  diagnostics?: ImportDiagnostics;
  translatorDiagnostics?: TranslatorDiagnostics;
  snapshotId?: string | null;   // 서버 암호화 보관 식별자(Master 재구축 재분석용). 셀 값·주민번호는 포함되지 않음.
  rows: AnalyzedRow[];
}

// 통번역사 Master 재구축 분석(읽기 전용) — 저장된 암호화 스냅샷을 서버가 재분석한 결과.
//   DB·Master·이관 매핑을 변경하지 않으며, 주민번호 원문은 응답에 포함되지 않는다(건수만).
interface RebuildAnalysisResponse {
  dryRun: boolean;
  committed: boolean;
  snapshot: { id: string; filename: string; createdAt: string };
  classification: {
    sheetName: string;
    crmTotalRows: number;             // CRM 명부 전체 데이터 행
    crmUniquePersons: number;         // 실제 고유 인원(식별자 중복 제거)
    crmInternalDupById: number;       // 동일 식별자 중복행(제외)
    crmSameNameNoIdentifier: number;  // 식별자 없는 동명 — 확인 필요(병합 안 함)
    crmInvalidRows: number;           // 성명 누락 등
    uniqueWithRrn: number;            // 고유 인원 중 주민번호 보유
    A_withHistory: number;            // A: 수행이력 O → 전원 등록
    A_confirmedByRrn: number;         // A 중 주민번호로 확정
    A_byNameOnlyNeedsCheck: number;   // A 중 이름만 일치(동명이인 확인 필요)
    B_rrnNoHistory: number;           // B: 수행이력 X · 주민번호 O → 등록
    C_hold: number;                   // C: 수행이력 X · 주민번호 X → 보류
    registerTarget: number;           // 최종 등록(A+B)
    // ── 기존 Master 교차대조(요구사항5) — reuse + new + exception = registerTarget 로 정합. ──
    reuseExistingMaster: number;      // ⑤ 기존 Master 재사용 예정 인원(동일인 확정)
    reuseMasterCount: number;         // ↑ 참고: 실제 재사용되는 고유 Master 수
    masterSupplementable: number;     // ⑥ 기존 Master 정보 보완 가능 인원(재사용 대상 중 CRM이 결측 식별정보 보유)
    newMasterToCreate: number;        // ⑦ 신규 Master 생성 예정 인원(이름·식별정보 모두 기존 Master에 없음)
    identityException: number;        // ⑨ 동일인 확인 예외 인원(복수일치·동명 미확정)
    masterTotal: number;              // 참고: 기존 통번역사 Master 총원(미삭제)
    masterNotInCrm: number;           // ⑩ CRM 명부엔 없고 기존 Master엔 존재하는 인원
    dupMasterCleanup: number;         // 중복 Master 정리 예정 인원(동일 주민번호 초과분·검증 후 비활성화 후보)
    masterMatchReconciled: boolean;   // reuse+new+exception === A+B
    // ── 동일인 확정 불가 인원 재분류(요구사항1~5) — 독립 신규 후보 vs 실제 수동 ──
    exceptionAnalysis: {
      total: number;
      newCandidate: number;                 // 독립 신규 등록 후보로 재분류
      manualReview: number;                 // 실제 수동 확인 필요
      byReason: {
        multiCandidate: number;
        idConflictOtherMaster: number;
        historyIdMismatch: number;
        rrnMismatchSameName: number;
        rrnIndependentNew: number;
        historyIndependentNew: number;
        other: number;
      };
      diagnostics: { missingRrn: number; missingContact: number };
      reconciled: boolean;
    };
    newMasterCandidateTotal: number;  // 신규 Master 등록 가능 인원(순수 신규 + 재분류 독립 신규)
    finalDisposition: {
      reuseExisting: number;
      newCandidate: number;
      manualReview: number;
      excluded: number;
      total: number;
      reconciled: boolean;
    };
    reconciled: boolean;              // A+B+C === 고유 인원
  };
  progressLink: { groups: number; linked: number; unlinked: number; confirmed: number; candidate: number; expected: number; unresolvedException: number };
  note: string;
}

// 재구축 실제 등록 실행 — 드라이런(계획·검증) 응답. commit 전까지 DB 미변경.
interface RebuildExecuteResponse {
  dryRun: boolean;
  committed: boolean;
  snapshot: { id: string; filename: string; createdAt: string };
  disposition: { reuseExisting: number; newCandidate: number; manualReview: number; excluded: number; total: number; reconciled: boolean };
  willRegister: { reuseExisting: number; newCreate: number; manualHold: number; excluded: number };
  validation: {
    idPreserved: boolean; newCreatable: number; emailCollision: number; rrnCollision: number; fileDupBlocked: number;
    blockedSample: { rowNumber: number; name: string; reason: string }[];
    cleanupCandidates: number; originalsPreserved: boolean;
  };
  beforeCount: number;
  projectedAfter: number;
  readyToExecute: boolean;
  planMatchesAnalysis: boolean;
  excludeAudit: { total: number; criterionC: number; withRrnButExcluded: number; nameMissingSeparate: number; allCriterionC: boolean };
  manualReviewDetail: { rowNumber: number; nameMasked: string; residentMasked: string; reasonCode: string; reason: string; action: string }[];
  note: string;
}

// 기존 Master 상세정보 보완 — 드라이런(계획) 응답. DB 미반영.
type FieldDecision = 'keep' | 'apply' | 'hold';
type FieldCategory = 'fill' | 'email_replace' | 'merge' | 'contact_review' | 'conflict_review';
interface UpdatePlanResponse {
  fileName: string;
  dryRun: boolean;
  committed: boolean;
  summary: {
    eligibleRows: number; eligiblePersons: number; blockedRows: number;
    personsToUpdate: number; appliedFieldTotal: number;
    applyFieldCounts: Record<string, number>; holdFieldCounts: Record<string, number>; keepFieldCounts: Record<string, number>;
    categoryCounts: Record<FieldCategory, number>;
    inactiveWithApply: number;
  };
  rrnReport: {
    rrnSingleTotal: number; rrnAutoUpdatable: number; rrnReviewNeeded: number;
    rrnNoChange: number; rrnMultiBlocked: number; reconciled: boolean;
  };
  auditPreview: Array<{
    masterId: number; name: string; residentMasked: string | null; matchMethod: string | null;
    masterInactive: boolean; autoUpdatable: boolean;
    changes: Array<{ field: string; label: string; old: string; new: string; category: FieldCategory; autoAllowed: boolean; decision: FieldDecision }>;
  }>;
  note: string;
}

// 프론트 기본 결정 규칙(서버 updateFieldCategory 와 동일). 토글 기본값·범주 배지에 사용.
const LEGACY_EMAIL_SUFFIX = '@crm-migrated.invalid';
const FE_MERGE_FIELDS = new Set(['languages', 'bio']);
function feFieldCategory(field: string, oldVal: string, newVal: string): FieldCategory {
  if (!(oldVal ?? '').trim()) return 'fill';
  if (field === 'email') return oldVal.toLowerCase().endsWith(LEGACY_EMAIL_SUFFIX) ? 'email_replace' : 'contact_review';
  if (field === 'phone') return 'contact_review';
  if (FE_MERGE_FIELDS.has(field)) return 'merge';
  return 'conflict_review';
}
const FE_AUTO_CATEGORIES = new Set<FieldCategory>(['fill', 'email_replace']);
const CATEGORY_LABELS: Record<FieldCategory, string> = {
  fill: '공란 보완', email_replace: '임시→실제 교체', merge: '통합 검토', contact_review: '연락처 검토', conflict_review: '충돌 검토',
};

interface ExecuteResponse {
  fileName: string;
  mode: ImportMode;
  inserted: number;
  updated: number;
  summary: Summary;
}

interface ColumnDef { key: string; label: string; width?: number; align?: 'left' | 'center'; ellipsis?: boolean; }

// 통번역사 보완 필드 한글 라벨(서버 FIELD_LABELS 와 동일 키).
const FIELD_LABELS: Record<string, string> = {
  name: '성명', email: '이메일', phone: '휴대폰', languages: '언어', services: '가능서비스',
  specializations: '전문분야', grade: '인력등급', region: '활동지역',
  education: '학력', major: '전공', graduationYear: '졸업년도', bio: '상세정보',
};

interface EntityConfig {
  title: string;
  analyzeUrl: string;
  executeUrl: string;
  columns: ColumnDef[];
  defaultsNote: string;
  resultLabels: { new: string; unit: string; missingCompany?: boolean };
}

const COMPANY_CONFIG: EntityConfig = {
  title: '거래처 대량등록',
  analyzeUrl: '/api/admin/companies/bulk-import/analyze',
  executeUrl: '/api/admin/companies/bulk-import/execute',
  columns: [
    { key: 'name', label: '거래처명' },
    { key: 'customerType', label: '거래처구분' },
    { key: 'businessNumber', label: '사업자등록번호' },
    { key: 'representativeName', label: '대표자명' },
    { key: 'phone', label: '대표전화' },
    { key: 'email', label: '대표이메일' },
    { key: 'industry', label: '업태' },
    { key: 'businessCategory', label: '종목' },
    { key: 'address', label: '주소' },
    { key: 'registeredAt', label: '등록일' },
  ],
  defaultsNote: '거래처 유형: 고객사 (등록 후 개별 수정 가능)',
  resultLabels: { new: '신규 거래처 등록', unit: '건' },
};

const CONTACT_CONFIG: EntityConfig = {
  title: '담당자 대량등록',
  analyzeUrl: '/api/admin/contacts/bulk-import/analyze',
  executeUrl: '/api/admin/contacts/bulk-import/execute',
  columns: [
    { key: 'companyName', label: '거래처명(파일)' },
    { key: 'matchedCompanyName', label: '연결 거래처' },
    { key: 'businessNumber', label: '사업자등록번호' },
    { key: 'name', label: '담당자명' },
    { key: 'department', label: '부서' },
    { key: 'position', label: '직책' },
    { key: 'mobile', label: '휴대폰' },
    { key: 'email', label: '이메일' },
    { key: 'officePhone', label: '회사전화' },
  ],
  defaultsNote: '활성 · 기본/견적/청구 담당자 모두 해제 (역할은 등록 후 직접 지정). 사업자등록번호 또는 거래처명으로 기존 거래처에 연결됩니다. 이번 단계는 신규 담당자만 등록합니다.',
  resultLabels: { new: '신규 담당자 등록', unit: '명', missingCompany: true },
};

const TRANSLATOR_CONFIG: EntityConfig = {
  title: '통번역사 대량등록',
  analyzeUrl: '/api/admin/translators/bulk-import/analyze',
  executeUrl: '/api/admin/translators/bulk-import/execute',
  // 미리보기 테이블 컬럼: 명시적 너비(px)·정렬을 지정하면 고정 레이아웃(table-layout: fixed)으로 렌더된다.
  columns: [
    { key: 'name', label: '성명', width: 110, align: 'left' },
    { key: 'residentMasked', label: '주민번호', width: 125, align: 'center' },
    { key: 'email', label: '이메일', width: 220, align: 'left', ellipsis: true },
    { key: 'phone', label: '휴대폰', width: 135, align: 'center' },
    { key: 'languages', label: '언어', width: 85, align: 'center' },
    { key: 'services', label: '가능서비스', width: 105, align: 'center' },
    { key: 'specializations', label: '전문분야', width: 105, align: 'center' },
    { key: 'grade', label: '인력등급', width: 90, align: 'center' },
    { key: 'region', label: '활동지역', width: 110, align: 'center' },
  ],
  defaultsNote: '활동상태 활성으로 신규 등록됩니다. 민감정보(주민번호·계좌 등)는 이 일반 대량등록에 포함되지 않습니다. 이번 단계는 신규 통번역사만 등록합니다.',
  resultLabels: { new: '신규 통번역사 등록', unit: '명' },
};

const QUOTE_CONFIG: EntityConfig = {
  title: '견적 대량등록',
  analyzeUrl: '/api/admin/quotes/bulk-import/analyze',
  executeUrl: '/api/admin/quotes/bulk-import/execute',
  columns: [
    { key: 'tempKey', label: '임시키' },
    { key: 'title', label: '견적서명' },
    { key: 'matchedCompanyName', label: '연결 거래처' },
    { key: 'contactName', label: '담당자' },
    { key: 'pm', label: '담당PM' },
    { key: 'itemCount', label: '품목수' },
    { key: 'supplyAmount', label: '공급가액' },
    { key: 'taxAmount', label: '부가세' },
    { key: 'totalAmount', label: '총금액' },
  ],
  defaultsNote: '일반견적만 신규 등록됩니다. 금액은 품목 기준 시스템 계산이며, 판매/프로젝트(판매)/청구/지급/정산은 생성되지 않습니다. (견적 컨테이너 project(status=created)만 생성)',
  resultLabels: { new: '신규 견적 등록', unit: '건' },
};

type StatusMeta = { label: string; bg: string; color: string; border: string };
const STATUS_META: Record<RowStatus, StatusMeta> = {
  new: { label: '신규 등록 예정', bg: '#ecfdf5', color: '#047857', border: '#a7f3d0' },
  identical: { label: '기존 데이터 동일', bg: '#f3f4f6', color: '#6b7280', border: '#e5e7eb' },
  update: { label: '기존 데이터 변경 예정', bg: '#eff6ff', color: '#1d4ed8', border: '#bfdbfe' },
  needs_review: { label: '중복 검토 필요(제외)', bg: '#fffbeb', color: '#b45309', border: '#fde68a' },
  duplicate_file: { label: '파일 내 중복(제외)', bg: '#fff7ed', color: '#c2410c', border: '#fed7aa' },
  conflict: { label: '정보 충돌(검토)', bg: '#fef3f2', color: '#c2410c', border: '#fecaca' },
  error: { label: '오류(제외)', bg: '#fef2f2', color: '#b91c1c', border: '#fecaca' },
};

// 구버전 서버가 쓰던 상태값 → 현재 enum 별칭(배포 시차로 인한 불일치 완충).
const LEGACY_STATUS_ALIAS: Record<string, RowStatus> = {
  ready: 'new',
  duplicate_db: 'update',
  duplicateDb: 'update',
};

/** 알 수 없는 상태값이 와도 절대 throw 하지 않는 배지 메타 조회. */
function statusMeta(status: unknown): StatusMeta {
  const key = typeof status === 'string' ? status : '';
  const canonical = (STATUS_META[key as RowStatus] ? key : LEGACY_STATUS_ALIAS[key]) as RowStatus | undefined;
  if (canonical && STATUS_META[canonical]) return STATUS_META[canonical];
  return { label: key || '알 수 없음', bg: '#f3f4f6', color: '#6b7280', border: '#e5e7eb' };
}

const tableTh: React.CSSProperties = {
  padding: '9px 10px', textAlign: 'left', fontSize: 11, fontWeight: 600,
  color: '#6b7280', background: '#f9fafb', borderBottom: '1px solid #e5e7eb', whiteSpace: 'nowrap',
};
const tableTd: React.CSSProperties = {
  padding: '8px 10px', fontSize: 12, color: '#374151',
  borderBottom: '1px solid #edf0f3', verticalAlign: 'middle', whiteSpace: 'nowrap',
};

function SummaryCard({ label, value, tone, onClick, active }: { label: string; value: number | undefined; tone: 'default' | 'green' | 'amber' | 'red' | 'blue' | 'gray'; onClick?: () => void; active?: boolean }) {
  const tones: Record<string, { bg: string; color: string }> = {
    default: { bg: '#f9fafb', color: '#111827' },
    green: { bg: '#ecfdf5', color: '#047857' },
    amber: { bg: '#fffbeb', color: '#b45309' },
    red: { bg: '#fef2f2', color: '#b91c1c' },
    blue: { bg: '#eff6ff', color: '#1d4ed8' },
    gray: { bg: '#f3f4f6', color: '#6b7280' },
  };
  const t = tones[tone];
  return (
    <div onClick={onClick} role={onClick ? 'button' : undefined} tabIndex={onClick ? 0 : undefined} aria-label={onClick ? `${label} 보기` : undefined}
      data-testid={onClick ? `summary-card-${label}` : undefined} onKeyDown={onClick ? (e) => { if (e.key === 'Enter') onClick(); } : undefined}
      style={{ flex: '1 1 120px', minWidth: 110, background: t.bg, borderRadius: 10, padding: '12px 14px', border: active ? `2px solid ${t.color}` : '1px solid #eef2f7', cursor: onClick ? 'pointer' : 'default' }}>
      <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 700, color: t.color }}>{safeNum(value).toLocaleString()}</div>
    </div>
  );
}

/** 변경 예정 셀: 이전값 → 새값 강조. update(보완)=파랑, conflict(충돌)=주황. 변경 없는 셀은 일반 표시. */
function CellValue({ row, colKey }: { row: AnalyzedRow; colKey: string }) {
  const change = (row.status === 'update' || row.status === 'conflict') ? row.changes?.[colKey] : undefined;
  if (change) {
    // 기존 공란 → 값 채움(보완)은 파랑, 기존 값이 있는데 달라짐(충돌)은 주황으로 구분.
    const isConflict = !!(change.old && change.old.trim());
    const hi = isConflict ? { color: '#c2410c', bg: '#fff7ed' } : { color: '#1d4ed8', bg: '#eff6ff' };
    return (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap' }}>
        <span style={{ color: '#9ca3af', textDecoration: 'line-through' }}>{change.old || '(없음)'}</span>
        <span style={{ color: '#9ca3af' }}>→</span>
        <span style={{ color: hi.color, fontWeight: 700, background: hi.bg, padding: '1px 6px', borderRadius: 5 }}>{change.new || '(없음)'}</span>
      </span>
    );
  }
  const v = String(row[colKey] ?? '');
  return v ? <>{v}</> : <span style={{ color: '#cbd5e1' }}>-</span>;
}

const MAX_PREVIEW_ROWS = 500;

interface BulkImportPageProps {
  entity: BulkImportEntity;
  token: string;
  onClose: () => void;
  onToast: (msg: string) => void;
  onDone?: () => void;
}

function BulkImportPageInner({ entity, token, onClose, onToast, onDone }: BulkImportPageProps) {
  const cfg = entity === 'company' ? COMPANY_CONFIG : entity === 'translator' ? TRANSLATOR_CONFIG : entity === 'quote' ? QUOTE_CONFIG : CONTACT_CONFIG;
  const [file, setFile] = useState<File | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [executing, setExecuting] = useState(false);
  const [analysis, setAnalysis] = useState<AnalyzeResponse | null>(null);
  const [result, setResult] = useState<ExecuteResponse | null>(null);
  const [filter, setFilter] = useState<'all' | RowStatus | 'warning'>('all');
  // 통번역사 검토 세분 필터(요구사항4) — 상태 필터와 AND 로 결합. needs_review 하위 분류 탐색용.
  type ReviewCat = NonNullable<AnalyzedRow['reviewCategory']>;
  const [reviewFilter, setReviewFilter] = useState<'all' | ReviewCat>('all');
  // 거래처·담당자: 등록 방식은 '신규 등록 + 기존 정보 업데이트'로 통일(변경 항목만, 빈 셀 덮어쓰기 없음)
  const [mode, setMode] = useState<ImportMode>(entity === 'company' || entity === 'contact' ? 'update' : 'new_only');
  const [rowStatsOpen, setRowStatsOpen] = useState(false);
  const [reviewDecisions, setReviewDecisions] = useState<Record<string, string>>({});
  const [catFilter, setCatFilter] = useState<'all' | 'same' | 'new' | 'update' | 'review' | 'individual' | 'excluded'>('all');   // 6개 카드 클릭 필터(고유 대상 분류)   // 거래처 '확인 필요' 관리자 결정(등록/수정/보류)
  // 거래처 대량등록 종류: 'business'(사업자 거래처/홈택스, 기본) | 'individual'(개인고객 명단 — 모든 행 INDIVIDUAL 처리)
  const [companyKind, setCompanyKind] = useState<'business' | 'individual'>('business');
  // 통번역사 기존 Master 보완(5단계): 필드별 선택 { "<masterId>:<field>": keep|apply|hold } + 드라이런 계획 결과.
  const [updateSel, setUpdateSel] = useState<Record<string, FieldDecision>>({});
  const [plan, setPlan] = useState<UpdatePlanResponse | null>(null);
  const [planning, setPlanning] = useState(false);
  // 통번역사 4단계 UX: ①업로드 ②분석결과 ③정보검토 ④최종등록. (타 엔티티는 단일 화면 유지)
  const isWizard = entity === 'translator';
  const [wizardStep, setWizardStep] = useState<1 | 2 | 3 | 4>(1);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [legacyOpen, setLegacyOpen] = useState(false);              // 통번역사: 구 분석·재구축·A/B/C·식별자 통계 '상세 분석 보기'(기본 접힘)            // 상세 매칭 통계·검증 보고서 접기/펼치기(요구사항3)
  const [reviewSearch, setReviewSearch] = useState('');             // 정보 검토 대상자 검색(요구사항4)
  const [reviewScope, setReviewScope] = useState<'all' | 'auto' | 'review'>('all');  // 검토 상태 필터
  const [reviewPageSize, setReviewPageSize] = useState<20 | 50 | 100>(20);
  const [reviewPage, setReviewPage] = useState(1);
  // 통번역사 Master 재구축 분석(읽기 전용) — 서버 암호화 스냅샷 재분석 결과. DB 미변경.
  const [rebuild, setRebuild] = useState<RebuildAnalysisResponse | null>(null);
  const [rebuilding, setRebuilding] = useState(false);
  const [snapshotDeleted, setSnapshotDeleted] = useState(false);
  // 재구축 실제 등록 실행 계획(드라이런) — 검증·예정 인원. DB 미변경(commit 전).
  const [execPlan, setExecPlan] = useState<RebuildExecuteResponse | null>(null);
  const [execPlanning, setExecPlanning] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const pickFile = (f: File | null) => {
    if (!f) return;
    const name = f.name.toLowerCase();
    if (!name.endsWith('.xls') && !name.endsWith('.xlsx')) {
      onToast('.xls 또는 .xlsx 파일만 업로드할 수 있습니다.');
      return;
    }
    setFile(f);
    setAnalysis(null);
    setResult(null);
  };

  // ── 초기화 ──
  // 현재 브라우저의 대량등록 작업 세션 상태만 비운다. 서버/DB 는 전혀 건드리지 않으며
  // (분석·미리보기는 조회 전용) 화면을 최초 진입 상태로 되돌린다. 동일 파일을 다시
  // 선택해도 재분석되도록 file input value 도 reset 한다. (요구사항: 거래처 대량등록 초기화)
  const resetSession = useCallback(() => {
    setFile(null);
    setAnalysis(null);
    setResult(null);
    setFilter('all');
    setReviewFilter('all');
    setMode('new_only');
    setCompanyKind('business');
    setUpdateSel({});
    setPlan(null);
    setWizardStep(1);
    setDetailsOpen(false);
    setReviewSearch('');
    setReviewScope('all');
    setReviewPage(1);
    setRebuild(null);
    setExecPlan(null);
    setSnapshotDeleted(false);
    setDragOver(false);
    if (inputRef.current) inputRef.current.value = '';
    onToast('업로드한 파일과 분석 결과를 초기화했습니다.');
  }, [onToast]);

  const doAnalyze = useCallback(async () => {
    if (!file) return;
    setAnalyzing(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      // 전용 개인고객 모드: 파일 거래처구분 컬럼 없이도 모든 행 INDIVIDUAL 로 처리하도록 서버에 알림.
      if (entity === 'company' && companyKind === 'individual') fd.append('importKind', 'individual');
      const res = await fetch(api(cfg.analyzeUrl), {
        method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: fd,
      });
      const data = await res.json();
      if (!res.ok) { onToast(`오류: ${data.error ?? '분석 실패'}`); return; }
      setAnalysis(data);
      setReviewDecisions({}); setCatFilter('all');
      setFilter('all');
      setRebuild(null);            // 새 분석 → 이전 재구축 결과 초기화
      setExecPlan(null);
      setSnapshotDeleted(false);
      if (entity === 'translator') setWizardStep(2);   // 분석 완료 → 2단계로 이동
    } catch {
      onToast('오류: 파일 분석 중 문제가 발생했습니다.');
    } finally {
      setAnalyzing(false);
    }
  }, [file, cfg.analyzeUrl, token, onToast, entity, companyKind]);

  const doExecute = useCallback(async () => {
    if (!file || !analysis) return;
    const newCount = safeNum(analysis.uniqueSummary?.counts.new ?? analysis.summary?.new);
    const updateCount = mode === 'update' ? safeNum(analysis.uniqueSummary?.counts.update ?? analysis.summary?.update) : 0;
    const decidedN = entity === 'company' ? Object.values(reviewDecisions).filter(v => v !== 'hold').length : 0;
    if (newCount === 0 && updateCount === 0 && decidedN === 0) { onToast('처리할 대상이 없습니다.'); return; }

    const parts = [`신규 ${newCount.toLocaleString()}${cfg.resultLabels.unit} 등록`];
    const decided = Object.values(reviewDecisions).filter(v => v !== 'hold').length;
    if (entity === 'company' && decided > 0) parts.push(`확인 필요 중 관리자 결정 ${decided}건(등록·수정) 반영`);
    if (updateCount > 0) parts.push(`기존 ${updateCount.toLocaleString()}건 업데이트`);
    if (!(await confirmDialog({ title: '대량등록 진행', message: `${parts.join(' · ')}을(를) 진행할까요?${updateCount > 0 ? '\n\n기존 데이터의 허용 필드(연락처·등록일 등)가 엑셀 값으로 수정됩니다. ID·연결관계는 유지됩니다.' : ''}`, confirmLabel: '진행', variant: 'warning' }))) return;

    setExecuting(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('mode', mode);
      if (analysis.planToken) fd.append('planToken', analysis.planToken);   // 미리보기와 같은 기준일 때만 서버가 반영
      if (entity === 'company') fd.append('reviewDecisions', JSON.stringify(Object.fromEntries(Object.entries(reviewDecisions).filter(([, v]) => v !== 'hold'))));
      if (entity === 'company' && companyKind === 'individual') fd.append('importKind', 'individual');
      const res = await fetch(api(cfg.executeUrl), {
        method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: fd,
      });
      const data = await res.json();
      if (!res.ok) { onToast(`오류: ${data.error ?? '등록 실패'}`); return; }
      setResult(data);
      const inserted = safeNum(data.inserted);
      const updatedN = safeNum(data.updated);
      const msg = updatedN > 0
        ? `신규 ${inserted.toLocaleString()}${cfg.resultLabels.unit} · 업데이트 ${updatedN.toLocaleString()}건 완료`
        : `${inserted.toLocaleString()}${cfg.resultLabels.unit} 등록 완료`;
      onToast(msg);
      onDone?.();
    } catch {
      onToast('오류: 일괄 등록 중 문제가 발생했습니다.');
    } finally {
      setExecuting(false);
    }
  }, [file, analysis, mode, cfg.executeUrl, cfg.resultLabels.unit, token, onToast, onDone, entity, companyKind, reviewDecisions]);

  // 기존 Master 보완 — 드라이런 계획 생성(DB 미반영). 현재 필드별 선택을 서버에 전달해 반영될 내용을 계산.
  const runUpdatePlan = useCallback(async () => {
    if (!file) return;
    setPlanning(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('selections', JSON.stringify(updateSel));
      const res = await fetch(api('/api/admin/translators/bulk-import/update-plan'), {
        method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: fd,
      });
      const data = await res.json();
      if (!res.ok) { onToast(`오류: ${data.error ?? '계획 생성 실패'}`); return; }
      setPlan(data);
      onToast('드라이런 계획을 생성했습니다. (DB 미반영)');
    } catch {
      onToast('오류: 업데이트 계획 생성 중 문제가 발생했습니다.');
    } finally {
      setPlanning(false);
    }
  }, [file, updateSel, token, onToast]);

  // ── Master 재구축 분석(읽기 전용) ──
  // 서버에 암호화 저장된 업로드 원본(snapshotId)을 서버가 다시 읽어 CRM 명부↔진행관리표를 대조한다.
  // DB·Master·이관 매핑을 전혀 변경하지 않으며(dryRun), 주민번호 원문은 응답·로그에 들어오지 않는다(건수만).
  const doRebuildAnalysis = useCallback(async () => {
    const sid = analysis?.snapshotId;
    if (!sid) { onToast('저장된 업로드 원본이 없습니다. 파일을 다시 업로드해 분석해주세요.'); return; }
    setRebuilding(true);
    try {
      const res = await fetch(api(`/api/admin/translators/bulk-import/snapshots/${sid}/rebuild-analysis`), {
        method: 'POST', headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      if (!res.ok) { onToast(`오류: ${data.error ?? '재구축 분석 실패'}`); return; }
      setRebuild(data);
      setExecPlan(null);
      onToast('Master 재구축 분석을 완료했습니다. (읽기 전용 · DB 미변경)');
    } catch {
      onToast('오류: 재구축 분석 중 문제가 발생했습니다.');
    } finally {
      setRebuilding(false);
    }
  }, [analysis?.snapshotId, token, onToast]);

  // 재구축 실제 등록 실행 계획·검증(드라이런) — commit 미포함. DB 미변경.
  const doRebuildExecutePlan = useCallback(async () => {
    const sid = analysis?.snapshotId;
    if (!sid) { onToast('저장된 업로드 원본이 없습니다. 파일을 다시 업로드해 분석해주세요.'); return; }
    setExecPlanning(true);
    try {
      const res = await fetch(api(`/api/admin/translators/bulk-import/snapshots/${sid}/rebuild-execute`), {
        method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ commit: false }),
      });
      const data = await res.json();
      if (!res.ok) { onToast(`오류: ${data.error ?? '실행 계획 검증 실패'}`); return; }
      setExecPlan(data);
      onToast('실제 등록 실행 계획을 검증했습니다. (드라이런 · DB 미변경)');
    } catch {
      onToast('오류: 실행 계획 검증 중 문제가 발생했습니다.');
    } finally {
      setExecPlanning(false);
    }
  }, [analysis?.snapshotId, token, onToast]);

  // 저장된 암호화 원본 파기(작업 종료 시). 메타·암호문 파일을 서버에서 삭제한다.
  const doDeleteSnapshot = useCallback(async () => {
    const sid = analysis?.snapshotId;
    if (!sid) return;
    if (!(await confirmDialog({ title: '저장된 업로드 원본 파기', message: '서버에 암호화 보관된 업로드 원본을 삭제합니다.\n삭제 후에는 재분석을 하려면 파일을 다시 업로드해야 합니다.', confirmLabel: '파기', variant: 'warning' }))) return;
    try {
      const res = await fetch(api(`/api/admin/translators/bulk-import/snapshots/${sid}`), {
        method: 'DELETE', headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      if (!res.ok) { onToast(`오류: ${data.error ?? '삭제 실패'}`); return; }
      setSnapshotDeleted(true);
      setRebuild(null);
      onToast(data.deleted ? '저장된 업로드 원본을 파기했습니다.' : '이미 파기되었거나 찾을 수 없습니다.');
    } catch {
      onToast('오류: 원본 파기 중 문제가 발생했습니다.');
    }
  }, [analysis?.snapshotId, token, onToast]);

  const allRows = Array.isArray(analysis?.rows) ? analysis!.rows : [];
  const statusFiltered = catFilter !== 'all'
    ? allRows.filter(r => (r as any).category === catFilter)
    : filter === 'all'
    ? allRows
    : filter === 'warning'
      ? allRows.filter(r => !!r.warning)
      : allRows.filter(r => r.status === filter);
  const filteredRows = reviewFilter === 'all'
    ? statusFiltered
    : statusFiltered.filter(r => r.reviewCategory === reviewFilter);
  const shownRows = filteredRows.slice(0, catFilter !== 'all' ? 3000 : MAX_PREVIEW_ROWS);
  // 등록 제외 사유별 건수(행 기준, 실제 판정 사유)
  const excludedReasonCounts = catFilter === 'excluded'
    ? Object.entries(filteredRows.reduce((m: Record<string, number>, r) => { const k = String(r.reason ?? '사유 없음').replace(/\s*\(.*$/, ''); m[k] = (m[k] ?? 0) + 1; return m; }, {})).sort((a, b) => b[1] - a[1])
    : [];

  // ── 기존 Master 보완 대상(동일인 확정 — update/conflict + rrn/email/phone 매칭) ──
  const eligibleUpdateRows = entity === 'translator'
    ? allRows.filter(r => (r.status === 'update' || r.status === 'conflict') && r.existingId != null
        && (r.matchMethod === 'rrn' || r.matchMethod === 'email' || r.matchMethod === 'phone'))
    : [];
  // 기본 결정(요구사항 규칙): 주민번호 일치 + (공란 보완 | 임시이메일 교체) → 적용, 그 외 → 보류.
  const defaultDecisionFor = (r: AnalyzedRow, field: string, ch: FieldChange): FieldDecision => {
    const cat = feFieldCategory(field, ch.old, ch.new);
    return (r.matchMethod === 'rrn' && FE_AUTO_CATEGORIES.has(cat)) ? 'apply' : 'hold';
  };
  const decisionFor = (r: AnalyzedRow, field: string, ch: FieldChange): FieldDecision =>
    updateSel[`${r.existingId}:${field}`] ?? defaultDecisionFor(r, field, ch);
  const setDecision = (id: number, field: string, d: FieldDecision) =>
    setUpdateSel(prev => ({ ...prev, [`${id}:${field}`]: d }));

  // ── 정보 검토(3단계): 검색·상태필터·페이지네이션·검토 완료 집계(요구사항4) ──
  const rowHasReview = (r: AnalyzedRow): boolean =>
    Object.entries(r.changes ?? {}).some(([f, ch]) =>
      !(r.matchMethod === 'rrn' && FE_AUTO_CATEGORIES.has(feFieldCategory(f, ch.old, ch.new))));
  const rowReviewDone = (r: AnalyzedRow): boolean => {
    const reviewFields = Object.entries(r.changes ?? {}).filter(([f, ch]) =>
      !(r.matchMethod === 'rrn' && FE_AUTO_CATEGORIES.has(feFieldCategory(f, ch.old, ch.new))));
    if (reviewFields.length === 0) return true;   // 자동 전용 → 검토 불필요(완료)
    return reviewFields.every(([f]) => updateSel[`${r.existingId}:${f}`] !== undefined);
  };
  const reviewMatches = (r: AnalyzedRow): boolean => {
    const q = reviewSearch.trim().toLowerCase();
    if (q && !`${r.name ?? ''} ${r.email ?? ''} ${r.existingId ?? ''}`.toLowerCase().includes(q)) return false;
    if (reviewScope === 'auto') return !rowHasReview(r);
    if (reviewScope === 'review') return rowHasReview(r);
    return true;
  };
  const reviewFilteredRows = eligibleUpdateRows.filter(reviewMatches);
  const reviewTotalPages = Math.max(1, Math.ceil(reviewFilteredRows.length / reviewPageSize));
  const reviewPageClamped = Math.min(reviewPage, reviewTotalPages);
  const reviewPageRows = reviewFilteredRows.slice((reviewPageClamped - 1) * reviewPageSize, reviewPageClamped * reviewPageSize);
  const reviewDoneCount = eligibleUpdateRows.filter(rowReviewDone).length;
  const reviewPendingCount = eligibleUpdateRows.length - reviewDoneCount;
  // 일괄 선택(동일 처리 기준): 현재 페이지 / 전체 필터 대상의 모든 변경 필드에 결정 적용.
  const bulkSetDecision = (d: FieldDecision, scope: 'page' | 'all') => {
    const rows = scope === 'page' ? reviewPageRows : reviewFilteredRows;
    setUpdateSel(prev => {
      const next = { ...prev };
      for (const r of rows) for (const f of Object.keys(r.changes ?? {})) next[`${r.existingId}:${f}`] = d;
      return next;
    });
  };

  // 4단계 가시성(통번역사만 단계 분리 · 타 엔티티는 전부 노출).
  const showStep2 = !isWizard || wizardStep === 2;
  const showStep3 = !isWizard || wizardStep === 3;
  const showStep4 = !isWizard || wizardStep === 4;

  // ── 미리보기 테이블 레이아웃(요구사항: 명시적 너비·정렬) ──
  // cfg.columns 에 width 가 지정되면 고정 레이아웃으로 렌더(현재 통번역사). 타 엔티티는 기존 auto 레이아웃 유지.
  const useFixedLayout = cfg.columns.some(c => c.width != null);
  const STATUS_COL_W = 110;   // 상태(중앙)
  const REASON_COL_W = 300;   // 사유(좌측, 최소 너비)
  const tableMinWidth = useFixedLayout
    ? STATUS_COL_W + cfg.columns.reduce((s, c) => s + (c.width ?? 120), 0) + REASON_COL_W
    : 720;

  const newCount = safeNum(analysis?.summary?.new);
  const updateCount = safeNum(analysis?.summary?.update);
  const decidedReview = entity === 'company' ? Object.values(reviewDecisions).filter(v => v !== 'hold').length : 0;
  const execDisabled = executing || (newCount === 0 && decidedReview === 0 && (mode !== 'update' || updateCount === 0));
  const execLabel = mode === 'update' && updateCount > 0
    ? `신규 ${newCount.toLocaleString()}${cfg.resultLabels.unit} 등록 · 기존 ${updateCount.toLocaleString()}건 업데이트`
    : `신규 ${newCount.toLocaleString()}${cfg.resultLabels.unit} 등록`;

  return (
    <div>
      {/* ── 헤더 ── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
        <BackToListButton onClick={onClose} variant="subtle" label="뒤로가기" testId="bulk-import-back" />
        <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700, color: '#111827' }}>{cfg.title}</h2>
      </div>

      {/* ── 4단계 네비게이션(통번역사 전용) ── */}
      {isWizard && !result && (
        <div style={{ display: 'flex', gap: 6, marginBottom: 16 }}>
          {([[1, '① 파일 업로드'], [2, '② 분석 결과'], [3, '③ 정보 검토'], [4, '④ 최종 등록']] as const).map(([s, label]) => {
            const reachable = s === 1 || !!analysis;
            const active = wizardStep === s;
            return (
              <button key={s} type="button" disabled={!reachable}
                onClick={() => reachable && setWizardStep(s)}
                data-testid={`wizard-step-${s}`} aria-label={label} aria-current={active}
                style={{
                  flex: 1, padding: '8px 10px', borderRadius: 8, fontSize: 13, fontWeight: active ? 700 : 500,
                  cursor: reachable ? 'pointer' : 'not-allowed',
                  border: `1px solid ${active ? '#0284c7' : '#e5e7eb'}`,
                  background: active ? '#e0f2fe' : (reachable ? '#fff' : '#f9fafb'),
                  color: active ? '#0369a1' : (reachable ? '#374151' : '#cbd5e1'),
                }}>
                {label}
              </button>
            );
          })}
        </div>
      )}

      {/* ── 결과 화면 ── */}
      {result ? (
        <Card style={{ padding: 24 }}>
          <div style={{ fontSize: 16, fontWeight: 700, color: '#047857', marginBottom: 16 }}>✓ 처리 완료</div>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 20 }}>
            <SummaryCard label={cfg.resultLabels.new} value={result.inserted} tone="green" />
            <SummaryCard label="기존 데이터 업데이트" value={result.updated} tone="blue" />
            <SummaryCard label="경고" value={result.summary?.warning} tone="amber" />
            <SummaryCard label="기존 데이터 동일" value={result.summary?.identical} tone="gray" />
            <SummaryCard label="중복 검토 필요" value={result.summary?.needsReview} tone="amber" />
            <SummaryCard label="파일 내부 중복" value={result.summary?.duplicateFile} tone="amber" />
            <SummaryCard label="오류" value={result.summary?.error} tone="red" />
          </div>
          <div style={{ display: 'flex', gap: 10 }}>
            <PrimaryBtn onClick={onClose} data-testid="bulk-import-finish" aria-label="완료">완료</PrimaryBtn>
            <GhostBtn onClick={() => { setFile(null); setAnalysis(null); setResult(null); if (inputRef.current) inputRef.current.value = ''; }}
              data-testid="bulk-import-again" aria-label="다른 파일 등록">다른 파일 등록</GhostBtn>
          </div>
        </Card>
      ) : (
        <>
          {/* ── 단계 1: 파일 업로드 ── */}
          {(!isWizard || wizardStep === 1) && (
          <Card style={{ padding: 20, marginBottom: 16 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 4 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: '#374151' }}>1. 파일 업로드</div>
              <GhostBtn onClick={() => { (entity === 'company' ? downloadCompanyTemplate : entity === 'translator' ? downloadTranslatorTemplate : entity === 'quote' ? downloadQuoteTemplate : downloadContactTemplate)(); onToast('대량등록 템플릿을 다운로드했습니다.'); }}
                style={{ fontSize: 12, padding: '6px 12px' }}
                data-testid="bulk-import-template-download" aria-label="대량등록 템플릿 다운로드">
                ⬇ 템플릿 다운로드
              </GhostBtn>
            </div>
            <p style={{ fontSize: 12, color: '#9ca3af', margin: '0 0 12px' }}>
              {entity === 'company'
                ? '템플릿을 내려받아 작성하거나, 홈택스 거래처목록 등 기존 엑셀 파일(.xls, .xlsx)을 그대로 업로드하세요.'
                : entity === 'translator'
                  ? '템플릿을 내려받아 작성한 뒤 엑셀 파일(.xls, .xlsx)을 업로드하세요.'
                  : entity === 'quote'
                    ? '템플릿(견적등록 + 견적품목 2시트)을 내려받아 작성한 뒤 업로드하세요.'
                    : '홈택스에서 내려받은 거래처목록 엑셀 파일(.xls, .xlsx)을 업로드하세요.'} {cfg.defaultsNote}
            </p>

            {/* 거래처 대량등록 종류 선택 — 개인고객 명단은 사업자번호 없이 이름+연락처로 관리(전용 모드). */}
            {entity === 'company' && (
              <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
                {([
                  ['business', '사업자 거래처', '기업·공공기관·홈택스 거래처목록. 사업자등록번호 기준으로 중복을 판정합니다.'],
                  ['individual', '개인고객 명단', '사업자등록번호 없는 개인고객. 모든 행을 개인고객으로 등록하고, 이름이 같아도 휴대폰·이메일이 다르면 동명이인으로 등록합니다.'],
                ] as const).map(([val, label, desc]) => {
                  const active = companyKind === val;
                  return (
                    <label key={val} data-testid={`bulk-import-companykind-${val}`}
                      style={{
                        flex: '1 1 280px', cursor: 'pointer', display: 'flex', gap: 10, alignItems: 'flex-start',
                        padding: '10px 12px', borderRadius: 8,
                        border: active ? '1.5px solid #c2410c' : '1px solid #e5e7eb',
                        background: active ? '#fff7ed' : '#fff',
                      }}>
                      <input type="radio" name="bulk-import-companykind" value={val} checked={active}
                        onChange={() => { setCompanyKind(val); setAnalysis(null); setResult(null); }}
                        aria-label={label} style={{ marginTop: 2 }} />
                      <span>
                        <span style={{ display: 'block', fontSize: 12.5, fontWeight: 700, color: active ? '#c2410c' : '#374151' }}>{label}</span>
                        <span style={{ display: 'block', fontSize: 11, color: '#6b7280', marginTop: 2 }}>{desc}</span>
                      </span>
                    </label>
                  );
                })}
              </div>
            )}

            <div
              onDragOver={e => { e.preventDefault(); setDragOver(true); }}
              onDragEnter={e => { e.preventDefault(); setDragOver(true); }}
              onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOver(false); }}
              onDrop={e => { e.preventDefault(); setDragOver(false); pickFile(e.dataTransfer.files?.[0] ?? null); }}
              style={{
                border: dragOver ? '2px dashed #0284c7' : '1.5px dashed #cbd5e1',
                background: dragOver ? '#e0f2fe' : '#f8fafc',
                borderRadius: 12, padding: '28px 20px', textAlign: 'center', transition: 'all .12s',
              }}
            >
              {file ? (
                <div style={{ fontSize: 13, color: '#0284c7', fontWeight: 600 }}>
                  ✓ {file.name} <span style={{ color: '#94a3b8', fontWeight: 400 }}>({(file.size / 1024).toFixed(0)} KB)</span>
                </div>
              ) : (
                <div style={{ fontSize: 13, color: '#94a3b8' }}>{dragOver ? '파일을 여기에 놓으세요' : '파일을 드래그하거나 아래 버튼으로 선택하세요'}</div>
              )}
              <div style={{ marginTop: 12, display: 'flex', gap: 8, justifyContent: 'center' }}>
                <label style={{ cursor: 'pointer', display: 'inline-block' }}>
                  <span style={{ fontSize: 12, padding: '6px 14px', borderRadius: 8, background: '#0284c7', color: '#fff', fontWeight: 600 }}>
                    {file ? '파일 교체' : '파일 선택'}
                  </span>
                  <input ref={inputRef} type="file" accept=".xls,.xlsx" style={{ display: 'none' }}
                    data-testid="bulk-import-file-input" aria-label="엑셀 파일 선택"
                    onChange={e => { const f = e.target.files?.[0] ?? null; pickFile(f); }} />
                </label>
                {(file || analysis) && (
                  <GhostBtn onClick={resetSession} disabled={analyzing || executing}
                    style={{ fontSize: 12, padding: '6px 14px' }}
                    data-testid="bulk-import-reset" aria-label="초기화">
                    초기화
                  </GhostBtn>
                )}
                <PrimaryBtn onClick={doAnalyze} disabled={!file || analyzing}
                  style={{ fontSize: 12, padding: '6px 16px' }}
                  data-testid="bulk-import-analyze" aria-label="파일 분석">
                  {analyzing ? '분석 중...' : '파일 분석'}
                </PrimaryBtn>
              </div>
            </div>
          </Card>
          )}

          {/* 분석 파일명 요약(2~4단계 공통, 통번역사) */}
          {isWizard && analysis && wizardStep !== 1 && (
            <div style={{ fontSize: 12, color: '#6b7280', margin: '0 0 12px' }}>분석 파일: <b>{analysis.fileName || file?.name || '-'}</b></div>
          )}

          {/* ── 단계 2 & 3: 분석 결과 + 미리보기 ── */}
          {analysis && (
            <Card style={{ padding: 20, marginBottom: 16 }}>
              {showStep2 && (<>
              <div style={{ fontSize: 13, fontWeight: 600, color: '#374151', marginBottom: 10 }}>2. 파일 분석 결과</div>
              <div style={{ fontSize: 11, color: '#9ca3af', marginBottom: 12 }}>
                시트: <b>{analysis.sheetName || '-'}</b> · 헤더 {safeNum(analysis.headerRowIndex) + 1}행 감지 · 매핑된 컬럼:{' '}
                {Object.entries(analysis.columnMap ?? {}).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`).join(', ') || '없음'}
              </div>
              {/* 통번역사: 최신 통합 판정(실행과 동일)만 메인에 표시 */}
              {isWizard && <TranslatorImportApprovalPanel token={token} snapshotId={analysis?.snapshotId} onToast={onToast} mode="summary" />}
              {isWizard && (
                <button onClick={() => setLegacyOpen(v => !v)} data-testid="bulk-import-legacy-toggle" aria-expanded={legacyOpen} aria-label="상세 분석 보기"
                  style={{ fontSize: 12, fontWeight: 600, background: 'none', border: 'none', color: '#64748b', cursor: 'pointer', padding: '10px 0 4px' }}>
                  {legacyOpen ? '▾ 상세 분석 접기' : '▸ 상세 분석 보기 (구 분석 통계 · Master 재구축 분석 · 식별자 통계 — 참고용, 등록 기준 아님)'}
                </button>
              )}
              {(!isWizard || legacyOpen) && (<>
              {/* 통번역사: 핵심 3분류(기존 연결 / 신규 / 예외) 우선 표시(요구사항5). 상세는 접기. */}
              {entity === 'translator' && analysis.translatorDiagnostics ? (
                <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 16 }}>
                  <SummaryCard label="전체 행" value={analysis.summary?.total} tone="default" />
                  <SummaryCard label="기존 Master 연결(동일인)" value={analysis.translatorDiagnostics.linkedPersons} tone="blue" />
                  <SummaryCard label="└ 업데이트 가능" value={analysis.translatorDiagnostics.updatablePersons} tone="blue" />
                  <SummaryCard label="신규 등록 가능" value={analysis.translatorDiagnostics.newPersons} tone="green" />
                  <SummaryCard label="예외 검토" value={analysis.translatorDiagnostics.exceptionPersons} tone="amber" />
                  <SummaryCard label="오류" value={analysis.summary?.error} tone="red" />
                </div>
              ) : (<>
                {analysis.uniqueSummary && (
                  <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 8 }} data-testid="bulk-import-unique-summary">
                    {(() => {
                      const pick = (c: typeof catFilter) => () => { setCatFilter(catFilter === c ? 'all' : c); setFilter('all'); setReviewFilter('all'); setTimeout(() => document.getElementById('bulk-import-preview-table')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50); };
                      const u = analysis.uniqueSummary!;
                      return (<>
                        <SummaryCard label={`전체 고유 ${entity === 'contact' ? '담당자' : '거래처'}`} value={u.uniqueTotal} tone="default" active={catFilter === 'all'} onClick={pick('all')} />
                        <SummaryCard label="기존 동일" value={u.counts.same} tone="gray" active={catFilter === 'same'} onClick={pick('same')} />
                        <SummaryCard label="신규 등록" value={u.counts.new} tone="green" active={catFilter === 'new'} onClick={pick('new')} />
                        <SummaryCard label="정보 수정" value={u.counts.update} tone="blue" active={catFilter === 'update'} onClick={pick('update')} />
                        <SummaryCard label="확인 필요" value={u.counts.review} tone="amber" active={catFilter === 'review'} onClick={pick('review')} />
                        {entity === 'company' && <SummaryCard label="개인 고객 분리" value={u.counts.individual ?? 0} tone="gray" active={catFilter === 'individual'} onClick={pick('individual')} />}
                        <SummaryCard label="등록 제외" value={u.counts.excluded} tone="red" active={catFilter === 'excluded'} onClick={pick('excluded')} />
                      </>);
                    })()}
                  </div>
                )}
                {analysis.uniqueSummary && (
                  <button onClick={() => setRowStatsOpen(v => !v)} data-testid="bulk-import-rowstats-toggle" aria-expanded={rowStatsOpen} aria-label="상세 보기"
                    style={{ fontSize: 12, fontWeight: 600, background: 'none', border: 'none', color: '#64748b', cursor: 'pointer', padding: '0 0 10px' }}>
                    {rowStatsOpen ? '▾ 상세 접기' : `▸ 상세 보기 (엑셀 ${analysis.uniqueSummary.rows.toLocaleString()}행 기준 · 중복 행 ${analysis.uniqueSummary.duplicateRows.toLocaleString()} · 제외 사유)`}
                  </button>
                )}
                {analysis.uniqueSummary && rowStatsOpen && Object.keys(analysis.uniqueSummary.excludedReasons).length > 0 && (
                  <div style={{ fontSize: 12, color: '#475569', marginBottom: 10 }}>
                    등록 제외 사유(행): {Object.entries(analysis.uniqueSummary.excludedReasons).map(([k, v]) => `${({ A_no_name: 'A. 담당자 성명 없음', B_company_only: 'B. 거래처 정보만 있는 행', E_error: 'E. 형식 오류', individual: '개인 고객 분리' } as Record<string, string>)[k] ?? k} ${v.toLocaleString()}`).join(' · ')}
                  </div>
                )}
                {(!analysis.uniqueSummary || rowStatsOpen) && (
                <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 16 }}>
                  <SummaryCard label="전체 행" value={analysis.summary?.total} tone="default" />
                  <SummaryCard label="신규 등록 예정" value={analysis.summary?.new} tone="green" />
                  <SummaryCard label="경고" value={analysis.summary?.warning} tone="amber" />
                  <SummaryCard label="변경 예정" value={analysis.summary?.update} tone="blue" />
                  <SummaryCard label="기존 데이터 동일" value={analysis.summary?.identical} tone="gray" />
                  <SummaryCard label="중복 검토 필요" value={analysis.summary?.needsReview} tone="amber" />
                  <SummaryCard label="파일 내 중복" value={analysis.summary?.duplicateFile} tone="amber" />
                  <SummaryCard label="오류" value={analysis.summary?.error} tone="red" />
                </div>
                )}
              </>)}
              {(entity === 'company' || entity === 'contact') && (
                <div style={{ fontSize: 12, color: '#374151', background: '#f8fafc', border: '1px solid #eef2f7', borderRadius: 8, padding: '8px 12px', marginBottom: 12 }}>
                  등록 방식: <b>신규 등록 + 기존 정보 업데이트</b> — 신규만 새로 만들고, 기존 {entity === 'contact' ? '담당자' : '거래처'}는 ID를 유지한 채 변경된 항목만 수정합니다(빈 셀은 덮어쓰지 않음). 확인 필요·등록 제외는 반영하지 않습니다.
                </div>
              )}

              {/* ── 개인고객 진단(읽기전용) — 사업자번호 무관, 이름+연락처 기준(§11) ── */}
              {entity === 'company' && analysis.diagnostics && analysis.diagnostics.mode === 'individual' && (
                <div style={{ background: '#fff7ed', border: '1px solid #fed7aa', borderRadius: 10, padding: '12px 14px', marginBottom: 16 }}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: '#c2410c', marginBottom: 8 }}>
                    🔎 개인고객 기준 진단 (읽기전용 · 등록 안 함)
                  </div>
                  <div style={{ fontSize: 12.5, color: '#7c2d12', lineHeight: 1.9 }}>
                    <b>{safeNum(analysis.diagnostics.indivTotalRows).toLocaleString()}</b>행 →{' '}
                    <b style={{ color: '#c2410c' }}>{safeNum(analysis.diagnostics.indivUniqueCandidates).toLocaleString()}</b>명 unique 개인고객 후보
                    {' '}(신규등록 가능 <b>{safeNum(analysis.diagnostics.indivNewRegistrable).toLocaleString()}</b>)
                  </div>
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
                    {([
                      ['신규등록 가능', analysis.diagnostics.indivNewRegistrable],
                      ['파일 내 완전중복(제외)', analysis.diagnostics.indivFileExactDup],
                      ['동명이인 그룹(등록 가능)', analysis.diagnostics.indivHomonymGroups],
                      ['기존 개인고객과 완전동일(제외)', analysis.diagnostics.indivDbExactDup],
                      ['휴대전화 일치·이름 다름', analysis.diagnostics.indivPhoneOnly],
                      ['이메일 일치·이름 다름', analysis.diagnostics.indivEmailOnly],
                      ['오류', analysis.diagnostics.indivErrors],
                    ] as const).map(([label, val]) => (
                      <span key={label} style={{ fontSize: 11, padding: '3px 9px', borderRadius: 999, background: '#fff', border: '1px solid #fed7aa', color: '#9a3412' }}>
                        {label} <b style={{ color: '#7c2d12' }}>{safeNum(val).toLocaleString()}</b>
                      </span>
                    ))}
                  </div>
                  <div style={{ fontSize: 11, color: '#c2955b', marginTop: 8 }}>
                    ※ 개인고객은 이름이 같아도 동일인이 아닙니다(동명이인). 동일성은 이름+연락처로 판단하며, 애매하면 자동병합하지 않고 사람이 확인합니다. 이 통계는 분석 전용이며 DB를 변경하지 않습니다.
                  </div>
                </div>
              )}

              {/* ── 진단 통계(읽기전용, 사업자번호 grouping) — 거래처(사업자)만, 확정 등록과 무관 ── */}
              {entity === 'company' && analysis.diagnostics && analysis.diagnostics.mode !== 'individual' && (
                <div style={{ background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 10, padding: '12px 14px', marginBottom: 16 }}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: '#334155', marginBottom: 8 }}>
                    🔎 사업자번호 기준 진단 (읽기전용 · 등록 안 함)
                  </div>
                  <div style={{ fontSize: 12.5, color: '#334155', lineHeight: 1.9 }}>
                    <b>{safeNum(analysis.diagnostics.totalRows).toLocaleString()}</b>행 →{' '}
                    <b style={{ color: '#0369a1' }}>{safeNum(analysis.diagnostics.finalUniqueMasters).toLocaleString()}</b>개 unique 거래처
                    {' '}(신규 <b>{safeNum(analysis.diagnostics.newUniqueBiz).toLocaleString()}</b> · 기존일치 <b>{safeNum(analysis.diagnostics.dbBizExactMatchUnique).toLocaleString()}</b>)
                  </div>
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
                    {([
                      ['unique 사업자번호', analysis.diagnostics.uniqueBizGroups],
                      ['동일 사업자번호 그룹(≥2행)', analysis.diagnostics.dupGroupCount],
                      ['↑ 포함 행 수', analysis.diagnostics.dupGroupRowCount],
                      ['1행짜리 사업자', analysis.diagnostics.singleBizGroupCount],
                      ['전화 다른 그룹', analysis.diagnostics.groupsDiffPhone],
                      ['이메일 다른 그룹', analysis.diagnostics.groupsDiffEmail],
                      ['거래처명 충돌(검토)', analysis.diagnostics.reviewConflictGroups],
                      ['기존535 사업자번호 일치(unique)', analysis.diagnostics.dbBizExactMatchUnique],
                      ['사업자번호 없음(행)', analysis.diagnostics.rowsNoBiz],
                      ['형식오류(행)', analysis.diagnostics.rowsInvalidBiz],
                    ] as const).map(([label, val]) => (
                      <span key={label} style={{ fontSize: 11, padding: '3px 9px', borderRadius: 999, background: '#fff', border: '1px solid #e2e8f0', color: '#475569' }}>
                        {label} <b style={{ color: '#0f172a' }}>{safeNum(val).toLocaleString()}</b>
                      </span>
                    ))}
                  </div>
                  <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 8 }}>
                    ※ "중복 검토 필요"는 행(row) 수이며, 위 unique 거래처 수와 다릅니다. 이 통계는 분석 전용이며 DB를 변경하지 않습니다.
                  </div>
                </div>
              )}

              {/* 상세 매칭 통계·검증 보고서: 접기/펼치기(요구사항3) — 기본 접힘, 핵심 숫자만 상단에 노출 */}
              {entity === 'translator' && analysis.translatorDiagnostics && (
                <button type="button" onClick={() => setDetailsOpen(o => !o)}
                  data-testid="bulk-import-details-toggle" aria-expanded={detailsOpen}
                  style={{ fontSize: 12, padding: '6px 12px', borderRadius: 8, border: '1px solid #e5e7eb', background: '#fff', color: '#374151', cursor: 'pointer', marginBottom: 12, fontWeight: 600 }}>
                  {detailsOpen ? '▾ 상세 매칭 통계 · 검증 보고서 접기' : '▸ 상세 매칭 통계 · 검증 보고서 펼치기'}
                </button>
              )}
              {/* ── 상세 진단(읽기전용 · 미리보기 전용 · DB 변경 없음) — 단순화 기준 A~F(요구사항) ── */}
              {entity === 'translator' && analysis.translatorDiagnostics && detailsOpen && (() => {
                const d = analysis.translatorDiagnostics!;
                const rep = d.report;
                return (
                <div style={{ background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 10, padding: '12px 14px', marginBottom: 16 }}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: '#334155', marginBottom: 8 }}>🔎 매칭 진단 — 성명+식별정보 기준 (읽기전용)</div>
                  {rep && (
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(210px, 1fr))', gap: 8, marginBottom: 10 }}>
                      {([
                        ['A. 이름+주민/외국인번호 일치', rep.A_nameRrn],
                        ['B. 이름+실제이메일 일치', rep.B_nameEmail],
                        ['C. 이름+휴대폰 일치', rep.C_namePhone],
                        ['D. 기존 Master 업데이트 가능', rep.D_updatable],
                        ['E. 신규 등록 가능', rep.E_newRegistrable],
                        ['F. 예외 검토', rep.F_exception],
                        ['CRM 명부에 없는 기존 이관자', rep.legacyNotInFile],
                        ['기존 이관자 연결(파일 내)', d.legacyLinkedInFile],
                      ] as const).map(([label, val]) => (
                        <div key={label} style={{ fontSize: 12, color: '#0c4a6e', background: '#fff', border: '1px solid #e0f2fe', borderRadius: 8, padding: '7px 10px', display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                          <span>{label}</span><b>{safeNum(val).toLocaleString()}명</b>
                        </div>
                      ))}
                    </div>
                  )}
                  {/* 동일인 확정 후 실제 변경 필드별 건수 */}
                  {Object.keys(d.conflictFieldCounts ?? {}).length > 0 && (
                    <>
                      <div style={{ fontSize: 11.5, color: '#475569', margin: '4px 0 6px' }}>변경(업데이트 후보) 항목별 건수</div>
                      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                        {Object.entries(d.conflictFieldCounts).map(([field, val]) => (
                          <span key={field} style={{ fontSize: 11, padding: '3px 9px', borderRadius: 999, background: '#fff7ed', border: '1px solid #fed7aa', color: '#c2410c' }}>
                            {FIELD_LABELS[field] ?? field} <b style={{ color: '#9a3412' }}>{safeNum(val).toLocaleString()}</b>
                          </span>
                        ))}
                      </div>
                    </>
                  )}
                  {/* 공란 보완 항목별 건수 */}
                  {Object.keys(d.fillFieldCounts ?? {}).length > 0 && (
                    <>
                      <div style={{ fontSize: 11.5, color: '#475569', margin: '10px 0 6px' }}>공란 보완 항목별 건수(기존 Master 공란)</div>
                      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                        {Object.entries(d.fillFieldCounts).map(([field, val]) => (
                          <span key={field} style={{ fontSize: 11, padding: '3px 9px', borderRadius: 999, background: '#eff6ff', border: '1px solid #bfdbfe', color: '#1d4ed8' }}>
                            {FIELD_LABELS[field] ?? field} <b style={{ color: '#1e3a8a' }}>{safeNum(val).toLocaleString()}</b>
                          </span>
                        ))}
                      </div>
                    </>
                  )}
                  {Object.keys(d.errorBreakdown ?? {}).length > 0 && (
                    <>
                      <div style={{ fontSize: 11.5, color: '#475569', margin: '10px 0 6px' }}>오류 유형</div>
                      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                        {Object.entries(d.errorBreakdown).map(([reason, val]) => (
                          <span key={reason} style={{ fontSize: 11, padding: '3px 9px', borderRadius: 999, background: '#fef2f2', border: '1px solid #fecaca', color: '#b91c1c' }}>
                            {reason} <b>{safeNum(val).toLocaleString()}</b>
                          </span>
                        ))}
                      </div>
                    </>
                  )}
                  {rep?.reconciliation && (
                    <div style={{ fontSize: 11.5, marginTop: 10, color: rep.reconciliation.reconciled ? '#047857' : '#b91c1c', fontWeight: 600 }}>
                      {rep.reconciliation.reconciled ? '✓' : '✗'} 분류 합계 {safeNum(rep.reconciliation.bucketSum).toLocaleString()}행 = 전체 {safeNum(rep.reconciliation.rowsTotal).toLocaleString()}행
                    </div>
                  )}
                  <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 8 }}>
                    ※ 성명 + (주민/외국인번호 | 실제 이메일 | 휴대폰) 중 하나 일치 시 동일인 확정. 임시 이메일은 매칭 제외. 복수 Master·식별번호 모순·동명 미확정은 예외 검토. 주민번호 원문은 화면·로그 미노출. 분석 전용이며 DB·Master·이관 매핑을 변경하지 않습니다.
                  </div>
                </div>
                );
              })()}

              {/* ── Master 재구축 분석 (읽기 전용 · DB/Master/매핑 변경 없음) ── */}
              {entity === 'translator' && (
                <div style={{ background: '#f5f3ff', border: '1px solid #ddd6fe', borderRadius: 10, padding: '14px 16px', marginBottom: 16 }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
                    <div style={{ fontSize: 12.5, fontWeight: 700, color: '#5b21b6' }}>
                      🧩 Master 재구축 분석 (읽기 전용)
                    </div>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                      {analysis.snapshotId && !snapshotDeleted ? (
                        <span style={{ fontSize: 11, color: '#6d28d9', background: '#ede9fe', border: '1px solid #ddd6fe', borderRadius: 999, padding: '3px 9px' }}>
                          서버 암호화 보관됨 · ID {analysis.snapshotId.slice(0, 8)}…
                        </span>
                      ) : (
                        <span style={{ fontSize: 11, color: '#9ca3af', background: '#fff', border: '1px solid #e5e7eb', borderRadius: 999, padding: '3px 9px' }}>
                          {snapshotDeleted ? '원본 파기됨' : '저장된 원본 없음(재업로드 필요)'}
                        </span>
                      )}
                      <PrimaryBtn onClick={doRebuildAnalysis}
                        data-testid="rebuild-analysis-run" aria-label="Master 재구축 분석 실행"
                        disabled={rebuilding || !analysis.snapshotId || snapshotDeleted}>
                        {rebuilding ? '분석 중…' : '재구축 분석 실행'}
                      </PrimaryBtn>
                      {analysis.snapshotId && !snapshotDeleted && (
                        <GhostBtn onClick={doDeleteSnapshot} data-testid="rebuild-snapshot-delete" aria-label="저장된 업로드 원본 파기">원본 파기</GhostBtn>
                      )}
                    </div>
                  </div>
                  <div style={{ fontSize: 11, color: '#7c6fb3', marginTop: 8, lineHeight: 1.7 }}>
                    기준 — <b>A</b>: 진행관리표 수행이력 있음(주민번호 유무 무관) → 전원 등록 · <b>B</b>: 수행이력 없으나 주민번호 있음 → 등록 · <b>C</b>: 수행이력·주민번호 모두 없음 → 보류.
                    동일인 판별은 주민번호 우선 · 이메일/전화 보조, 이름만으로 동명이인을 자동 병합하지 않습니다. 기존 455/581/993 분류는 산정에 사용하지 않습니다.
                  </div>

                  {rebuild && (() => {
                    const c = rebuild.classification;
                    const pl = rebuild.progressLink;
                    return (
                      <div style={{ marginTop: 12 }}>
                        <div style={{ fontSize: 12, color: '#047857', fontWeight: 600, marginBottom: 10 }}>
                          ✓ 서버에서 원본 파일을 정상적으로 읽었습니다 — 시트 <b>{c.sheetName || '-'}</b> · 전체 {safeNum(c.crmTotalRows).toLocaleString()}행
                        </div>
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(230px, 1fr))', gap: 8 }}>
                          {([
                            ['CRM 명부 실제 고유 인원', c.crmUniquePersons, '#4c1d95', '#f5f3ff'],
                            ['A. 수행이력 있는 등록 대상', c.A_withHistory, '#047857', '#ecfdf5'],
                            ['B. 수행이력 없음·주민번호 있음', c.B_rrnNoHistory, '#047857', '#ecfdf5'],
                            ['C. 등록 보류(이력·주민번호 없음)', c.C_hold, '#b45309', '#fffbeb'],
                            ['최종 등록 대상 총인원(A+B)', c.registerTarget, '#5b21b6', '#ede9fe'],
                          ] as const).map(([label, val, color, bg]) => (
                            <div key={label} style={{ fontSize: 12, color, background: bg, border: `1px solid ${color}22`, borderRadius: 8, padding: '9px 11px', display: 'flex', justifyContent: 'space-between', gap: 8, fontWeight: 600 }}>
                              <span>{label}</span><b>{safeNum(val).toLocaleString()}명</b>
                            </div>
                          ))}
                        </div>

                        {/* 기존 Master 교차대조(요구사항5) — reuse + new + exception = 등록 대상(A+B) */}
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(230px, 1fr))', gap: 8, marginTop: 8 }}>
                          {([
                            ['기존 Master 재사용 예정', c.reuseExistingMaster, '#1d4ed8', '#eff6ff'],
                            ['└ 기존 Master 정보 보완 가능', c.masterSupplementable, '#0e7490', '#ecfeff'],
                            ['신규 Master 생성 예정', c.newMasterToCreate, '#047857', '#ecfdf5'],
                            ['동일인 확인 예외', c.identityException, '#b45309', '#fffbeb'],
                            ['CRM 미존재 · 기존 Master 보유', c.masterNotInCrm, '#6d28d9', '#f5f3ff'],
                            ['중복 Master 정리 예정(검증 후)', c.dupMasterCleanup, '#9f1239', '#fff1f2'],
                          ] as const).map(([label, val, color, bg]) => (
                            <div key={label} style={{ fontSize: 12, color, background: bg, border: `1px solid ${color}22`, borderRadius: 8, padding: '9px 11px', display: 'flex', justifyContent: 'space-between', gap: 8, fontWeight: 600 }}>
                              <span>{label}</span><b>{safeNum(val).toLocaleString()}명</b>
                            </div>
                          ))}
                        </div>
                        <div style={{ fontSize: 11.5, marginTop: 8, color: c.masterMatchReconciled ? '#047857' : '#b91c1c', fontWeight: 600 }}>
                          {c.masterMatchReconciled ? '✓' : '✗'} 재사용 {safeNum(c.reuseExistingMaster).toLocaleString()} + 신규 {safeNum(c.newMasterToCreate).toLocaleString()} + 예외 {safeNum(c.identityException).toLocaleString()} = 등록 대상 {safeNum(c.registerTarget).toLocaleString()}명 {c.masterMatchReconciled ? '일치' : '불일치(확인 필요)'}
                        </div>

                        {/* 동일인 확정 불가 인원 재분류 — 독립 신규 후보 vs 실제 수동(요구사항1~5) */}
                        {(() => {
                          const ex = c.exceptionAnalysis;
                          const br = ex.byReason;
                          const fd = c.finalDisposition;
                          return (
                            <div style={{ marginTop: 12, background: '#fff', border: '1px solid #fcd34d', borderRadius: 8, padding: '10px 12px' }}>
                              <div style={{ fontSize: 11.5, fontWeight: 700, color: '#92400e', marginBottom: 2 }}>동일인 확정 불가 {safeNum(ex.total).toLocaleString()}명 — 등록자격/식별 분리 재분류</div>
                              <div style={{ fontSize: 11, marginBottom: 8 }}>
                                <span style={{ color: '#047857' }}>독립 신규 등록 후보 <b>{safeNum(ex.newCandidate).toLocaleString()}명</b></span> · <span style={{ color: '#b45309' }}>실제 수동 확인 필요 <b>{safeNum(ex.manualReview).toLocaleString()}명</b></span>
                              </div>
                              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(270px, 1fr))', gap: 6 }}>
                                {([
                                  ['신규 후보 · 주민번호 보유·충돌 없음', br.rrnIndependentNew, '#047857', '#ecfdf5'],
                                  ['신규 후보 · 수행이력 확인·주민번호 없음(동명이인 가능)', br.historyIndependentNew, '#047857', '#ecfdf5'],
                                  ['수동 · 동일인 후보 복수', br.multiCandidate, '#b45309', '#fffbeb'],
                                  ['수동 · 식별정보 충돌(타 Master 보유)', br.idConflictOtherMaster, '#b45309', '#fffbeb'],
                                  ['수동 · 진행관리표↔CRM 주민번호 불일치', br.historyIdMismatch, '#b45309', '#fffbeb'],
                                  ['수동 · 동명 Master와 주민번호 불일치(귀화 확인)', br.rrnMismatchSameName, '#b45309', '#fffbeb'],
                                  ['수동 · 기타', br.other, '#6b7280', '#f9fafb'],
                                ] as const).map(([label, val, color, bg]) => (
                                  <div key={label} style={{ fontSize: 11, color, background: bg, border: `1px solid ${color}22`, borderRadius: 8, padding: '7px 9px', display: 'flex', justifyContent: 'space-between', gap: 8, fontWeight: 600 }}>
                                    <span>{label}</span><b>{safeNum(val).toLocaleString()}명</b>
                                  </div>
                                ))}
                              </div>
                              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
                                {([
                                  ['(진단) 주민번호 누락', ex.diagnostics.missingRrn],
                                  ['(진단) 이메일·휴대폰 모두 누락', ex.diagnostics.missingContact],
                                ] as const).map(([label, val]) => (
                                  <span key={label} style={{ fontSize: 10.5, padding: '2px 8px', borderRadius: 999, background: '#fff7ed', border: '1px solid #fed7aa', color: '#9a3412' }}>
                                    {label} <b>{safeNum(val).toLocaleString()}</b>
                                  </span>
                                ))}
                              </div>
                              <div style={{ fontSize: 11, marginTop: 8, color: ex.reconciled ? '#047857' : '#b91c1c', fontWeight: 600 }}>
                                {ex.reconciled ? '✓' : '✗'} 원인별 합계 = 미확정 {safeNum(ex.total).toLocaleString()}명 {ex.reconciled ? '일치' : '불일치(확인 필요)'}
                              </div>
                              {/* 최종 처리방향 합계 정합(요구사항6) */}
                              <div style={{ marginTop: 10, paddingTop: 8, borderTop: '1px dashed #fcd34d', display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 6 }}>
                                {([
                                  ['기존 Master 재사용', fd.reuseExisting, '#1d4ed8'],
                                  ['신규 등록 가능', fd.newCandidate, '#047857'],
                                  ['실제 수동 확인', fd.manualReview, '#b45309'],
                                  ['등록 제외', fd.excluded, '#9f1239'],
                                ] as const).map(([label, val, color]) => (
                                  <div key={label} style={{ fontSize: 11, color, fontWeight: 700, display: 'flex', justifyContent: 'space-between', gap: 6 }}>
                                    <span>{label}</span><b>{safeNum(val).toLocaleString()}명</b>
                                  </div>
                                ))}
                              </div>
                              <div style={{ fontSize: 11, marginTop: 6, color: fd.reconciled ? '#047857' : '#b91c1c', fontWeight: 600 }}>
                                {fd.reconciled ? '✓' : '✗'} 재사용 + 신규가능 + 수동 + 제외 = 고유 인원 {safeNum(fd.total).toLocaleString()}명 {fd.reconciled ? '일치' : '불일치(확인 필요)'}
                              </div>
                              <div style={{ fontSize: 10.5, marginTop: 6, color: '#9a3412' }}>
                                ※ 등록자격(A 주민번호 / B 수행이력 / C 제외)과 동일인 식별을 분리. 이름만 일치로는 기존 Master에 자동연결·병합하지 않음. 수동 확인은 복수후보·주민번호 충돌·식별정보 충돌 등 실제 중복위험만. 신규 후보는 기존 Master의 실명이메일·휴대폰·주민번호와 충돌 없음을 확인한 인원이며, 실제 등록은 승인 후.
                              </div>
                            </div>
                          );
                        })()}

                        {/* 진행관리표 미연결 그룹 대조 결과(요구사항2·5) */}
                        <div style={{ marginTop: 12, background: '#fff', border: '1px solid #e9d5ff', borderRadius: 8, padding: '10px 12px' }}>
                          <div style={{ fontSize: 11.5, fontWeight: 700, color: '#6b21a8', marginBottom: 6 }}>진행관리표 수행자 이름 그룹 대조 <span style={{ fontWeight: 500, color: '#9ca3af' }}>(이름 기준 그룹 1,366 ≠ 실인원 · 이름만 일치는 확정 아님)</span></div>
                          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                            {([
                              ['전체 이름 그룹', pl.groups],
                              ['확정 연결(기존 매핑)', pl.confirmed],
                              ['연결 후보(성명 매칭·확정 아님)', pl.candidate],
                              ['미연결 그룹', pl.unlinked],
                              ['└ 동일인 확인 예외(별도 목록)', pl.unresolvedException],
                            ] as const).map(([label, val]) => (
                              <span key={label} style={{ fontSize: 11, padding: '3px 9px', borderRadius: 999, background: '#faf5ff', border: '1px solid #e9d5ff', color: '#7e22ce' }}>
                                {label} <b style={{ color: '#581c87' }}>{safeNum(val).toLocaleString()}</b>
                              </span>
                            ))}
                          </div>
                        </div>

                        {/* 참고 통계(읽기 전용) */}
                        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10 }}>
                          {([
                            ['기존 통번역사 Master 총원', c.masterTotal],
                            ['고유 인원 중 주민번호 보유', c.uniqueWithRrn],
                            ['A 중 주민번호로 확정', c.A_confirmedByRrn],
                            ['A 중 이름만 일치(동명이인 확인)', c.A_byNameOnlyNeedsCheck],
                            ['동일 식별자 중복행(제외)', c.crmInternalDupById],
                            ['식별자 없는 동명(확인 필요)', c.crmSameNameNoIdentifier],
                            ['성명 누락 등 무효행', c.crmInvalidRows],
                          ] as const).map(([label, val]) => (
                            <span key={label} style={{ fontSize: 11, padding: '3px 9px', borderRadius: 999, background: '#fff', border: '1px solid #e5e7eb', color: '#475569' }}>
                              {label} <b style={{ color: '#1e293b' }}>{safeNum(val).toLocaleString()}</b>
                            </span>
                          ))}
                        </div>

                        <div style={{ fontSize: 11.5, marginTop: 10, color: c.reconciled ? '#047857' : '#b91c1c', fontWeight: 600 }}>
                          {c.reconciled ? '✓' : '✗'} 분류 합계 A+B+C = 고유 인원 {safeNum(c.crmUniquePersons).toLocaleString()}명 {c.reconciled ? '일치' : '불일치(확인 필요)'}
                        </div>
                        <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 8 }}>
                          ※ {rebuild.note}
                        </div>
                      </div>
                    );
                  })()}
                </div>
              )}

              {/* ── 등록 방식 선택: 거래처·담당자는 '신규 등록 + 기존 정보 업데이트'로 통일되어 숨김 ── */}
              {false && entity === 'company' && (
              <div style={{ background: '#f8fafc', border: '1px solid #eef2f7', borderRadius: 10, padding: '12px 14px', marginBottom: 16 }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 8 }}>등록 방식</div>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  {([
                    ['new_only', '신규만 등록', '기존 데이터는 변경하지 않습니다. (안전)'],
                    ['update', '신규 등록 + 기존 데이터 업데이트', '사업자번호/담당자 기준으로 기존 데이터를 엑셀 값으로 수정합니다.'],
                  ] as const).map(([val, label, desc]) => {
                    const active = mode === val;
                    return (
                      <label key={val} data-testid={`bulk-import-mode-${val}`}
                        style={{
                          flex: '1 1 260px', cursor: 'pointer', display: 'flex', gap: 10, alignItems: 'flex-start',
                          padding: '10px 12px', borderRadius: 8,
                          border: active ? '1.5px solid #0284c7' : '1px solid #e5e7eb',
                          background: active ? '#e0f2fe' : '#fff',
                        }}>
                        <input type="radio" name="bulk-import-mode" value={val} checked={active}
                          onChange={() => setMode(val)} aria-label={label}
                          style={{ marginTop: 2 }} />
                        <span>
                          <span style={{ display: 'block', fontSize: 12.5, fontWeight: 600, color: active ? '#0369a1' : '#374151' }}>{label}</span>
                          <span style={{ display: 'block', fontSize: 11, color: '#6b7280', marginTop: 2 }}>{desc}</span>
                        </span>
                      </label>
                    );
                  })}
                </div>
              </div>
              )}

              </>)}

              {/* 2단계 → 3단계 이동(통번역사) */}
              {isWizard && (
                <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 8 }}>
                  <PrimaryBtn onClick={() => setWizardStep(3)} data-testid="wizard-to-review" aria-label="정보 검토로 이동">정보 검토 →</PrimaryBtn>
                </div>
              )}
              </>)}

              {showStep3 && (<>
              <div style={{ fontSize: 13, fontWeight: 600, color: '#374151', marginBottom: 8 }}>{isWizard ? '3. 정보 검토 — 통합 판정' : '3. 미리보기'}</div>
              {isWizard && <TranslatorImportApprovalPanel token={token} snapshotId={analysis?.snapshotId} onToast={onToast} mode="review" />}
              {isWizard && (
                <button onClick={() => setLegacyOpen(v => !v)} data-testid="bulk-import-legacy-toggle" aria-expanded={legacyOpen} aria-label="상세 분석 보기"
                  style={{ fontSize: 12, fontWeight: 600, background: 'none', border: 'none', color: '#64748b', cursor: 'pointer', padding: '10px 0 4px' }}>
                  {legacyOpen ? '▾ 상세 분석 접기' : '▸ 상세 분석 보기 (구 분석 통계 · Master 재구축 분석 · 식별자 통계 — 참고용, 등록 기준 아님)'}
                </button>
              )}
              {(!isWizard || legacyOpen) && (<>

              {/* 상태 필터 */}
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
                {(([['all', '전체'], ['new', '신규 등록 예정'], ['warning', '경고'], ['update', entity === 'translator' ? '보완 가능' : '변경 예정'], ['identical', '기존 동일'], ...(entity === 'translator' ? [['conflict', '정보 충돌'] as const] : []), ['needs_review', '중복 검토'], ['duplicate_file', '파일 내 중복'], ['error', '오류']]) as ReadonlyArray<readonly [string, string]>).map(([k, label]) => (
                  <button key={k} onClick={() => setFilter(k as 'all' | RowStatus | 'warning')}
                    data-testid={`bulk-import-filter-${k}`} aria-label={`${label} 필터`}
                    style={{
                      fontSize: 11, padding: '4px 10px', borderRadius: 999, cursor: 'pointer',
                      border: filter === k ? '1px solid #0284c7' : '1px solid #e5e7eb',
                      background: filter === k ? '#e0f2fe' : '#fff', color: filter === k ? '#0369a1' : '#6b7280', fontWeight: 600,
                    }}>
                    {label}
                  </button>
                ))}
              </div>
              {/* 통번역사 검토 세분 필터(요구사항4) — 상태 필터와 함께(AND) 적용 */}
              {entity === 'translator' && (
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10, alignItems: 'center' }}>
                  <span style={{ fontSize: 11, color: '#9ca3af' }}>검토 세분:</span>
                  {(([['all', '전체'], ['same_person', '실제 동일인 후보'], ['homonym', '동명이인'], ['file_internal', 'CRM 내부 중복'], ['undecidable', '판단 불가'], ['legacy_no_email', '무이메일 이관대기'], ['excluded_master', '통합·제외 Master 일치']]) as ReadonlyArray<readonly [string, string]>).map(([k, label]) => (
                    <button key={k} onClick={() => setReviewFilter(k as 'all' | ReviewCat)}
                      data-testid={`bulk-import-review-filter-${k}`} aria-label={`검토 세분 ${label} 필터`}
                      style={{
                        fontSize: 11, padding: '4px 10px', borderRadius: 999, cursor: 'pointer',
                        border: reviewFilter === k ? '1px solid #b45309' : '1px solid #e5e7eb',
                        background: reviewFilter === k ? '#fffbeb' : '#fff', color: reviewFilter === k ? '#b45309' : '#6b7280', fontWeight: 600,
                      }}>
                      {label}
                    </button>
                  ))}
                </div>
              )}

              <div id="bulk-import-preview-table" />
              {catFilter !== 'all' && (
                <div style={{ fontSize: 12, color: '#374151', margin: '4px 0 8px' }} data-testid="bulk-import-cat-filter-note">
                  <b>{({ same: '기존 동일', new: '신규 등록', update: '정보 수정', review: '확인 필요', individual: '개인 고객 분리', excluded: '등록 제외' } as Record<string, string>)[catFilter]}</b> 항목만 표시 중 — 엑셀 {filteredRows.length.toLocaleString()}행
                  <button onClick={() => setCatFilter('all')} data-testid="bulk-import-cat-filter-clear" aria-label="필터 해제" style={{ marginLeft: 8, fontSize: 11.5, border: '1px solid #d1d5db', background: '#fff', borderRadius: 6, padding: '2px 8px', cursor: 'pointer' }}>전체 보기</button>
                  {excludedReasonCounts.length > 0 && (
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 6 }} data-testid="bulk-import-excluded-reasons">
                      <span style={{ color: '#6b7280' }}>제외 사유별:</span>
                      {excludedReasonCounts.map(([k, v]) => <span key={k} style={{ padding: '2px 8px', borderRadius: 999, background: '#fef2f2', border: '1px solid #fecaca', color: '#991b1b' }}>{k} {v.toLocaleString()}</span>)}
                    </div>
                  )}
                </div>
              )}
              {entity === 'company' && catFilter === 'review' ? (
                <CompanyReviewList rows={allRows.filter(r => (r as any).category === 'review')} decisions={reviewDecisions}
                  onChange={(rn, d) => setReviewDecisions(prev => ({ ...prev, [String(rn)]: d }))} />
              ) : (
              <div style={{ overflowX: 'auto', maxHeight: 460, overflowY: 'auto', border: '1px solid #eef2f7', borderRadius: 10 }}>
                <table className="veritas-read-table" style={{ width: '100%', borderCollapse: 'collapse', minWidth: tableMinWidth, tableLayout: useFixedLayout ? 'fixed' : 'auto' }}>
                  {/* 고정 레이아웃: 컬럼 너비를 colgroup 으로 명시 관리(헤더·데이터 정렬 일치). */}
                  {useFixedLayout && (
                    <colgroup>
                      <col style={{ width: STATUS_COL_W }} />
                      {cfg.columns.map(c => <col key={c.key} style={{ width: c.width }} />)}
                      <col style={{ width: REASON_COL_W }} />
                    </colgroup>
                  )}
                  <thead style={{ position: 'sticky', top: 0, zIndex: 1 }}>
                    <tr>
                      <th style={{ ...tableTh, textAlign: useFixedLayout ? 'center' : 'left' }}>상태</th>
                      {cfg.columns.map(c => <th key={c.key} style={{ ...tableTh, textAlign: c.align ?? 'left' }}>{c.label}</th>)}
                      <th style={tableTh}>사유</th>
                    </tr>
                  </thead>
                  <tbody>
                    {shownRows.map((row, idx) => {
                      const meta = statusMeta(row.status);
                      // 셀 공통 말줄임(고정 레이아웃): 넘치면 ...(title 로 전체 확인). 컬럼별 ellipsis 플래그는 추가 강제.
                      // 고정 레이아웃에선 colgroup 너비가 셀 폭을 결정하므로 td 에 직접 ellipsis 적용.
                      const clip: React.CSSProperties = useFixedLayout
                        ? { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }
                        : {};
                      return (
                        <tr key={idx} style={{ background: row.status === 'conflict' ? '#fffaf6' : (row.status === 'update' ? '#fbfdff' : (row.status === 'new' ? '#fff' : '#fcfcfd')) }}>
                          <td style={{ ...tableTd, textAlign: useFixedLayout ? 'center' : 'left' }}>
                            <span style={{ fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 6, background: meta.bg, color: meta.color, border: `1px solid ${meta.border}`, whiteSpace: 'nowrap' }}>
                              {meta.label}
                            </span>
                          </td>
                          {cfg.columns.map(c => (
                            <td key={c.key} style={{ ...tableTd, textAlign: c.align ?? 'left', ...clip }} title={String(row[c.key] ?? '')}>
                              <CellValue row={row} colKey={c.key} />
                            </td>
                          ))}
                          {/* 사유: 한 줄 말줄임 + title 로 전체 확인(요구사항5). changeSummary 를 같은 줄에 이어 붙여 행 높이 통일. */}
                          <td
                            style={{ ...tableTd, color: row.status === 'error' ? '#b91c1c' : '#9ca3af', ...(useFixedLayout ? clip : { whiteSpace: 'normal' }) }}
                            title={[row.warning ? `⚠ ${row.warning}` : (row.reason ?? ''), row.changeSummary ?? ''].filter(Boolean).join(' · ')}
                          >
                            {row.warning
                              ? <span style={{ color: '#b45309', fontWeight: 600 }}>⚠ {row.warning}</span>
                              : (row.reason ?? '-')}
                            {/* 통번역사: 보완/충돌 필드 요약(컬럼에 없는 학력·전공·상세정보 등도 노출) — 승인 전 변경 대상 확인 */}
                            {row.changeSummary && (
                              <span style={{ marginLeft: 6, fontSize: 11, color: row.status === 'conflict' ? '#c2410c' : '#1d4ed8', fontWeight: 600 }}>
                                · {row.changeSummary}
                              </span>
                            )}
                            {/* 개인고객 중복 후보(거래처 개인고객 경로): 매칭된 기존 레코드를 함께 표시(§9) */}
                            {row.matchDetail && !useFixedLayout && (
                              <div style={{ marginTop: 4, fontSize: 11, color: '#6b7280', background: '#f9fafb', border: '1px solid #e5e7eb', borderRadius: 6, padding: '4px 8px' }}>
                                <span style={{ fontWeight: 700, color: '#374151' }}>#{row.matchDetail.id} {row.matchDetail.name}</span>
                                {' · '}이메일: {row.matchDetail.email || '-'}
                                {' · '}휴대전화: {row.matchDetail.phone || '-'}
                                {' · '}<span style={{ color: '#c2410c' }}>일치: {row.matchDetail.fields.join('·')}</span>
                              </div>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              )}
              {filteredRows.length > MAX_PREVIEW_ROWS && (
                <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 8 }}>
                  ※ 미리보기는 {MAX_PREVIEW_ROWS.toLocaleString()}행까지만 표시됩니다. 처리는 전체 대상에 적용됩니다.
                </div>
              )}

              {/* ── 기존 Master 상세정보 보완 승인(드라이런 · DB 미반영) — 통번역사 전용(5단계) ── */}
              {entity === 'translator' && eligibleUpdateRows.length > 0 && (
                <div style={{ marginTop: 20, background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 10, padding: '14px 16px' }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: '#92400e', marginBottom: 4 }}>
                    기존 Master 상세정보 보완 승인 (동일인 확정 {eligibleUpdateRows.length.toLocaleString()}건 · 드라이런)
                  </div>
                  <div style={{ fontSize: 11.5, color: '#b45309', marginBottom: 10 }}>
                    필드별로 <b>기존값 유지 / CRM값 적용 / 보류</b>를 선택하세요. 기본값 = 공란 보완은 '적용', 정보 충돌은 '유지'(안전).
                    동명이인·판단불가 대상은 보완 불가로 차단됩니다. 이 화면은 <b>DB를 변경하지 않습니다</b>.
                  </div>

                  {/* 검색 · 상태 필터 · 검토 완료 집계(요구사항4) */}
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 8 }}>
                    <input value={reviewSearch} onChange={e => { setReviewSearch(e.target.value); setReviewPage(1); }}
                      placeholder="성명·이메일·Master ID 검색" data-testid="review-search" aria-label="대상자 검색"
                      style={{ fontSize: 13, padding: '6px 10px', borderRadius: 8, border: '1px solid #e5e7eb', width: 220 }} />
                    {(['all', 'auto', 'review'] as const).map(s => (
                      <button key={s} type="button" onClick={() => { setReviewScope(s); setReviewPage(1); }}
                        data-testid={`review-scope-${s}`} aria-label={`검토 상태 ${s} 필터`}
                        style={{ fontSize: 11, padding: '4px 10px', borderRadius: 999, cursor: 'pointer',
                          border: reviewScope === s ? '1px solid #0284c7' : '1px solid #e5e7eb',
                          background: reviewScope === s ? '#e0f2fe' : '#fff', color: reviewScope === s ? '#0369a1' : '#6b7280', fontWeight: 600 }}>
                        {s === 'all' ? '전체' : s === 'auto' ? '자동 가능' : '검토 필요'}
                      </button>
                    ))}
                    <span style={{ marginLeft: 'auto', fontSize: 12, color: '#374151' }}>
                      검토 완료 <b style={{ color: '#047857' }}>{reviewDoneCount.toLocaleString()}</b> · 미완료 <b style={{ color: '#b45309' }}>{reviewPendingCount.toLocaleString()}</b> / {eligibleUpdateRows.length.toLocaleString()}명
                    </span>
                  </div>
                  {/* 동일 기준 일괄 선택(요구사항4) */}
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', marginBottom: 8 }}>
                    <span style={{ fontSize: 11, color: '#9ca3af' }}>일괄(현재 페이지):</span>
                    {(['keep', 'apply', 'hold'] as const).map(d => (
                      <button key={d} type="button" onClick={() => bulkSetDecision(d, 'page')}
                        data-testid={`review-bulk-page-${d}`} aria-label={`현재 페이지 일괄 ${d}`}
                        style={{ fontSize: 11, padding: '3px 10px', borderRadius: 6, cursor: 'pointer', border: '1px solid #e5e7eb', background: '#fff', color: '#374151', fontWeight: 600 }}>
                        {d === 'keep' ? '유지' : d === 'apply' ? '적용' : '보류'}
                      </button>
                    ))}
                    <span style={{ fontSize: 11, color: '#9ca3af', marginLeft: 8 }}>일괄(전체 {reviewFilteredRows.length.toLocaleString()}):</span>
                    {(['keep', 'apply', 'hold'] as const).map(d => (
                      <button key={d} type="button" onClick={() => bulkSetDecision(d, 'all')}
                        data-testid={`review-bulk-all-${d}`} aria-label={`전체 일괄 ${d}`}
                        style={{ fontSize: 11, padding: '3px 10px', borderRadius: 6, cursor: 'pointer', border: '1px solid #e5e7eb', background: '#fff', color: '#374151', fontWeight: 600 }}>
                        {d === 'keep' ? '유지' : d === 'apply' ? '적용' : '보류'}
                      </button>
                    ))}
                  </div>

                  <div style={{ maxHeight: 360, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {reviewPageRows.length === 0 && (
                      <div style={{ fontSize: 12, color: '#9ca3af', padding: '12px 0', textAlign: 'center' }}>검색·필터 조건에 맞는 대상이 없습니다.</div>
                    )}
                    {reviewPageRows.map((r, i) => (
                      <div key={`${r.existingId}-${i}`} style={{ background: '#fff', border: '1px solid #fde68a', borderRadius: 8, padding: '8px 10px' }}>
                        <div style={{ fontSize: 12, color: '#374151', marginBottom: 6, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                          <b>{String(r.name || '(이름없음)')}</b>
                          <span style={{ color: '#6b7280' }}>Master #{r.existingId}</span>
                          <span style={{ color: '#6b7280' }}>주민번호 {String(r.residentMasked ?? '-')}</span>
                          <span style={{ fontSize: 10, padding: '1px 6px', borderRadius: 5, background: '#eff6ff', color: '#1d4ed8', border: '1px solid #bfdbfe' }}>{r.matchMethod ?? '-'} 매칭</span>
                          {r.status === 'conflict' && <span style={{ fontSize: 10, padding: '1px 6px', borderRadius: 5, background: '#fff7ed', color: '#c2410c', border: '1px solid #fed7aa' }}>정보 충돌</span>}
                          {r.masterInactive && <span style={{ fontSize: 10, padding: '1px 6px', borderRadius: 5, background: '#f3f4f6', color: '#6b7280', border: '1px solid #e5e7eb' }}>비활성(자동 활성화 안 함)</span>}
                        </div>
                        {Object.entries(r.changes ?? {}).map(([field, ch]) => {
                          const d = decisionFor(r, field, ch);
                          const cat = feFieldCategory(field, ch.old, ch.new);
                          const autoCat = r.matchMethod === 'rrn' && FE_AUTO_CATEGORIES.has(cat);
                          return (
                            <div key={field} style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', padding: '3px 0', borderTop: '1px dashed #f3f4f6' }}>
                              <span style={{ fontSize: 11, fontWeight: 600, color: '#6b7280', minWidth: 64 }}>{FIELD_LABELS[field] ?? field}</span>
                              <span style={{ fontSize: 11, color: '#9ca3af', textDecoration: 'line-through' }}>{ch.old || '(없음)'}</span>
                              <span style={{ fontSize: 11, color: '#9ca3af' }}>→</span>
                              <span style={{ fontSize: 11, color: '#1d4ed8', fontWeight: 600 }}>{ch.new || '(없음)'}</span>
                              <span style={{ fontSize: 10, padding: '1px 6px', borderRadius: 5, border: `1px solid ${autoCat ? '#bbf7d0' : '#fde68a'}`, background: autoCat ? '#f0fdf4' : '#fffbeb', color: autoCat ? '#047857' : '#b45309' }}>
                                {CATEGORY_LABELS[cat]}{autoCat ? ' · 자동' : ' · 검토'}
                              </span>
                              <span style={{ marginLeft: 'auto', display: 'inline-flex', gap: 4 }}>
                                {(['keep', 'apply', 'hold'] as const).map(opt => (
                                  <button key={opt} type="button" onClick={() => setDecision(r.existingId as number, field, opt)}
                                    data-testid={`master-field-${r.existingId}-${field}-${opt}`}
                                    aria-label={`${FIELD_LABELS[field] ?? field} ${opt === 'keep' ? '기존값 유지' : opt === 'apply' ? 'CRM값 적용' : '보류'}`}
                                    style={{
                                      fontSize: 10.5, padding: '2px 8px', borderRadius: 6, cursor: 'pointer',
                                      border: d === opt ? '1px solid #0284c7' : '1px solid #e5e7eb',
                                      background: d === opt ? '#e0f2fe' : '#fff', color: d === opt ? '#0369a1' : '#6b7280', fontWeight: 600,
                                    }}>
                                    {opt === 'keep' ? '유지' : opt === 'apply' ? '적용' : '보류'}
                                  </button>
                                ))}
                              </span>
                            </div>
                          );
                        })}
                      </div>
                    ))}
                  </div>
                  {/* 페이지네이션(요구사항4): 페이지당 20/50/100 */}
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8, flexWrap: 'wrap' }}>
                    <GhostBtn onClick={() => setReviewPage(p => Math.max(1, p - 1))} disabled={reviewPageClamped <= 1} style={{ fontSize: 12, padding: '4px 10px' }} data-testid="review-prev-page" aria-label="이전 페이지">◂ 이전</GhostBtn>
                    <span style={{ fontSize: 12, color: '#6b7280' }}>{reviewPageClamped} / {reviewTotalPages} 페이지 ({reviewFilteredRows.length.toLocaleString()}명)</span>
                    <GhostBtn onClick={() => setReviewPage(p => Math.min(reviewTotalPages, p + 1))} disabled={reviewPageClamped >= reviewTotalPages} style={{ fontSize: 12, padding: '4px 10px' }} data-testid="review-next-page" aria-label="다음 페이지">다음 ▸</GhostBtn>
                    <span style={{ marginLeft: 12, fontSize: 11, color: '#9ca3af' }}>페이지당</span>
                    {([20, 50, 100] as const).map(n => (
                      <button key={n} type="button" onClick={() => { setReviewPageSize(n); setReviewPage(1); }} data-testid={`review-pagesize-${n}`} aria-label={`페이지당 ${n}명`}
                        style={{ fontSize: 11, padding: '3px 9px', borderRadius: 6, cursor: 'pointer', border: reviewPageSize === n ? '1px solid #0284c7' : '1px solid #e5e7eb', background: reviewPageSize === n ? '#e0f2fe' : '#fff', color: reviewPageSize === n ? '#0369a1' : '#6b7280', fontWeight: 600 }}>{n}</button>
                    ))}
                  </div>
                  <div style={{ marginTop: 12, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                    <PrimaryBtn onClick={runUpdatePlan} disabled={planning}
                      data-testid="master-update-plan-btn" aria-label="업데이트 계획 검증(미반영)">
                      {planning ? '검증 중...' : '업데이트 계획 검증 (미반영)'}
                    </PrimaryBtn>
                    <span style={{ fontSize: 11.5, color: '#92400e' }}>실제 반영은 다음 단계 최종 승인 후 진행됩니다. 이 버튼은 DB를 변경하지 않습니다.</span>
                  </div>

                  {/* 드라이런 결과 — 최종 검증 보고서 */}
                  {plan && plan.dryRun && (
                    <div style={{ marginTop: 12, background: '#fff', border: '1px solid #bae6fd', borderRadius: 8, padding: '12px 14px' }}>
                      <div style={{ fontSize: 12, fontWeight: 700, color: '#075985', marginBottom: 8 }}>
                        🧾 최종 검증 보고서 (미반영 · committed={String(plan.committed)})
                      </div>
                      {/* 주민번호 일치 대상 핵심 집계(요구사항) */}
                      {plan.rrnReport && (
                        <div style={{ marginBottom: 10 }}>
                          <div style={{ fontSize: 11.5, fontWeight: 700, color: '#0369a1', marginBottom: 6 }}>주민번호 13자리 일치 대상 {safeNum(plan.rrnReport.rrnSingleTotal).toLocaleString()}행</div>
                          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 8 }}>
                            {([
                              ['자동 업데이트 가능', plan.rrnReport.rrnAutoUpdatable, '#047857', '#f0fdf4', '#bbf7d0'],
                              ['추가 검토 필요', plan.rrnReport.rrnReviewNeeded, '#b45309', '#fffbeb', '#fde68a'],
                              ['변경 없음(이미 동일)', plan.rrnReport.rrnNoChange, '#6b7280', '#f3f4f6', '#e5e7eb'],
                              ['주민번호 중복(자동 금지)', plan.rrnReport.rrnMultiBlocked, '#b91c1c', '#fef2f2', '#fecaca'],
                            ] as const).map(([label, val, color, bg, border]) => (
                              <div key={label} style={{ fontSize: 12, color, background: bg, border: `1px solid ${border}`, borderRadius: 8, padding: '7px 10px', display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                                <span>{label}</span><b>{safeNum(val).toLocaleString()}</b>
                              </div>
                            ))}
                          </div>
                          <div style={{ fontSize: 11, marginTop: 6, color: plan.rrnReport.reconciled ? '#047857' : '#b91c1c', fontWeight: 600 }}>
                            {plan.rrnReport.reconciled ? '✓' : '✗'} 자동가능 + 검토필요 + 변경없음 = 주민번호 일치 {safeNum(plan.rrnReport.rrnSingleTotal).toLocaleString()}행
                          </div>
                        </div>
                      )}
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(190px, 1fr))', gap: 8, marginBottom: 8 }}>
                        {([
                          ['보완 대상 인원', plan.summary.personsToUpdate],
                          ['적용 예정 필드수', plan.summary.appliedFieldTotal],
                          ['동일인 확정 행', plan.summary.eligibleRows],
                          ['차단(동명이인·판단불가) 행', plan.summary.blockedRows],
                          ['비활성 인력 보완건(활성화 안 함)', plan.summary.inactiveWithApply],
                        ] as const).map(([label, val]) => (
                          <div key={label} style={{ fontSize: 12, color: '#0c4a6e', background: '#f0f9ff', border: '1px solid #e0f2fe', borderRadius: 8, padding: '7px 10px', display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                            <span>{label}</span><b>{safeNum(val).toLocaleString()}</b>
                          </div>
                        ))}
                      </div>
                      {Object.keys(plan.summary.applyFieldCounts ?? {}).length > 0 && (
                        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 6 }}>
                          <span style={{ fontSize: 11, color: '#475569' }}>적용 예정(필드별):</span>
                          {Object.entries(plan.summary.applyFieldCounts).map(([f, v]) => (
                            <span key={f} style={{ fontSize: 11, padding: '2px 8px', borderRadius: 999, background: '#eff6ff', border: '1px solid #bfdbfe', color: '#1d4ed8' }}>
                              {FIELD_LABELS[f] ?? f} <b>{safeNum(v).toLocaleString()}</b>
                            </span>
                          ))}
                        </div>
                      )}
                      <div style={{ fontSize: 11, color: '#94a3b8' }}>※ {plan.note}</div>
                    </div>
                  )}
                </div>
              )}

              </>)}

              {/* 3단계 내비게이션(통번역사) */}
              {isWizard && (
                <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 12 }}>
                  <GhostBtn onClick={() => setWizardStep(2)} data-testid="wizard-back-analysis" aria-label="분석 결과로">← 분석 결과</GhostBtn>
                  <PrimaryBtn onClick={() => setWizardStep(4)} data-testid="wizard-to-final" aria-label="최종 등록으로">최종 등록 →</PrimaryBtn>
                </div>
              )}
              </>)}

              {/* ── 단계 4: 최종 등록 ── */}
              {showStep4 && (<>
                {/* 통합 판정 · 대표 승인 등록(통번역사 실제 등록 유일 경로 — 일반/재구축 판정 기준 통합) */}
                {entity === 'translator' && <TranslatorImportApprovalPanel token={token} snapshotId={analysis?.snapshotId} onToast={onToast} mode="final" />}

              {/* ④ 최종 등록은 Master 재구축 기준(고유 2,019 / 등록 1,493 / 보류 526)으로 표시한다.
                  기존 대량등록(구 581명) 기준은 이 화면에서 사용하지 않는다(요구사항4·7). 재구축 분석 미실행 시 ② 단계로 안내. */}
              {SHOW_LEGACY_REBUILD_FINAL && isWizard && !rebuild && (
                <div style={{ marginBottom: 14, padding: '12px 14px', background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 8, fontSize: 12.5, color: '#92400e', lineHeight: 1.8 }}>
                  Master 재구축 최종 등록 기준을 표시하려면 <b>② 분석 결과</b> 단계에서 <b>‘재구축 분석 실행’</b>을 먼저 눌러주세요.
                  (이 화면은 기존 581명 기준을 사용하지 않습니다.)
                  <div style={{ marginTop: 10 }}>
                    <GhostBtn onClick={() => setWizardStep(2)} data-testid="wizard-to-rebuild" aria-label="분석 결과로 이동">② 분석 결과로 이동</GhostBtn>
                  </div>
                </div>
              )}
              {SHOW_LEGACY_REBUILD_FINAL && isWizard && rebuild && (() => {
                const c = rebuild.classification;
                const fd = c.finalDisposition;
                const pl = rebuild.progressLink;
                return (
                  <>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 10, marginBottom: 10 }}>
                    {([
                      ['CRM 고유 인원', fd.total, '#4c1d95', '#f5f3ff'],
                      ['기존 Master 재사용', fd.reuseExisting, '#1d4ed8', '#eff6ff'],
                      ['신규 Master 등록 가능', fd.newCandidate, '#047857', '#ecfdf5'],
                      ['실제 수동 확인 필요', fd.manualReview, '#b45309', '#fffbeb'],
                      ['등록 제외', fd.excluded, '#9f1239', '#fff1f2'],
                      ['진행관리표 연결 확정', pl.confirmed, '#7e22ce', '#faf5ff'],
                      ['진행관리표 연결 후보', pl.candidate, '#7e22ce', '#faf5ff'],
                      ['진행관리표 미연결', pl.unlinked, '#6b7280', '#f9fafb'],
                    ] as const).map(([label, val, color, bg]) => (
                      <div key={label} style={{ fontSize: 12, color, background: bg, border: `1px solid ${color}22`, borderRadius: 8, padding: '10px 12px', display: 'flex', justifyContent: 'space-between', gap: 8, fontWeight: 600 }}>
                        <span>{label}</span><b>{safeNum(val).toLocaleString()}{label.includes('진행관리표') ? '건' : '명'}</b>
                      </div>
                    ))}
                  </div>
                  <div style={{ fontSize: 11.5, marginBottom: 14, color: fd.reconciled ? '#047857' : '#b91c1c', fontWeight: 600 }}>
                    {fd.reconciled ? '✓' : '✗'} 재사용 {safeNum(fd.reuseExisting).toLocaleString()} + 신규가능 {safeNum(fd.newCandidate).toLocaleString()} + 수동 {safeNum(fd.manualReview).toLocaleString()} + 제외 {safeNum(fd.excluded).toLocaleString()} = 고유 {safeNum(fd.total).toLocaleString()}명 {fd.reconciled ? '일치' : '불일치(확인 필요)'} · <span style={{ color: '#6b21a8' }}>최신 재구축 기준</span>
                  </div>
                  </>
                );
              })()}
              {/* 변경 전후 요약 — 필드별 적용 예정(계획 검증 후) */}
              {SHOW_LEGACY_REBUILD_FINAL && isWizard && plan && Object.keys(plan.summary.applyFieldCounts ?? {}).length > 0 && (
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
                  <span style={{ fontSize: 11, color: '#475569' }}>필드별 변경 예정:</span>
                  {Object.entries(plan.summary.applyFieldCounts).map(([f, v]) => (
                    <span key={f} style={{ fontSize: 11, padding: '2px 8px', borderRadius: 999, background: '#eff6ff', border: '1px solid #bfdbfe', color: '#1d4ed8' }}>
                      {FIELD_LABELS[f] ?? f} <b>{safeNum(v).toLocaleString()}</b>
                    </span>
                  ))}
                </div>
              )}
              {SHOW_LEGACY_REBUILD_FINAL && isWizard && !plan && eligibleUpdateRows.length > 0 && (
                <div style={{ fontSize: 11.5, color: '#92400e', marginBottom: 12 }}>※ 기존 Master 보완의 변경 전후 요약을 보려면 ③ 정보 검토에서 '업데이트 계획 검증'을 먼저 실행하세요.</div>
              )}

              {/* 실행 영역 — 타 엔티티는 기존 실행 버튼 유지. 통번역사는 이번 단계 드라이런 전용(신규·업데이트 모두 별도 승인 후 실행, 요구사항6). */}
              {!isWizard ? (
                <div style={{ marginTop: 6, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                  <PrimaryBtn onClick={doExecute} disabled={execDisabled}
                    data-testid="bulk-import-execute" aria-label="등록 실행">
                    {executing ? '처리 중...' : execLabel}
                  </PrimaryBtn>
                  <span style={{ fontSize: 12, color: '#6b7280' }}>
                    {mode === 'update'
                      ? '기존 ID·연결관계는 유지되며 허용 필드만 수정됩니다. 동일·중복·오류 건은 저장되지 않습니다.'
                      : '기존 데이터는 변경되지 않습니다. 동일·중복·오류 건은 저장되지 않습니다.'}
                  </span>
                </div>
              ) : null}
              {!isWizard && (entity === 'company' || entity === 'contact') ? (
                <PartyImportBatches token={token} module={entity === 'contact' ? 'contact' : 'company'} onToast={onToast} refreshKey={result} />
              ) : !SHOW_LEGACY_REBUILD_FINAL ? null : (
                <div style={{ marginTop: 6 }}>
                  {!rebuild ? (
                    <div style={{ padding: '12px 14px', background: '#f8fafc', border: '1px dashed #cbd5e1', borderRadius: 8, fontSize: 12.5, color: '#475569', lineHeight: 1.8 }}>
                      ② 분석 결과 단계에서 <b>재구축 분석</b>을 실행하면 등록 대상·재사용·신규·정리 예정 인원이 이 화면에 표시됩니다. 실제 반영은 대표 승인 후 진행합니다.
                    </div>
                  ) : (<>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 10 }}>
                      <PrimaryBtn onClick={doRebuildExecutePlan} disabled={execPlanning}
                        data-testid="rebuild-execute-plan" aria-label="실제 등록 실행 계획 검증">
                        {execPlanning ? '검증 중...' : '실제 등록 실행 계획 검증 (드라이런)'}
                      </PrimaryBtn>
                      <span style={{ fontSize: 12, color: '#6b7280' }}>DB 미변경. 기존 ID 유지·UNIQUE 충돌·중복 생성·원본 보존을 사전 검증합니다.</span>
                    </div>
                    {execPlan && (() => {
                      const w = execPlan.willRegister; const v = execPlan.validation;
                      const blockers = v.emailCollision + v.rrnCollision;
                      return (
                        <div style={{ padding: '12px 14px', background: '#f8fafc', border: '1px solid #cbd5e1', borderRadius: 8 }}>
                          <div style={{ fontSize: 12, fontWeight: 700, color: '#334155', marginBottom: 8 }}>실제 등록 실행 계획 (검증 결과 · DB 미반영)</div>
                          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(190px, 1fr))', gap: 6, marginBottom: 8 }}>
                            {([
                              ['기존 Master 재사용(ID 유지·보완)', w.reuseExisting, '#1d4ed8'],
                              ['신규 Master 생성 가능', w.newCreate, '#047857'],
                              ['수동 확인 보류(등록 안 함)', w.manualHold, '#b45309'],
                              ['등록 제외(생성 안 함)', w.excluded, '#9f1239'],
                            ] as const).map(([label, val, color]) => (
                              <div key={label} style={{ fontSize: 11.5, color, fontWeight: 700, display: 'flex', justifyContent: 'space-between', gap: 6 }}>
                                <span>{label}</span><b>{safeNum(val).toLocaleString()}명</b>
                              </div>
                            ))}
                          </div>
                          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', fontSize: 11, marginBottom: 8 }}>
                            {([
                              ['실행 전 인원', execPlan.beforeCount],
                              ['예상 실행 후', execPlan.projectedAfter],
                              ['이메일 UNIQUE 충돌', v.emailCollision],
                              ['주민번호 UNIQUE 충돌', v.rrnCollision],
                              ['파일내부 중복 차단', v.fileDupBlocked],
                              ['최종 정리 대상(삭제 안 함)', v.cleanupCandidates],
                            ] as const).map(([label, val]) => (
                              <span key={label} style={{ padding: '2px 8px', borderRadius: 999, background: '#fff', border: '1px solid #e5e7eb', color: '#475569' }}>
                                {label} <b style={{ color: '#1e293b' }}>{safeNum(val).toLocaleString()}</b>
                              </span>
                            ))}
                          </div>
                          <div style={{ fontSize: 11.5, color: '#334155', lineHeight: 1.7, marginBottom: 8 }}>
                            검증: 분석↔실행계획 정합 {execPlan.planMatchesAnalysis ? '✓' : '✗'} · 기존 ID 유지 {v.idPreserved ? '✓' : '✗'} · 원본(진행관리표·판매목록·매핑·민감정보) 보존 {v.originalsPreserved ? '✓' : '✗'} · 단일 트랜잭션·실패 시 롤백 ✓ · 실행 전후 기록 ✓
                            {blockers > 0 && <span style={{ color: '#b91c1c', fontWeight: 700 }}> · UNIQUE 충돌 {blockers}건은 해당 인원만 자동 제외(나머지는 정상 생성)</span>}
                          </div>
                          {/* 요구사항2: 등록 제외 기준 C 검증 */}
                          <div style={{ fontSize: 11.5, marginBottom: 8, color: execPlan.excludeAudit.allCriterionC ? '#047857' : '#b91c1c', fontWeight: 600 }}>
                            {execPlan.excludeAudit.allCriterionC ? '✓' : '✗'} 등록 제외 {safeNum(execPlan.excludeAudit.total).toLocaleString()}명 전원 기준 C(주민번호 없음·수행이력 없음)
                            {execPlan.excludeAudit.withRrnButExcluded > 0 && <span style={{ color: '#b91c1c' }}> · 다른 사유 제외 {execPlan.excludeAudit.withRrnButExcluded}명(확인 필요)</span>}
                            {execPlan.excludeAudit.nameMissingSeparate > 0 && <span style={{ color: '#6b7280', fontWeight: 500 }}> · (별도) 성명 누락 무효행 {safeNum(execPlan.excludeAudit.nameMissingSeparate).toLocaleString()}건은 고유인원·제외에 미포함</span>}
                          </div>
                          {/* 요구사항3: 수동 확인 대상 상세(마스킹) */}
                          {execPlan.manualReviewDetail.length > 0 && (
                            <div style={{ marginBottom: 8, padding: '8px 10px', background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 8 }}>
                              <div style={{ fontSize: 11.5, fontWeight: 700, color: '#92400e', marginBottom: 4 }}>수동 확인 대상 {execPlan.manualReviewDetail.length}명 (개인정보 마스킹)</div>
                              {execPlan.manualReviewDetail.map((m) => (
                                <div key={m.rowNumber} style={{ fontSize: 11, color: '#78350f', lineHeight: 1.7 }}>
                                  · {m.nameMasked} ({m.residentMasked}) — <b>{m.reason}</b> → {m.action}
                                </div>
                              ))}
                            </div>
                          )}
                          <div style={{ padding: '10px 12px', background: '#fff7ed', border: '1px solid #fed7aa', borderRadius: 8, fontSize: 11.5, color: '#9a3412', lineHeight: 1.7 }}>
                            <b>실제 DB 등록 실행 기능은 준비되었습니다.</b> 이번 작업에서는 실행하지 않습니다(요구사항8). 실제 반영은 <b>대표 승인 + 서버 호출(commit=true, confirm=&lt;스냅샷ID&gt;)</b> 에서만 수행됩니다. 이름만 일치 자동연결 없음 · 기존 Master 삭제/비활성화 없음 · 민감정보·계좌·단가·기존 매핑 보존.
                          </div>
                        </div>
                      );
                    })()}
                  </>)}
                </div>
              )}

              {isWizard && (
                <div style={{ marginTop: 14 }}>
                  <GhostBtn onClick={() => setWizardStep(3)} data-testid="wizard-back-review" aria-label="정보 검토로">← 정보 검토</GhostBtn>
                </div>
              )}
              </>)}
            </Card>
          )}
        </>
      )}
    </div>
  );
}

// ─── Error Boundary ───────────────────────────────────────────────────────────
// 분석/렌더 중 예기치 못한 예외가 나더라도 앱 전체(Replit Preview)가 오류 화면으로
// 전환되지 않도록 대량등록 화면 내부에서만 오류 메시지를 표시한다. (요구사항 §8)
interface BoundaryProps { title: string; onClose: () => void; children: React.ReactNode; }
interface BoundaryState { error: Error | null; }

class BulkImportErrorBoundary extends React.Component<BoundaryProps, BoundaryState> {
  state: BoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): BoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    // 콘솔에 원인/stack 을 남겨 진단을 돕는다(전체 앱은 중단되지 않음).
    console.error('[BulkImportPage] 렌더 오류로 화면을 안전하게 격리했습니다.', error, info);
  }

  render() {
    if (this.state.error) {
      return (
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
            <BackToListButton onClick={this.props.onClose} variant="subtle" label="뒤로가기" testId="bulk-import-error-back" />
            <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700, color: '#111827' }}>{this.props.title}</h2>
          </div>
          <Card style={{ padding: 24 }}>
            <div style={{ fontSize: 15, fontWeight: 700, color: '#b91c1c', marginBottom: 8 }}>⚠️ 화면을 표시하는 중 오류가 발생했습니다</div>
            <p style={{ fontSize: 13, color: '#6b7280', lineHeight: 1.7, margin: '0 0 16px' }}>
              분석 결과를 처리하는 중 문제가 발생하여 이 화면만 안전하게 중단했습니다.
              파일을 다시 확인하거나 페이지를 새로고침한 뒤 재시도해 주세요. (다른 기능은 정상 동작합니다.)
            </p>
            <details style={{ fontSize: 11, color: '#9ca3af', marginBottom: 16 }}>
              <summary style={{ cursor: 'pointer' }}>오류 상세</summary>
              <pre style={{ whiteSpace: 'pre-wrap', marginTop: 8 }}>{this.state.error.message}</pre>
            </details>
            <div style={{ display: 'flex', gap: 10 }}>
              <PrimaryBtn onClick={() => this.setState({ error: null })} data-testid="bulk-import-error-retry" aria-label="다시 시도">다시 시도</PrimaryBtn>
              <BackToListButton onClick={this.props.onClose} variant="subtle" label="뒤로가기" testId="bulk-import-error-close" />
            </div>
          </Card>
        </div>
      );
    }
    return this.props.children;
  }
}

export function BulkImportPage(props: BulkImportPageProps) {
  const title = props.entity === 'company' ? COMPANY_CONFIG.title : props.entity === 'translator' ? TRANSLATOR_CONFIG.title : props.entity === 'quote' ? QUOTE_CONFIG.title : CONTACT_CONFIG.title;
  return (
    <BulkImportErrorBoundary title={title} onClose={props.onClose}>
      <BulkImportPageInner {...props} />
    </BulkImportErrorBoundary>
  );
}

export default BulkImportPage;
