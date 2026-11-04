/**
 * 업무자료 관리 — 5개 업무 분류(매뉴얼·계약·업무기록·인사·경영)를 하나의 화면에서 탭으로 전환한다.
 * 탭 key = 서버 폴더 menuKey(분류 식별자). 목록·검색·권한 필터는 공용 ArchiveDocumentBrowser + 서버 ACL 을 그대로 사용.
 */
import React from 'react';
import { ARCHIVE_MENU_LABEL, S, WORK_TABS, type ArchiveApi, type ArchiveFolder, type ArchiveMe, type WorkTab } from './archiveApi';
import { ArchiveDocumentBrowser } from './ArchiveDocumentBrowser';

export function ArchiveWorkspace({ api, me, folders, tab, onTab, onOpen, onUpload, onNavigate, refreshKey }: {
  api: ArchiveApi; me: ArchiveMe; folders: ArchiveFolder[];
  tab: WorkTab; onTab: (t: WorkTab) => void;
  onOpen: (id: number) => void; onUpload: (folderId: number | null, menuKey: WorkTab) => void;
  onNavigate: (view: string) => void; refreshKey: number;
}) {
  const label = ARCHIVE_MENU_LABEL[tab];
  // 분류가 없을 때 중복 분류를 자동 생성하지 않고 안내만 한다(전체 분류 미생성 안내는 ArchiveModule 상단에서 별도 표시).
  const emptyNotice = me.folderCount > 0 && (
    <div style={{ ...S.card, marginBottom: 12, background: '#f9fafb', fontSize: 13, color: '#4b5563' }} data-testid="archive-work-empty-category">
      {me.isArchiveAdmin
        ? <>‘{label}’ 분류에 연결된 폴더가 없습니다. 자료 관리설정에서 폴더의 메뉴 분류를 지정하거나 분류를 생성해 주세요.
            <button type="button" style={{ ...S.btn, marginLeft: 8 }} onClick={() => onNavigate('settings')} data-testid="archive-work-goto-settings" aria-label="자료 관리설정으로 이동">자료 관리설정</button></>
        : <>‘{label}’ 분류에서 열람 가능한 폴더가 없습니다. 필요한 경우 자료보관함 관리자에게 권한을 요청해 주세요.</>}
    </div>
  );

  return (
    <div data-testid="archive-work">
      <div role="tablist" aria-label="업무자료 분류" style={{ display: 'flex', gap: 4, overflowX: 'auto', borderBottom: '1px solid #e5e7eb', marginBottom: 12, whiteSpace: 'nowrap' }}>
        {WORK_TABS.map(t => {
          const active = t === tab;
          return (
            <button key={t} type="button" role="tab" aria-selected={active} aria-label={`${ARCHIVE_MENU_LABEL[t]} 분류`}
              data-testid={`archive-work-tab-${t}`} onClick={() => onTab(t)}
              style={{
                flexShrink: 0, padding: '9px 16px', border: 0, background: 'none', cursor: 'pointer', fontSize: 14,
                fontWeight: active ? 700 : 500, color: active ? '#1d4ed8' : '#4b5563',
                borderBottom: `2px solid ${active ? '#2563eb' : 'transparent'}`, marginBottom: -1,
              }}>
              {ARCHIVE_MENU_LABEL[t]}
            </button>
          );
        })}
      </div>
      {/* key={tab}: 탭 전환 시 폴더 선택·검색어·필터·페이지를 모두 초기화(이전 분류 조건이 섞이지 않도록) */}
      <ArchiveDocumentBrowser key={tab} api={api} me={me} menu={tab} folders={folders} showTitle={false}
        emptyFolderNotice={emptyNotice} onOpen={onOpen} onUpload={(fid) => onUpload(fid, tab)} refreshKey={refreshKey} />
    </div>
  );
}
