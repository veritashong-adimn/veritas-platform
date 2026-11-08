/**
 * 회사 자료보관함 — 데이터 자산 하위 메뉴(전체 자료·자료 등록·자료 관리설정)의 단일 진입점.
 *  · 구 '자료 현황'(overview) → 전체 자료 상단 통계로 통합(경로 진입 시 전체 자료로 전환)
 *  · 구 '승인 관리'(approvals) → 자료 관리설정 › 승인 관리 탭(권한 없으면 전체 자료로 전환)
 * (이하 기존 설명)
 * 8개 메뉴는 독립 저장소가 아니라 하나의 통합 저장소를 목적별로 조회한다.
 * 5개 업무 분류(manuals·contracts·records·hr·management)는 '업무자료 관리'(view=work) 내부 탭으로 통합.
 * 구 경로(archive-manuals 등)로 진입하면 work 로 전환하면서 해당 탭을 선택한다.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ARCHIVE_MENU_LABEL, S, isWorkTab, makeArchiveApi, type ArchiveFolder, type ArchiveMe, type ArchiveView, type WorkTab } from './archiveApi';
import { ArchiveWorkspace } from './ArchiveWorkspace';
import { ArchiveDocumentBrowser } from './ArchiveDocumentBrowser';
import { ArchiveDocumentDetail, Modal } from './ArchiveDocumentDetail';
import { ArchiveUploadPanel } from './ArchiveUploadPanel';
import { ArchiveAiPanel } from './ArchiveAiPanel';
import { ArchiveSettings, type SettingsTab } from './ArchiveSettings';
import { ArchiveStatsBar } from './ArchiveStatsBar';

const BROWSE_VIEWS = new Set(['all', 'forms']);
const WORK_TAB_KEY = 'archiveWorkTab';

function readWorkTab(): WorkTab {
  try { const v = sessionStorage.getItem(WORK_TAB_KEY); if (v && isWorkTab(v)) return v; } catch { /* 세션 사용 불가 */ }
  return 'manuals';
}

export function ArchiveModule({ token, view, setToast, onNavigate }: {
  token: string; view: ArchiveView; setToast: (m: string) => void; onNavigate: (view: string) => void;
}) {
  const api = useMemo(() => makeArchiveApi(token), [token]);
  const [me, setMe] = useState<ArchiveMe | null>(null);
  const [meError, setMeError] = useState('');
  const [folders, setFolders] = useState<ArchiveFolder[]>([]);
  const [openDoc, setOpenDoc] = useState<number | null>(null);
  const [uploadFolder, setUploadFolder] = useState<number | null | undefined>(undefined);
  const [uploadMenu, setUploadMenu] = useState<WorkTab | null>(null);
  const [workTab, setWorkTabState] = useState<WorkTab>(() => isWorkTab(view) ? view : readWorkTab());
  const setWorkTab = useCallback((t: WorkTab) => {
    setWorkTabState(t);
    try { sessionStorage.setItem(WORK_TAB_KEY, t); } catch { /* 무시 */ }
  }, []);

  // 구 사이드메뉴 경로 호환: archive-manuals 등 → 업무자료 관리 + 해당 탭
  useEffect(() => {
    if (isWorkTab(view)) { setWorkTab(view); onNavigate('work'); }
  }, [view, onNavigate, setWorkTab]);
  // 구 메뉴 경로 호환: 자료 현황 → 전체 자료, 승인 관리 → (권한 확인) 자료 관리설정 › 승인 관리
  const [settingsTab, setSettingsTab] = useState<SettingsTab | null>(null);
  useEffect(() => {
    if (view === 'overview') onNavigate('all');
    else if (view === 'approvals' && me) {
      if (me.canApprove || me.isArchiveAdmin) { setSettingsTab('approvals'); onNavigate('settings'); }
      else onNavigate('all');
    }
  }, [view, me, onNavigate]);
  const [issueTemplate, setIssueTemplate] = useState<number | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const bump = () => setRefreshKey(k => k + 1);

  const loadFolders = useCallback(async () => {
    try { setFolders(await api.get('/archive/folders')); } catch { setFolders([]); }
    try { setMe(await api.get('/archive/me')); } catch { /* me 오류는 아래에서 처리 */ }
  }, [api]);
  useEffect(() => {
    api.get<ArchiveMe>('/archive/me').then(m => { setMe(m); setMeError(''); }).catch(e => setMeError(e.message));
    loadFolders();
  }, [api, loadFolders]);

  if (meError) return <div style={{ ...S.card, color: '#b91c1c' }}>{meError}</div>;
  if (!me) return <div style={S.card}>불러오는 중…</div>;

  const onChanged = () => { bump(); loadFolders(); };

  return (
    <div data-testid={`archive-view-${view}`}>
      {me.folderCount === 0 && view !== 'settings' && (
        <div style={{ ...S.card, marginBottom: 12, background: '#f0f9ff', borderColor: '#bae6fd', fontSize: 13 }}>
          자료 분류가 아직 생성되지 않았습니다. {me.isArchiveAdmin
            ? <button type="button" style={{ ...S.btn, marginLeft: 6 }} onClick={() => onNavigate('settings')} data-testid="archive-goto-settings" aria-label="자료 관리설정으로 이동">자료 관리설정에서 기본 분류 생성</button>
            : '자료보관함 관리자에게 문의해 주세요.'}
        </div>
      )}

      {view === 'all' && <ArchiveStatsBar api={api} me={me} refreshKey={refreshKey} onNavigate={onNavigate} onOpen={setOpenDoc} />}
      {BROWSE_VIEWS.has(view) && (
        <ArchiveDocumentBrowser key={view} api={api} me={me} menu={view === 'all' ? null : view} folders={folders}
          onOpen={setOpenDoc}
          folderAdmin={view === 'all' ? { reload: loadFolders, setToast } : undefined}
          // 전체 자료의 '+ 자료 등록' → 기존 자료 등록 화면(archive-import)으로 이동. 그 외 조회 화면은 기존 등록 창 유지.
          onUpload={(fid) => { if (view === 'all') { onNavigate('import'); return; } setUploadMenu(null); setUploadFolder(fid); }} refreshKey={refreshKey} />
      )}
      {(view === 'work' || isWorkTab(view)) && (
        <ArchiveWorkspace api={api} me={me} folders={folders} tab={workTab} onTab={setWorkTab} onOpen={setOpenDoc}
          onUpload={(fid, menuKey) => { setUploadMenu(menuKey); setUploadFolder(fid); }} onNavigate={onNavigate} refreshKey={refreshKey} />
      )}
      {view === 'import' && (
        <>
          {/* 사이드바에서 '자료 등록' 메뉴는 제거됨 — '전체 자료'에서 진입·복귀. 분석 진행 상태는 이 화면에서 계속 표시 */}
          <button type="button" style={{ ...S.btn, marginBottom: 10 }} onClick={() => onNavigate('all')} data-testid="archive-import-back" aria-label="전체 자료로 이동">← 전체 자료</button>
          <ArchiveUploadPanel api={api} me={me} folders={folders} setToast={setToast} onDone={onChanged} />
        </>
      )}
      {view === 'ai' && <ArchiveAiPanel api={api} onOpen={setOpenDoc} />}
      {view === 'settings' && (
        <ArchiveSettings key={settingsTab ?? 'default'} api={api} me={me} folders={folders} reloadFolders={loadFolders} setToast={setToast}
          initialTab={settingsTab} onOpen={setOpenDoc} refreshKey={refreshKey} onChanged={onChanged} />
      )}

      {openDoc != null && (
        <ArchiveDocumentDetail key={openDoc} api={api} me={me} docId={openDoc} folders={folders}
          onClose={() => setOpenDoc(null)} onChanged={onChanged} setToast={setToast}
          onIssue={(tid) => { setOpenDoc(null); setIssueTemplate(tid); }} />
      )}
      {uploadFolder !== undefined && (
        <Modal title={uploadMenu ? `자료 등록 · ${ARCHIVE_MENU_LABEL[uploadMenu]}` : '자료 등록'} wide onClose={() => setUploadFolder(undefined)}>
          <ArchiveUploadPanel api={api} me={me} folders={folders} initialFolderId={uploadFolder} menuKey={uploadMenu} setToast={setToast} onDone={onChanged} />
        </Modal>
      )}
      {issueTemplate != null && (
        <Modal title="양식 기반 작성·발급본 등록" wide onClose={() => setIssueTemplate(null)}>
          <ArchiveUploadPanel api={api} me={me} folders={folders} templateId={issueTemplate} setToast={setToast} onDone={onChanged} />
        </Modal>
      )}
    </div>
  );
}

export const ARCHIVE_VIEW_TITLE = ARCHIVE_MENU_LABEL;
