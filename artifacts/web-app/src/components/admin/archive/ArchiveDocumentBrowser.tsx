/**
 * 전체 자료 / 서류양식 관리 / 업무자료 관리(5개 분류 탭) 공용 목록 화면.
 * 하나의 통합 저장소를 menu 키로 분류 조회한다(중복 저장 없음). 서버가 권한 필터를 적용한 결과만 표시.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ARCHIVE_MENU_LABEL, DOC_TYPE_LABEL, SECURITY_LABEL, STATUS_COLOR, STATUS_LABEL, S, badgeStyle, AI_STATUS_LABEL,
  fmtDate, type ArchiveApi, type ArchiveFolder, type ArchiveListItem, type ArchiveMe,
} from './archiveApi';
import { ArchiveFolderTree } from './ArchiveFolderTree';
import { useArchiveFolderManager } from './ArchiveFolderManager';

const FILE_TYPES: Record<string, string> = { pdf: 'PDF', word: 'Word', excel: 'Excel/CSV', ppt: 'PowerPoint', hwp: '한글', image: '이미지', email: '이메일', text: '텍스트', other: '기타' };
const FILE_ICON: Record<string, string> = { pdf: '📕', word: '📘', excel: '📗', ppt: '📙', hwp: '📄', image: '🖼️', email: '✉️', text: '📝', other: '📎' };

export function ArchiveDocumentBrowser({ api, me, menu, folders, onOpen, onUpload, refreshKey, showTitle = true, emptyFolderNotice, folderAdmin }: {
  api: ArchiveApi;
  me: ArchiveMe;
  menu: string | null;                   // null = 전체 자료
  folders: ArchiveFolder[];
  onOpen: (id: number) => void;
  onUpload: (folderId: number | null) => void;
  refreshKey: number;
  showTitle?: boolean;                   // 업무자료 관리: 상단 탭이 제목 역할 → 중복 제목 생략
  emptyFolderNotice?: React.ReactNode;   // 분류에 표시할 폴더가 없을 때 목록 위 안내
  /** 지정 시 폴더 탐색 영역에 관리자 전용 폴더 관리(추가·이름변경·이동·순서·삭제·복원) 표시 — 전체 자료 화면 */
  folderAdmin?: { reload: () => Promise<void>; setToast: (m: string) => void };
}) {
  const [folderId, setFolderId] = useState<number | null>(null);
  const [q, setQ] = useState('');
  const [qApplied, setQApplied] = useState('');
  const [filters, setFilters] = useState({ docType: '', status: '', fileType: '', securityLevel: '', author: '', dateField: 'created', dateFrom: '', dateTo: '', standardOnly: false });
  const [sort, setSort] = useState('latest');
  const [page, setPage] = useState(1);
  const [data, setData] = useState<{ total: number; items: ArchiveListItem[] } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const pageSize = 20;

  // 메뉴 전환 시 폴더 선택 초기화
  useEffect(() => { setFolderId(null); setPage(1); }, [menu]);

  const fm = useArchiveFolderManager({
    api, me, folders, reload: folderAdmin?.reload ?? (async () => {}), setToast: folderAdmin?.setToast ?? (() => {}), idPrefix: 'archive-browse-folder',
  });
  const manage = !!folderAdmin && fm.enabled;
  // 선택 폴더가 삭제·숨김되면 전체로 복귀
  useEffect(() => { if (folderId != null && !folders.some(f => f.id === folderId)) { setFolderId(null); setPage(1); } }, [folders, folderId]);

  const menuFolders = useMemo(() => {
    if (!menu) return folders;
    const inMenu = new Set(folders.filter(f => f.effectiveMenuKey === menu).map(f => f.id));
    return folders.filter(f => inMenu.has(f.id));
  }, [folders, menu]);

  const load = useCallback(async () => {
    setLoading(true); setError('');
    const qs = new URLSearchParams({ page: String(page), pageSize: String(pageSize), sort });
    if (menu) qs.set('menu', menu);
    if (folderId) qs.set('folderId', String(folderId));
    if (qApplied) qs.set('q', qApplied);
    for (const [k, v] of Object.entries(filters)) {
      if (k === 'standardOnly') { if (v) qs.set('standardOnly', '1'); continue; }
      if (v) qs.set(k, String(v));
    }
    try { setData(await api.get(`/archive/documents?${qs}`)); }
    catch (e: any) { setError(e.message); setData(null); }
    finally { setLoading(false); }
  }, [api, menu, folderId, qApplied, filters, sort, page]);
  useEffect(() => { load(); }, [load, refreshKey]);

  const setF = (k: keyof typeof filters, v: any) => { setFilters(f => ({ ...f, [k]: v })); setPage(1); };
  const totalPages = data ? Math.max(1, Math.ceil(data.total / pageSize)) : 1;
  const title = menu ? ARCHIVE_MENU_LABEL[menu] : '전체 자료';

  return (
    <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start' }}>
      <aside style={{ ...S.card, width: 250, flexShrink: 0, padding: 10, maxHeight: '75vh', overflowY: 'auto' }}>
        <div style={{ ...S.muted, fontWeight: 700, padding: '2px 6px 6px' }}>폴더 탐색</div>
        {manage && fm.toolbar}
        <ArchiveFolderTree folders={menuFolders} selectedId={folderId} onSelect={(id) => { setFolderId(id); setPage(1); }} testIdPrefix="archive-browse-tree"
          renderExtra={manage ? fm.rowExtra : undefined} onRowContextMenu={manage ? fm.onRowContextMenu : undefined} />
        {manage && fm.overlay}
      </aside>

      <section style={{ flex: 1, minWidth: 0 }}>
        {menuFolders.length === 0 && emptyFolderNotice}
        <div style={{ ...S.card, marginBottom: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
            {!showTitle && <span style={{ ...S.muted, flex: 1 }}>{folderId ? menuFolders.find(f => f.id === folderId)?.path : '분류 전체'}</span>}
            {showTitle && <h2 style={{ ...S.h2, margin: 0, flex: 1 }}>{title}{menu === 'forms' && <span style={{ ...S.muted, fontWeight: 400 }}> · 표준양식(원본)과 작성·발급본을 구분해 관리합니다</span>}</h2>}
            {me.canUpload && (
              <button type="button" style={S.btnPrimary} data-testid="archive-browse-upload" aria-label="자료 등록"
                onClick={() => onUpload(folderId)}>+ 자료 등록</button>
            )}
          </div>
          <form style={{ display: 'flex', gap: 8 }} onSubmit={e => { e.preventDefault(); setQApplied(q.trim()); setPage(1); }}>
            <input style={{ ...S.input, flex: 1 }} value={q} onChange={e => setQ(e.target.value)}
              placeholder="자료명·파일명·본문·키워드·관련 거래처·담당자·업무번호 검색" aria-label="통합 검색어" data-testid="archive-search-input" />
            <button type="submit" style={S.btnPrimary} data-testid="archive-search-submit" aria-label="검색">검색</button>
            {qApplied && <button type="button" style={S.btn} data-testid="archive-search-clear" aria-label="검색 초기화" onClick={() => { setQ(''); setQApplied(''); }}>초기화</button>}
          </form>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10 }}>
            <select style={{ ...S.input, width: 130 }} value={filters.docType} onChange={e => setF('docType', e.target.value)} aria-label="자료 유형 필터" data-testid="archive-filter-doctype">
              <option value="">자료 유형 전체</option>
              {Object.entries(DOC_TYPE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
            <select style={{ ...S.input, width: 120 }} value={filters.fileType} onChange={e => setF('fileType', e.target.value)} aria-label="파일 유형 필터" data-testid="archive-filter-filetype">
              <option value="">파일 유형 전체</option>
              {Object.entries(FILE_TYPES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
            <select style={{ ...S.input, width: 120 }} value={filters.status} onChange={e => setF('status', e.target.value)} aria-label="승인 상태 필터" data-testid="archive-filter-status">
              <option value="">상태 전체</option>
              {Object.entries(STATUS_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
            <select style={{ ...S.input, width: 110 }} value={filters.securityLevel} onChange={e => setF('securityLevel', e.target.value)} aria-label="보안등급 필터" data-testid="archive-filter-security">
              <option value="">보안등급 전체</option>
              {Object.entries(SECURITY_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
            <input style={{ ...S.input, width: 120 }} placeholder="작성자" value={filters.author} onChange={e => setF('author', e.target.value)} aria-label="작성자 필터" data-testid="archive-filter-author" />
            <select style={{ ...S.input, width: 90 }} value={filters.dateField} onChange={e => setF('dateField', e.target.value)} aria-label="날짜 기준" data-testid="archive-filter-datefield">
              <option value="created">등록일</option>
              <option value="updated">수정일</option>
            </select>
            <input type="date" style={{ ...S.input, width: 140 }} value={filters.dateFrom} onChange={e => setF('dateFrom', e.target.value)} aria-label="시작일" data-testid="archive-filter-from" />
            <input type="date" style={{ ...S.input, width: 140 }} value={filters.dateTo} onChange={e => setF('dateTo', e.target.value)} aria-label="종료일" data-testid="archive-filter-to" />
            {menu === 'forms' && (
              <label style={{ fontSize: 12, display: 'flex', alignItems: 'center', gap: 4 }}>
                <input type="checkbox" checked={filters.standardOnly} onChange={e => setF('standardOnly', e.target.checked)} data-testid="archive-filter-standard" aria-label="표준양식만" /> 표준양식만
              </label>
            )}
            <select style={{ ...S.input, width: 110, marginLeft: 'auto' }} value={sort} onChange={e => setSort(e.target.value)} aria-label="정렬" data-testid="archive-sort">
              <option value="latest">최신순</option>
              <option value="oldest">오래된순</option>
              <option value="name">이름순</option>
            </select>
          </div>
        </div>

        <div style={{ ...S.card, padding: 0, overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                {/* 검색 결과 핵심 정보: 문서 제목 · 자료 유형 · 등록일 · 승인 상태 (분류·보안·파일 등은 상세에서 확인) */}
                <th style={S.th}>문서 제목</th><th style={S.th}>자료 유형</th><th style={S.th}>등록일</th><th style={S.th}>승인 상태</th>
              </tr>
            </thead>
            <tbody>
              {loading && <tr><td colSpan={4} style={{ ...S.td, textAlign: 'center', color: '#9ca3af' }}>불러오는 중…</td></tr>}
              {!loading && error && <tr><td colSpan={4} style={{ ...S.td, color: '#b91c1c' }}>{error}</td></tr>}
              {!loading && !error && data?.items.length === 0 && (
                <tr><td colSpan={4} style={{ ...S.td, textAlign: 'center', color: '#9ca3af', padding: 32 }}>
                  {qApplied ? '검색 결과가 없습니다. (열람 권한이 있는 자료만 표시됩니다)' : '등록된 자료가 없거나 열람 권한이 있는 자료가 없습니다.'}
                </td></tr>
              )}
              {!loading && data?.items.map(it => (
                <tr key={it.id} style={{ cursor: 'pointer' }} onClick={() => onOpen(it.id)} data-testid={`archive-row-${it.id}`}>
                  <td style={S.td}>
                    <button type="button" onClick={(e) => { e.stopPropagation(); onOpen(it.id); }} data-testid={`archive-open-${it.id}`} aria-label={`${it.title} 상세보기`}
                      style={{ border: 0, background: 'none', padding: 0, cursor: 'pointer', color: '#1d4ed8', fontWeight: 600, fontSize: 13, textAlign: 'left' }}>
                      {FILE_ICON[it.fileCategory] ?? '📎'} {it.title}
                    </button>
                    {it.isStandardForm && <span style={{ ...badgeStyle('#0891b2'), marginLeft: 6 }}>표준양식</span>}
                    {it.versionNo && it.versionNo > 1 && <span style={{ ...S.muted, marginLeft: 6 }}>v{it.versionNo}</span>}
                    {it.aiStatus && ['analyzing', 'needs_review', 'failed'].includes(it.aiStatus) &&
                      <span style={{ ...badgeStyle(AI_STATUS_LABEL[it.aiStatus][1]), marginLeft: 6 }} data-testid={`archive-row-ai-${it.id}`}>{AI_STATUS_LABEL[it.aiStatus][0]}</span>}
                  </td>
                  <td style={{ ...S.td, fontSize: 12 }}>{DOC_TYPE_LABEL[it.docType] ?? it.docType}</td>
                  <td style={{ ...S.td, fontSize: 12 }}>{fmtDate(it.createdAt)}</td>
                  <td style={S.td}><span style={badgeStyle(STATUS_COLOR[it.status] ?? '#6b7280')}>{STATUS_LABEL[it.status] ?? it.status}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 10 }}>
          <span style={S.muted}>총 {data?.total ?? 0}건</span>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <button type="button" style={S.btn} disabled={page <= 1} onClick={() => setPage(p => p - 1)} data-testid="archive-page-prev" aria-label="이전 페이지">이전</button>
            <span style={{ fontSize: 13 }}>{page} / {totalPages}</span>
            <button type="button" style={S.btn} disabled={page >= totalPages} onClick={() => setPage(p => p + 1)} data-testid="archive-page-next" aria-label="다음 페이지">다음</button>
          </div>
        </div>
      </section>
    </div>
  );
}
