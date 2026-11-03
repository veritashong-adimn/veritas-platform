/**
 * 회사 자료보관함 — 프론트 공통(API 호출·타입·라벨·스타일).
 * 파일은 항상 인증 헤더로 서버 API 에서 Blob 으로 받아 표시한다(공개 URL·토큰 쿼리 사용 안 함).
 */
import type React from 'react';
import { api } from '../../../lib/constants';

export type ArchiveView =
  | 'overview' | 'all' | 'forms' | 'work'
  // 구 사이드메뉴 경로(호환용) — 진입 시 '업무자료 관리'의 해당 분류 탭으로 이동한다.
  | 'manuals' | 'contracts' | 'records' | 'hr' | 'management'
  | 'import' | 'ai' | 'approvals' | 'settings';

/** 업무자료 관리 화면의 분류 탭 — key 는 서버 폴더 menuKey(분류 식별자)와 동일. 표시명으로 조회하지 않는다. */
export const WORK_TABS = ['manuals', 'contracts', 'records', 'hr', 'management'] as const;
export type WorkTab = typeof WORK_TABS[number];
export const isWorkTab = (v: string): v is WorkTab => (WORK_TABS as readonly string[]).includes(v);

export const ARCHIVE_MENU_LABEL: Record<string, string> = {
  overview: '자료 현황', all: '전체 자료', forms: '서류양식 관리', work: '업무자료 관리', manuals: '매뉴얼·업무프로세스',
  contracts: '계약·협약 관리', records: '이메일·업무기록', hr: '인사·노무·복지', management: '경영·기획·통계',
  import: '자료 등록·가져오기', ai: 'AI 지식관리', approvals: '승인관리', settings: '자료 관리설정',
};

export const DOC_TYPE_LABEL: Record<string, string> = {
  general: '일반자료', form_template: '표준양식', form_issued: '작성·발급본', contract: '계약·협약', manual: '매뉴얼',
  policy: '규정·정책', email: '이메일', record: '업무기록', report: '보고서·통계', other: '기타',
};
export const SECURITY_LABEL: Record<string, string> = { internal: '사내일반', restricted: '제한', confidential: '기밀', secret: '극비' };
export const SECURITY_COLOR: Record<string, string> = { internal: '#059669', restricted: '#2563eb', confidential: '#d97706', secret: '#dc2626' };
export const STATUS_LABEL: Record<string, string> = { draft: '초안', in_review: '검토중', approved: '승인', revised: '개정중', discarded: '폐기' };
export const STATUS_COLOR: Record<string, string> = { draft: '#6b7280', in_review: '#d97706', approved: '#059669', revised: '#7c3aed', discarded: '#9ca3af' };
export const VERSION_STATUS_LABEL: Record<string, string> = { draft: '초안', in_review: '검토중', approved: '승인본', rejected: '반려', superseded: '이전 승인본' };
export const APPROVAL_TYPE_LABEL: Record<string, string> = {
  register: '신규 등록', new_version: '개정(새 버전)', restore_version: '이전 버전 복원', acl_change: '권한 변경',
  purge: '영구 삭제', status_change: '폐기', share: '외부 공유', ai_draft: 'AI 작성 문서 확정',
};
export const APPROVAL_STATUS_LABEL: Record<string, string> = { pending: '대기', approved: '승인', rejected: '반려', cancelled: '취소' };
export const ACTION_LABEL: Record<string, string> = {
  view: '검색·열람', preview: '미리보기', download: '다운로드', print: '인쇄', upload: '등록', edit: '수정',
  delete: '삭제', restore: '복원', share: '외부공유', ai: 'AI 활용', manage: '권한설정',
};
export const ALL_ACTIONS = Object.keys(ACTION_LABEL);
export const ACL_PRESETS: Array<{ label: string; actions: string[] }> = [
  { label: '열람(미리보기·인쇄)', actions: ['view', 'preview', 'print'] },
  { label: '열람+다운로드+AI', actions: ['view', 'preview', 'print', 'download', 'ai'] },
  { label: '편집자', actions: ['view', 'preview', 'print', 'download', 'ai', 'upload', 'edit'] },
  { label: '폴더 관리자', actions: ALL_ACTIONS },
];
export const LINK_TYPE_LABEL: Record<string, string> = {
  company: '거래처', contact: '고객 담당자', inquiry: '의뢰접수', quote: '견적', project: '판매',
  translator: '통번역사', settlement: '정산', payment: '수금', user: '직원',
};
export const AUDIT_ACTION_LABEL: Record<string, string> = {
  upload: '등록', view: '열람', preview: '미리보기', preview_text: '텍스트 미리보기', download: '다운로드', print: '인쇄',
  update: '정보 수정', move: '이동', delete: '삭제', restore: '복원', purge: '영구 삭제', discard: '폐기',
  version_add: '새 버전', version_restore: '버전 복원', approval_request: '승인 요청', approval_approve: '승인',
  approval_reject: '반려', approval_cancel: '요청 취소', acl_change: '권한 변경', link_add: '업무 연결',
  link_remove: '연결 해제', search: '검색', ai_search: 'AI 검색', access_denied: '접근 거부',
  form_issue: '양식 발급', folder_create: '폴더 생성', folder_update: '폴더 수정', folder_move: '폴더 이동', folder_seed: '기본 분류 생성',
};

export interface ArchiveMe {
  userId: number; department: string | null; isSuper: boolean; isArchiveAdmin: boolean;
  canUpload: boolean; canApprove: boolean; canPurge: boolean; folderCount: number;
  maxFileSize: number; allowedExtensions: string[]; docTypes: string[]; securityLevels: string[];
}
export interface ArchiveFolder {
  id: number; parentId: number | null; name: string; description?: string | null; menuKey: string | null;
  effectiveMenuKey: string | null; isActive: boolean; isSystem?: boolean; sortOrder: number; path: string;
  actions: string[]; docCount?: number;
}
export interface ArchiveListItem {
  id: number; title: string; docType: string; folderId: number; folderPath: string; status: string;
  securityLevel: string; isStandardForm: boolean; aiAllowed: boolean; requiresApproval: boolean;
  ownerDepartment: string | null; authorName: string | null; documentDate: string | null; expiresAt: string | null;
  createdAt: string; updatedAt: string; createdByName: string | null; hasApprovedVersion: boolean;
  fileName: string | null; mimeType: string | null; fileSize: number | null; versionNo: number | null;
  versionStatus: string | null; fileCategory: string; actions: string[];
}
export interface AclEntry { id?: number; subjectType: string; subjectId?: number | null; subjectValue?: string | null; effect: string; actions: string[]; fromFolder?: string }

export class ApiError extends Error { constructor(msg: string, public status: number, public data?: any) { super(msg); } }

export function makeArchiveApi(token: string) {
  const auth = { Authorization: `Bearer ${token}` };
  async function req<T = any>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(api(`/api${path}`), {
      method, headers: { ...auth, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new ApiError(data?.error ?? `요청 실패 (${res.status})`, res.status, data);
    return data as T;
  }
  async function upload<T = any>(path: string, file: File | Blob, fileName: string, meta: Record<string, unknown>): Promise<{ status: number; data: T }> {
    const fd = new FormData();
    fd.append('meta', JSON.stringify({ ...meta, fileName }));
    fd.append('file', file, fileName);
    const res = await fetch(api(`/api${path}`), { method: 'POST', headers: auth, body: fd });
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new ApiError(data?.error ?? `업로드 실패 (${res.status})`, res.status, data);
    return { status: res.status, data };
  }
  /** 권한 검증된 파일을 Blob 으로 수신 */
  async function fileBlob(docId: number, opts: { versionId?: number; inline?: boolean } = {}): Promise<Blob> {
    const qs = new URLSearchParams();
    if (opts.versionId) qs.set('versionId', String(opts.versionId));
    if (opts.inline) qs.set('disposition', 'inline');
    const res = await fetch(api(`/api/archive/documents/${docId}/file?${qs}`), { headers: auth });
    if (!res.ok) {
      const data = await res.json().catch(() => null);
      throw new ApiError(data?.error ?? `파일 요청 실패 (${res.status})`, res.status);
    }
    return res.blob();
  }
  return {
    get: <T = any>(p: string) => req<T>('GET', p),
    post: <T = any>(p: string, b?: unknown) => req<T>('POST', p, b ?? {}),
    patch: <T = any>(p: string, b: unknown) => req<T>('PATCH', p, b),
    put: <T = any>(p: string, b: unknown) => req<T>('PUT', p, b),
    del: <T = any>(p: string, b?: unknown) => req<T>('DELETE', p, b ?? {}),
    upload, fileBlob,
  };
}
export type ArchiveApi = ReturnType<typeof makeArchiveApi>;

/** 브라우저 저장(다운로드) */
export function saveBlob(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = fileName;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** 숨김 iframe 으로 인쇄 (PDF·이미지·텍스트) */
export function printBlob(blob: Blob) {
  const url = URL.createObjectURL(blob);
  const iframe = document.createElement('iframe');
  iframe.style.position = 'fixed'; iframe.style.right = '0'; iframe.style.bottom = '0';
  iframe.style.width = '0'; iframe.style.height = '0'; iframe.style.border = '0';
  iframe.src = url;
  iframe.onload = () => {
    try { iframe.contentWindow?.focus(); iframe.contentWindow?.print(); } catch { window.open(url, '_blank'); }
    setTimeout(() => { iframe.remove(); URL.revokeObjectURL(url); }, 60_000);
  };
  document.body.appendChild(iframe);
}

export async function sha256Hex(file: Blob): Promise<string | null> {
  try {
    const buf = await file.arrayBuffer();
    const hash = await crypto.subtle.digest('SHA-256', buf);
    return [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, '0')).join('');
  } catch { return null; }
}

export const fmtSize = (n: number | null | undefined) =>
  n == null ? '—' : n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;
export const fmtDate = (s: string | null | undefined) => (s ? new Date(s).toLocaleDateString('ko-KR') : '—');
export const fmtDateTime = (s: string | null | undefined) => (s ? new Date(s).toLocaleString('ko-KR', { hour12: false }) : '—');

// ─── 공통 인라인 스타일(기존 관리자 화면 톤) ─────────────────────────────────
export const S = {
  card: { background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, padding: 16 } as React.CSSProperties,
  h2: { margin: '0 0 12px', fontSize: 15, fontWeight: 700, color: '#111827' } as React.CSSProperties,
  label: { display: 'block', fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 4 } as React.CSSProperties,
  input: { width: '100%', padding: '7px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13, boxSizing: 'border-box' } as React.CSSProperties,
  btn: { padding: '7px 12px', borderRadius: 6, border: '1px solid #d1d5db', background: '#fff', fontSize: 13, cursor: 'pointer', color: '#374151' } as React.CSSProperties,
  btnPrimary: { padding: '7px 14px', borderRadius: 6, border: '1px solid #2563eb', background: '#2563eb', color: '#fff', fontSize: 13, fontWeight: 600, cursor: 'pointer' } as React.CSSProperties,
  btnDanger: { padding: '7px 12px', borderRadius: 6, border: '1px solid #fecaca', background: '#fef2f2', color: '#b91c1c', fontSize: 13, cursor: 'pointer' } as React.CSSProperties,
  th: { padding: '9px 10px', textAlign: 'left', fontSize: 12, fontWeight: 600, color: '#6b7280', background: '#f9fafb', borderBottom: '1px solid #e5e7eb', whiteSpace: 'nowrap' } as React.CSSProperties,
  td: { padding: '9px 10px', fontSize: 13, color: '#374151', borderBottom: '1px solid #edf0f3', verticalAlign: 'middle' } as React.CSSProperties,
  muted: { fontSize: 12, color: '#6b7280' } as React.CSSProperties,
};

export function badgeStyle(color: string): React.CSSProperties {
  return { display: 'inline-block', padding: '2px 8px', borderRadius: 999, fontSize: 11, fontWeight: 600, color, background: `${color}14`, border: `1px solid ${color}40`, whiteSpace: 'nowrap' };
}
