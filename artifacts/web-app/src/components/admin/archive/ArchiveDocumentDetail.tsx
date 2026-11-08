/**
 * 자료 상세 — A 기본정보 · B 미리보기 · C 설명/키워드 · D 관련 업무 · E 버전 · F 접근권한 · G 승인 · H AI · I 감사기록.
 * 권한 없는 영역은 숨기며(서버도 해당 데이터를 내려주지 않음), 모든 파일은 권한 검증 API 로만 받는다.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  APPROVAL_STATUS_LABEL, APPROVAL_TYPE_LABEL, AUDIT_ACTION_LABEL, DOC_TYPE_LABEL, LINK_TYPE_LABEL,
  SECURITY_COLOR, SECURITY_LABEL, STATUS_COLOR, STATUS_LABEL, VERSION_STATUS_LABEL, S, badgeStyle, AI_STATUS_LABEL,
  fmtDate, fmtDateTime, fmtSize, printBlob, saveBlob, type AclEntry, type ArchiveApi, type ArchiveFolder, type ArchiveMe,
} from './archiveApi';
import { ArchiveAclEditor } from './ArchiveAclEditor';

type Tab = 'info' | 'links' | 'versions' | 'acl' | 'approvals' | 'ai' | 'audit';

export function ArchiveDocumentDetail({ api, me, docId, folders, onClose, onChanged, onIssue, setToast }: {
  api: ArchiveApi; me: ArchiveMe; docId: number; folders: ArchiveFolder[];
  onClose: () => void; onChanged: () => void; onIssue: (templateId: number) => void; setToast: (m: string) => void;
}) {
  const [doc, setDoc] = useState<any>(null);
  const [error, setError] = useState('');
  const [tab, setTab] = useState<Tab>('info');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try { setDoc(await api.get(`/archive/documents/${docId}`)); setError(''); }
    catch (e: any) { setError(e.message); }
  }, [api, docId]);
  useEffect(() => { load(); }, [load]);

  const has = (a: string) => !!doc?.actions?.includes(a);
  const run = async (fn: () => Promise<any>, ok: string) => {
    setBusy(true);
    try { const r = await fn(); setToast(r?.pendingApproval ? '승인 요청이 등록되었습니다. 승인 후 반영됩니다.' : ok); await load(); onChanged(); }
    catch (e: any) { setToast(e.message); }
    finally { setBusy(false); }
  };

  const download = async (versionId?: number, fileName?: string) => {
    try { const b = await api.fileBlob(docId, { versionId }); saveBlob(b, fileName ?? doc.versions?.[0]?.fileName ?? doc.title); }
    catch (e: any) { setToast(e.message); }
  };
  const print = async () => {
    try {
      const v = shownVersion();
      if (v && !v.inlinePreview) { setToast('이 형식은 브라우저 인쇄를 지원하지 않습니다. 다운로드 후 해당 프로그램에서 인쇄해 주세요.'); return; }
      const b = await api.fileBlob(docId, { inline: true, versionId: v?.id });
      await api.post(`/archive/documents/${docId}/print`, { versionId: v?.id });
      printBlob(b);
    } catch (e: any) { setToast(e.message); }
  };
  const shownVersion = () => doc?.versions?.find((v: any) => v.id === doc.approvedVersionId) ?? doc?.versions?.[0] ?? null;

  if (error) return <Modal onClose={onClose} title="자료 상세"><div style={{ color: '#b91c1c' }}>{error}</div></Modal>;
  if (!doc) return <Modal onClose={onClose} title="자료 상세"><div style={S.muted}>불러오는 중…</div></Modal>;

  const tabs: Array<[Tab, string, boolean]> = [
    ['info', '기본정보·미리보기', true], ['links', '관련 업무', true], ['versions', '버전·변경이력', true],
    ['acl', '접근권한', has('manage')], ['approvals', '승인 이력', doc.canSeeUnapproved], ['ai', 'AI 분석·활용', true],
    ['audit', '감사기록', !!doc.audit],
  ];
  const isTemplate = doc.docType === 'form_template' || doc.isStandardForm;

  return (
    <Modal onClose={onClose} title={doc.title} wide>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', marginBottom: 10 }}>
        <span style={badgeStyle(STATUS_COLOR[doc.status])}>{STATUS_LABEL[doc.status] ?? doc.status}</span>
        <span style={badgeStyle(SECURITY_COLOR[doc.securityLevel])}>{SECURITY_LABEL[doc.securityLevel]}</span>
        <span style={badgeStyle('#4b5563')}>{DOC_TYPE_LABEL[doc.docType] ?? doc.docType}</span>
        {doc.isStandardForm && <span style={badgeStyle('#0891b2')}>표준양식(원본 보존)</span>}
        {doc.status === 'revised' && <span style={S.muted}>· 개정본 검토 중 — 일반 사용자에게는 최신 승인본이 제공됩니다</span>}
        <span style={{ flex: 1 }} />
        {has('download') && <button type="button" style={S.btn} disabled={busy} onClick={() => download()} data-testid="archive-detail-download" aria-label="다운로드">⬇ 다운로드</button>}
        {has('print') && <button type="button" style={S.btn} disabled={busy} onClick={print} data-testid="archive-detail-print" aria-label="인쇄">🖨 인쇄</button>}
        {isTemplate && me.canUpload && has('download') && <button type="button" style={S.btn} onClick={() => onIssue(doc.id)} data-testid="archive-detail-issue" aria-label="양식으로 작성본 등록">📝 작성·발급본 등록</button>}
      </div>

      <div style={{ display: 'flex', gap: 2, borderBottom: '1px solid #e5e7eb', marginBottom: 12, flexWrap: 'wrap' }}>
        {tabs.filter(t => t[2]).map(([k, label]) => (
          <button key={k} type="button" onClick={() => setTab(k)} data-testid={`archive-detail-tab-${k}`} aria-label={label}
            style={{ padding: '7px 12px', border: 0, borderBottom: tab === k ? '2px solid #2563eb' : '2px solid transparent', background: 'none', cursor: 'pointer', fontSize: 13, fontWeight: tab === k ? 700 : 400, color: tab === k ? '#1d4ed8' : '#4b5563' }}>
            {label}
          </button>
        ))}
      </div>

      {tab === 'info' && <InfoTab api={api} doc={doc} folders={folders} canEdit={has('edit')} canDelete={has('delete')} busy={busy} run={run} onDeleted={onClose} version={shownVersion()} canPreview={has('preview')} me={me} />}
      {tab === 'links' && <LinksTab api={api} doc={doc} canEdit={has('edit')} run={run} />}
      {tab === 'versions' && <VersionsTab api={api} doc={doc} canEdit={has('edit')} canDownload={has('download')} run={run} download={download} />}
      {tab === 'acl' && <AclTab api={api} doc={doc} run={run} />}
      {tab === 'approvals' && <ApprovalsList approvals={doc.approvals} />}
      {tab === 'ai' && <AiTab api={api} doc={doc} canEdit={has('edit')} busy={busy} run={run} />}
      {tab === 'audit' && <AuditList rows={doc.audit ?? []} />}
    </Modal>
  );
}

// ─── A·B·C 기본정보 / 미리보기 / 설명 ────────────────────────────────────────

function InfoTab({ api, doc, folders, canEdit, canDelete, busy, run, onDeleted, version, canPreview, me }: any) {
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<any>({});
  const [moveTo, setMoveTo] = useState('');
  useEffect(() => {
    setForm({
      title: doc.title, docType: doc.docType, description: doc.description ?? '', keywords: doc.keywords ?? '', authorName: doc.authorName ?? '',
      ownerDepartment: doc.ownerDepartment ?? '', documentDate: doc.documentDate ?? '', securityLevel: doc.securityLevel, aiAllowed: doc.aiAllowed,
      retentionUntil: doc.retentionUntil ?? '', expiresAt: doc.expiresAt ?? '', requiresApproval: doc.requiresApproval, isStandardForm: doc.isStandardForm,
    });
  }, [doc]);
  const set = (k: string, v: any) => setForm((f: any) => ({ ...f, [k]: v }));
  const uploadFolders = folders.filter((f: ArchiveFolder) => f.isActive && f.actions.includes('upload') && f.id !== doc.folderId);

  const row = (label: string, value: React.ReactNode) => (
    <div style={{ display: 'flex', fontSize: 13, padding: '5px 0', borderBottom: '1px solid #f3f4f6' }}>
      <div style={{ width: 110, color: '#6b7280', flexShrink: 0 }}>{label}</div><div style={{ flex: 1 }}>{value || '—'}</div>
    </div>
  );

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(280px, 1fr) minmax(320px, 1.3fr)', gap: 16 }}>
      <div>
        <h3 style={{ ...S.h2, fontSize: 13 }}>A. 기본정보</h3>
        {!editing ? (
          <>
            {row('분류', doc.folderPath)}
            {row('작성자', doc.authorName)}
            {row('관리부서', doc.ownerDepartment)}
            {row('작성일', doc.documentDate)}
            {row('등록자', doc.createdByName)}
            {row('등록일', fmtDateTime(doc.createdAt))}
            {row('수정일', fmtDateTime(doc.updatedAt))}
            {row('보존기한', doc.retentionUntil)}
            {row('만료일', doc.expiresAt)}
            {row('승인 필요', doc.requiresApproval || doc.isStandardForm ? '예' : '아니오')}
            {doc.template && row('원본 양식', `${doc.template.title} (#${doc.template.id})`)}
            <h3 style={{ ...S.h2, fontSize: 13, marginTop: 14 }}>C. 설명 및 키워드</h3>
            <div style={{ fontSize: 13, whiteSpace: 'pre-wrap', color: '#374151' }}>{doc.description || <span style={S.muted}>설명 없음</span>}</div>
            {doc.keywords && <div style={{ marginTop: 6, display: 'flex', gap: 4, flexWrap: 'wrap' }}>{String(doc.keywords).split(/[,\s]+/).filter(Boolean).map((k: string) => <span key={k} style={badgeStyle('#6366f1')}>#{k}</span>)}</div>}
            {doc.issued?.length > 0 && (
              <>
                <h3 style={{ ...S.h2, fontSize: 13, marginTop: 14 }}>작성·발급 이력</h3>
                {doc.issued.map((i: any) => <div key={i.id} style={{ fontSize: 12, padding: '2px 0' }}>#{i.id} {i.title} · {STATUS_LABEL[i.status]} · {fmtDate(i.createdAt)}</div>)}
              </>
            )}
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 14 }}>
              {canEdit && <button type="button" style={S.btn} onClick={() => setEditing(true)} data-testid="archive-detail-edit" aria-label="정보 수정">정보 수정</button>}
              {canEdit && doc.status !== 'discarded' && (
                <button type="button" style={S.btn} disabled={busy} data-testid="archive-detail-discard" aria-label="폐기"
                  onClick={() => { const r = window.prompt('폐기 사유를 입력하세요'); if (r !== null) run(() => api.post(`/archive/documents/${doc.id}/discard`, { reason: r }), '폐기 처리되었습니다.'); }}>폐기</button>
              )}
              {canDelete && (
                <button type="button" style={S.btnDanger} disabled={busy} data-testid="archive-detail-delete" aria-label="휴지통으로 삭제"
                  onClick={async () => {
                    const r = window.prompt('삭제 사유(선택). 휴지통으로 이동하며 복원할 수 있습니다.');
                    if (r === null) return;
                    await run(() => api.del(`/archive/documents/${doc.id}`, { reason: r }), '휴지통으로 이동했습니다.');
                    onDeleted();
                  }}>삭제</button>
              )}
            </div>
            {canEdit && uploadFolders.length > 0 && (
              <div style={{ display: 'flex', gap: 6, marginTop: 10 }}>
                <select style={{ ...S.input, flex: 1 }} value={moveTo} onChange={e => setMoveTo(e.target.value)} aria-label="이동할 폴더" data-testid="archive-detail-move-target">
                  <option value="">다른 폴더로 이동…</option>
                  {uploadFolders.map((f: ArchiveFolder) => <option key={f.id} value={f.id}>{f.path}</option>)}
                </select>
                <button type="button" style={S.btn} disabled={!moveTo || busy} data-testid="archive-detail-move" aria-label="자료 이동"
                  onClick={() => run(() => api.post(`/archive/documents/${doc.id}/move`, { folderId: Number(moveTo) }), '이동했습니다.').then(() => setMoveTo(''))}>이동</button>
              </div>
            )}
          </>
        ) : (
          <div style={{ display: 'grid', gap: 8 }}>
            <Field label="자료명"><input style={S.input} value={form.title} onChange={e => set('title', e.target.value)} aria-label="자료명" data-testid="archive-edit-title" /></Field>
            <Field label="자료 유형">
              <select style={S.input} value={form.docType} onChange={e => set('docType', e.target.value)} aria-label="자료 유형" data-testid="archive-edit-doctype">
                {Object.entries(DOC_TYPE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
            </Field>
            <Field label="설명"><textarea style={{ ...S.input, minHeight: 60 }} value={form.description} onChange={e => set('description', e.target.value)} aria-label="설명" data-testid="archive-edit-description" /></Field>
            <Field label="키워드(쉼표 구분)"><input style={S.input} value={form.keywords} onChange={e => set('keywords', e.target.value)} aria-label="키워드" data-testid="archive-edit-keywords" /></Field>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              <Field label="작성자"><input style={S.input} value={form.authorName} onChange={e => set('authorName', e.target.value)} aria-label="작성자" data-testid="archive-edit-author" /></Field>
              <Field label="관리부서"><input style={S.input} value={form.ownerDepartment} onChange={e => set('ownerDepartment', e.target.value)} aria-label="관리부서" data-testid="archive-edit-dept" /></Field>
              <Field label="작성일"><input type="date" style={S.input} value={form.documentDate} onChange={e => set('documentDate', e.target.value)} aria-label="작성일" data-testid="archive-edit-docdate" /></Field>
              <Field label="보안등급">
                <select style={S.input} value={form.securityLevel} onChange={e => set('securityLevel', e.target.value)} aria-label="보안등급" data-testid="archive-edit-security">
                  {Object.entries(SECURITY_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </select>
              </Field>
              <Field label="보존기한"><input type="date" style={S.input} value={form.retentionUntil} onChange={e => set('retentionUntil', e.target.value)} aria-label="보존기한" data-testid="archive-edit-retention" /></Field>
              <Field label="만료일"><input type="date" style={S.input} value={form.expiresAt} onChange={e => set('expiresAt', e.target.value)} aria-label="만료일" data-testid="archive-edit-expires" /></Field>
            </div>
            <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', fontSize: 13 }}>
              {/* AI 직원 업무 활용·공식 서식/매뉴얼 지정은 관리자 승인 사항 — 승인권자·관리자만 켤 수 있음(서버에서도 강제) */}
              <label title={!(me.canApprove || me.isArchiveAdmin) && !doc.aiAllowed ? '관리자 승인 권한 필요' : undefined}><input type="checkbox" checked={form.aiAllowed} onChange={e => set('aiAllowed', e.target.checked)} aria-label="AI 활용 허용" data-testid="archive-edit-ai" disabled={!doc.aiAllowed && !(me.canApprove || me.isArchiveAdmin)} /> AI 직원 활용 허용</label>
              <label><input type="checkbox" checked={form.requiresApproval} onChange={e => set('requiresApproval', e.target.checked)} aria-label="승인 필요" data-testid="archive-edit-approval" disabled={doc.requiresApproval && !me.canApprove} /> 변경 시 승인 필요</label>
              <label title={!(me.canApprove || me.isArchiveAdmin) ? '관리자 승인 권한 필요' : undefined}><input type="checkbox" checked={form.isStandardForm} onChange={e => set('isStandardForm', e.target.checked)} aria-label="공식 서식·매뉴얼 지정" data-testid="archive-edit-standard" disabled={!(me.canApprove || me.isArchiveAdmin)} /> 공식 서식·매뉴얼 지정</label>
            </div>
            <div style={{ display: 'flex', gap: 6 }}>
              <button type="button" style={S.btnPrimary} disabled={busy} data-testid="archive-edit-save" aria-label="저장"
                onClick={() => run(() => api.patch(`/archive/documents/${doc.id}`, { ...form, documentDate: form.documentDate || null, retentionUntil: form.retentionUntil || null, expiresAt: form.expiresAt || null }), '저장했습니다.').then(() => setEditing(false))}>저장</button>
              <button type="button" style={S.btn} onClick={() => setEditing(false)} data-testid="archive-edit-cancel" aria-label="취소">취소</button>
            </div>
          </div>
        )}
      </div>
      <div>
        <h3 style={{ ...S.h2, fontSize: 13 }}>B. 파일 미리보기 {version && <span style={S.muted}>· v{version.versionNo} {VERSION_STATUS_LABEL[version.status]} · {version.fileName}</span>}</h3>
        {canPreview ? <Preview api={api} docId={doc.id} version={version} /> : <div style={S.muted}>미리보기 권한이 없습니다.</div>}
      </div>
    </div>
  );
}

function Preview({ api, docId, version }: { api: ArchiveApi; docId: number; version: any }) {
  const [url, setUrl] = useState<string | null>(null);
  const [text, setText] = useState<string | null>(null);
  const [err, setErr] = useState('');
  const urlRef = useRef<string | null>(null);
  useEffect(() => {
    let alive = true;
    setUrl(null); setText(null); setErr('');
    if (!version) { setErr('제공 가능한 버전이 없습니다.'); return; }
    (async () => {
      try {
        if (version.inlinePreview && !String(version.mimeType).startsWith('text/')) {
          const b = await api.fileBlob(docId, { inline: true, versionId: version.id });
          if (!alive) return;
          const u = URL.createObjectURL(b); urlRef.current = u; setUrl(u);
        } else {
          const r = await api.get(`/archive/documents/${docId}/text?versionId=${version.id}`);
          if (alive) setText(r.text || '');
        }
      } catch (e: any) { if (alive) setErr(e.message); }
    })();
    return () => { alive = false; if (urlRef.current) { URL.revokeObjectURL(urlRef.current); urlRef.current = null; } };
  }, [api, docId, version]);
  const box: React.CSSProperties = { border: '1px solid #e5e7eb', borderRadius: 8, height: 480, background: '#f9fafb' };
  if (err) return <div style={{ ...box, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#9ca3af', fontSize: 13 }}>{err}</div>;
  if (url && String(version.mimeType).startsWith('image/')) return <div style={{ ...box, overflow: 'auto', textAlign: 'center' }}><img src={url} alt={version.fileName} style={{ maxWidth: '100%' }} /></div>;
  if (url) return <iframe title="문서 미리보기" src={url} style={{ ...box, width: '100%' }} data-testid="archive-preview-frame" />;
  if (text !== null) return (
    <div>
      {!version.inlinePreview && <div style={{ ...S.muted, marginBottom: 6 }}>※ Office·한글 문서는 원본 레이아웃 대신 추출된 본문 텍스트로 미리봅니다(원본은 다운로드).</div>}
      <pre style={{ ...box, margin: 0, padding: 12, overflow: 'auto', whiteSpace: 'pre-wrap', fontSize: 12, fontFamily: 'inherit' }} data-testid="archive-preview-text">{text || '추출된 텍스트가 없습니다.'}</pre>
    </div>
  );
  return <div style={{ ...box, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#9ca3af' }}>불러오는 중…</div>;
}

// ─── D. 관련 업무 ───────────────────────────────────────────────────────────

function LinksTab({ api, doc, canEdit, run }: any) {
  const [type, setType] = useState('company');
  const [q, setQ] = useState('');
  const [results, setResults] = useState<Array<{ id: number; label: string }>>([]);
  const search = async () => { try { setResults(await api.get(`/archive/lookup/entities?type=${type}&q=${encodeURIComponent(q)}`)); } catch { setResults([]); } };
  return (
    <div>
      <h3 style={{ ...S.h2, fontSize: 13 }}>D. 관련 업무 연결 <span style={S.muted}>(기존 업무 데이터는 변경하지 않고 식별자만 참조)</span></h3>
      {doc.links.length === 0 && <div style={S.muted}>연결된 업무가 없습니다.</div>}
      {doc.links.map((l: any) => (
        <div key={l.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 0', borderBottom: '1px solid #f3f4f6', fontSize: 13 }}>
          <span style={badgeStyle('#4b5563')}>{LINK_TYPE_LABEL[l.entityType] ?? l.entityType}</span>
          <span style={{ flex: 1 }}>{l.label} <span style={S.muted}>#{l.entityId}</span></span>
          {canEdit && <button type="button" style={{ ...S.btn, padding: '3px 8px', fontSize: 12 }} data-testid={`archive-link-remove-${l.id}`} aria-label="연결 해제"
            onClick={() => run(() => api.del(`/archive/documents/${doc.id}/links/${l.id}`), '연결을 해제했습니다.')}>해제</button>}
        </div>
      ))}
      {canEdit && (
        <div style={{ marginTop: 12, padding: 10, background: '#f9fafb', borderRadius: 8 }}>
          <div style={{ display: 'flex', gap: 6 }}>
            <select style={{ ...S.input, width: 130 }} value={type} onChange={e => setType(e.target.value)} aria-label="연결 업무 유형" data-testid="archive-link-type">
              {['company', 'contact', 'inquiry', 'quote', 'project', 'translator', 'user'].map(t => <option key={t} value={t}>{LINK_TYPE_LABEL[t]}</option>)}
            </select>
            <input style={{ ...S.input, flex: 1 }} value={q} onChange={e => setQ(e.target.value)} placeholder="이름·번호 검색" aria-label="연결 업무 검색어" data-testid="archive-link-q"
              onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); search(); } }} />
            <button type="button" style={S.btn} onClick={search} data-testid="archive-link-search" aria-label="업무 검색">검색</button>
          </div>
          {results.map(r => (
            <div key={r.id} style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', fontSize: 13 }}>
              <span>{r.label} <span style={S.muted}>#{r.id}</span></span>
              <button type="button" style={{ ...S.btn, padding: '2px 8px', fontSize: 12 }} data-testid={`archive-link-add-${r.id}`} aria-label={`${r.label} 연결`}
                onClick={() => run(() => api.post(`/archive/documents/${doc.id}/links`, { entityType: type, entityId: r.id }), '연결했습니다.')}>연결</button>
            </div>
          ))}
          <div style={{ ...S.muted, marginTop: 6 }}>정산·수금 연결은 해당 업무 ID 기반 확장 지점만 마련되어 있습니다(검색 UI 후속).</div>
        </div>
      )}
    </div>
  );
}

// ─── E. 버전 및 변경 이력 ────────────────────────────────────────────────────

function VersionsTab({ api, doc, canEdit, canDownload, run, download }: any) {
  const [file, setFile] = useState<File | null>(null);
  const [reason, setReason] = useState('');
  const [submit, setSubmit] = useState(true);
  const needsApproval = doc.requiresApproval || doc.isStandardForm;
  return (
    <div>
      <h3 style={{ ...S.h2, fontSize: 13 }}>E. 버전 및 변경 이력 <span style={S.muted}>(승인된 원본은 덮어쓰지 않고 새 버전으로 관리)</span></h3>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead><tr><th style={S.th}>버전</th><th style={S.th}>상태</th><th style={S.th}>파일</th><th style={S.th}>변경 사유</th><th style={S.th}>변경자</th><th style={S.th}>일시</th><th style={S.th}></th></tr></thead>
        <tbody>
          {doc.versions.map((v: any) => (
            <tr key={v.id}>
              <td style={S.td}>v{v.versionNo}{v.id === doc.approvedVersionId && <span style={{ ...badgeStyle('#059669'), marginLeft: 4 }}>최신 승인</span>}</td>
              <td style={S.td}>{VERSION_STATUS_LABEL[v.status] ?? v.status}</td>
              <td style={{ ...S.td, fontSize: 12 }}>{v.fileName}<div style={S.muted}>{fmtSize(v.fileSize)}</div></td>
              <td style={{ ...S.td, fontSize: 12 }}>{v.changeReason ?? '—'}</td>
              <td style={{ ...S.td, fontSize: 12 }}>{v.createdByName ?? '—'}</td>
              <td style={{ ...S.td, fontSize: 12 }}>{fmtDateTime(v.createdAt)}</td>
              <td style={{ ...S.td, whiteSpace: 'nowrap' }}>
                {canDownload && <button type="button" style={{ ...S.btn, padding: '3px 8px', fontSize: 12 }} data-testid={`archive-version-download-${v.id}`} aria-label={`v${v.versionNo} 다운로드`} onClick={() => download(v.id, v.fileName)}>다운로드</button>}
                {canEdit && v.status === 'draft' && <button type="button" style={{ ...S.btn, padding: '3px 8px', fontSize: 12, marginLeft: 4 }} data-testid={`archive-version-submit-${v.id}`} aria-label="검토 요청"
                  onClick={() => run(() => api.post(`/archive/documents/${doc.id}/versions/${v.id}/submit`, {}), '검토를 요청했습니다.')}>검토 요청</button>}
                {canEdit && ['superseded', 'rejected'].includes(v.status) && <button type="button" style={{ ...S.btn, padding: '3px 8px', fontSize: 12, marginLeft: 4 }} data-testid={`archive-version-restore-${v.id}`} aria-label={`v${v.versionNo} 복원`}
                  onClick={() => { const r = window.prompt('복원 사유를 입력하세요'); if (r) run(() => api.post(`/archive/documents/${doc.id}/versions/${v.id}/restore`, { reason: r }), '복원 버전을 등록했습니다.'); }}>복원</button>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {canEdit && doc.status !== 'discarded' && (
        <div style={{ marginTop: 12, padding: 10, background: '#f9fafb', borderRadius: 8, display: 'grid', gap: 8 }}>
          <div style={{ fontSize: 13, fontWeight: 600 }}>새 버전 등록 {needsApproval && <span style={S.muted}>· 승인 후 최신 승인본으로 반영됩니다</span>}</div>
          <input type="file" onChange={e => setFile(e.target.files?.[0] ?? null)} aria-label="새 버전 파일" data-testid="archive-version-file" />
          <input style={S.input} value={reason} onChange={e => setReason(e.target.value)} placeholder="변경 사유(필수)" aria-label="변경 사유" data-testid="archive-version-reason" />
          {needsApproval && <label style={{ fontSize: 12 }}><input type="checkbox" checked={submit} onChange={e => setSubmit(e.target.checked)} aria-label="바로 검토 요청" data-testid="archive-version-submitnow" /> 등록과 동시에 검토 요청(해제 시 초안 저장)</label>}
          <button type="button" style={{ ...S.btnPrimary, justifySelf: 'start', opacity: file && reason.trim() ? 1 : 0.5 }} disabled={!file || !reason.trim()} data-testid="archive-version-upload" aria-label="새 버전 등록"
            onClick={() => run(() => api.upload(`/archive/documents/${doc.id}/versions`, file!, file!.name, { reason, submit }).then((r: { data: any }) => r.data), '새 버전을 등록했습니다.').then(() => { setFile(null); setReason(''); })}>등록</button>
        </div>
      )}
    </div>
  );
}

// ─── F. 접근권한 ────────────────────────────────────────────────────────────

function AclTab({ api, doc, run }: any) {
  const [state, setState] = useState<{ own: AclEntry[]; inherited: AclEntry[]; inheritanceBroken: boolean } | null>(null);
  const [entries, setEntries] = useState<AclEntry[]>([]);
  const [breakInherit, setBreakInherit] = useState(false);
  const [reason, setReason] = useState('');
  useEffect(() => {
    api.get(`/archive/documents/${doc.id}/acl`).then((s: any) => { setState(s); setEntries(s.own.filter((e: AclEntry) => e.subjectType !== 'no_inherit')); setBreakInherit(s.inheritanceBroken); }).catch(() => setState(null));
  }, [api, doc.id]);
  if (!state) return <div style={S.muted}>불러오는 중…</div>;
  const confidential = ['confidential', 'secret'].includes(doc.securityLevel);
  return (
    <div>
      <h3 style={{ ...S.h2, fontSize: 13 }}>F. 접근권한 <span style={S.muted}>(기본 비공개 · 명시적 차단이 허용보다 우선)</span></h3>
      <label style={{ fontSize: 13, display: 'block', marginBottom: 8 }}>
        <input type="checkbox" checked={breakInherit} onChange={e => setBreakInherit(e.target.checked)} aria-label="폴더 권한 상속 해제" data-testid="archive-acl-break-inherit" /> 폴더 권한 상속 해제(이 문서는 아래 지정 대상·등록자·관리자만 접근)
      </label>
      <ArchiveAclEditor api={api} entries={entries} onChange={setEntries} inherited={breakInherit ? [] : state.inherited} testIdPrefix="archive-doc-acl" />
      {confidential && <div style={{ ...S.muted, color: '#b45309', marginTop: 8 }}>기밀·극비 자료의 권한 변경은 승인권자 승인 후 반영됩니다.</div>}
      <div style={{ display: 'flex', gap: 6, marginTop: 10 }}>
        <input style={{ ...S.input, flex: 1 }} value={reason} onChange={e => setReason(e.target.value)} placeholder="변경 사유" aria-label="권한 변경 사유" data-testid="archive-acl-reason" />
        <button type="button" style={S.btnPrimary} data-testid="archive-acl-save" aria-label="권한 저장"
          onClick={() => run(() => api.put(`/archive/documents/${doc.id}/acl`, { entries: [...(breakInherit ? [{ subjectType: 'no_inherit', effect: 'allow', actions: [] }] : []), ...entries], reason }), '권한을 저장했습니다.')}>권한 저장</button>
      </div>
    </div>
  );
}

// ─── G·H·I ──────────────────────────────────────────────────────────────────

function ApprovalsList({ approvals }: { approvals: any[] }) {
  return (
    <div>
      <h3 style={{ ...S.h2, fontSize: 13 }}>G. 승인 이력</h3>
      {approvals.length === 0 && <div style={S.muted}>승인 이력이 없습니다.</div>}
      {approvals.map(a => (
        <div key={a.id} style={{ padding: '8px 0', borderBottom: '1px solid #f3f4f6', fontSize: 13 }}>
          <span style={badgeStyle(a.status === 'approved' ? '#059669' : a.status === 'rejected' ? '#dc2626' : '#d97706')}>{APPROVAL_STATUS_LABEL[a.status]}</span>{' '}
          <b>{APPROVAL_TYPE_LABEL[a.requestType] ?? a.requestType}</b>{a.isAiAuthored && <span style={{ ...badgeStyle('#7c3aed'), marginLeft: 4 }}>AI 작성</span>}
          <div style={S.muted}>요청: {a.requesterName ?? '—'} · {fmtDateTime(a.requestedAt)}{a.reason ? ` · 사유: ${a.reason}` : ''}</div>
          {a.decidedAt && <div style={S.muted}>처리: {a.deciderName ?? '—'} · {fmtDateTime(a.decidedAt)}{a.decisionNote ? ` · 의견: ${a.decisionNote}` : ''}</div>}
        </div>
      ))}
    </div>
  );
}

function AiTab({ api, doc, canEdit, busy, run }: { api: ArchiveApi; doc: any; canEdit: boolean; busy: boolean; run: (fn: () => Promise<any>, ok: string) => void }) {
  const eligible = doc.aiAllowed && doc.approvedVersionId && doc.status !== 'discarded';
  const a = doc.aiAnalysis as Record<string, any> | null;
  const st = AI_STATUS_LABEL[doc.aiStatus] ?? [doc.aiStatus, '#6b7280'];
  const row = (k: string, v: React.ReactNode) => (v == null || v === '' || (Array.isArray(v) && !v.length)) ? null
    : <div style={{ display: 'flex', gap: 8, padding: '3px 0' }}><span style={{ width: 110, flexShrink: 0, color: '#6b7280' }}>{k}</span><span style={{ minWidth: 0, overflowWrap: 'anywhere' }}>{v}</span></div>;
  return (
    <div style={{ fontSize: 13 }}>
      <h3 style={{ ...S.h2, fontSize: 13 }}>H. AI 등록 분석 <span style={S.muted}>(등록 처리용 자동 분류 — 문서에 없는 내용은 기록하지 않음)</span></h3>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
        <span style={badgeStyle(st[1])} data-testid="archive-ai-status">{st[0]}</span>
        {a?.analyzedAt && <span style={S.muted}>{fmtDateTime(a.analyzedAt)}</span>}
        {canEdit && doc.aiStatus !== 'analyzing' && (
          <button type="button" style={{ ...S.btn, marginLeft: 'auto' }} disabled={busy} data-testid="archive-ai-reanalyze" aria-label="AI 재분석"
            onClick={() => run(() => api.post(`/archive/documents/${doc.id}/reanalyze`), 'AI 재분석을 완료했습니다.')}>AI 재분석</button>
        )}
      </div>
      {doc.aiSummary && <div style={{ padding: 10, background: '#f8fafc', border: '1px solid #e5e7eb', borderRadius: 8, marginBottom: 8, whiteSpace: 'pre-wrap' }}>{doc.aiSummary}</div>}
      {a && <>
        {row('분류', a.categoryLabel ? `${a.categoryLabel}${a.confidence ? ` (신뢰도 ${a.confidence === 'high' ? '높음' : a.confidence === 'medium' ? '보통' : '낮음'})` : ''}` : null)}
        {row('서식·매뉴얼 종류', a.formKind || a.manualKind)}
        {row('관련 업무', a.relatedWork)}
        {row('관련 부서', a.relatedDepartment)}
        {row('작성일', a.documentDate ? `${a.documentDate} · 근거: "${a.dateEvidence?.documentDate ?? ''}"` : '미확인')}
        {row('시행일', a.effectiveDate ? `${a.effectiveDate} · 근거: "${a.dateEvidence?.effectiveDate ?? ''}"` : '미확인')}
        {row('만료일', a.expiresAt ? `${a.expiresAt} · 근거: "${a.dateEvidence?.expiresAt ?? ''}"` : '미확인')}
        {row('개인정보', a.containsPersonalInfo === true ? `포함${a.personalInfoTypes?.length ? ` (${a.personalInfoTypes.join(', ')})` : ''}` : a.containsPersonalInfo === false ? '미확인' : null)}
        {row('기밀정보', a.containsConfidential === true ? '포함 가능성' : null)}
        {row('동일 파일', a.duplicateOf?.length ? `기존 자료 #${a.duplicateOf.join(', #')} (기존 자료는 그대로 유지)` : null)}
        {row('개정본 후보', a.possibleRevisionOf?.length ? `기존 자료 #${a.possibleRevisionOf.join(', #')} — 관리자 확인 후 버전 연결` : null)}
        {row('확인 사유', a.reason || (a.error ? 'AI 분석 실패 — 원본 보존, 재분석 가능' : null))}
      </>}
      <h3 style={{ ...S.h2, fontSize: 13, marginTop: 14 }}>AI 직원 활용</h3>
      <div style={{ padding: '4px 0' }}>AI 직원 활용 허용: <b>{doc.aiAllowed ? '허용(관리자 승인)' : '미허용'}</b></div>
      <div style={{ padding: '4px 0' }}>AI 지식검색 대상: <b>{eligible ? '예 — 최신 승인본만 사용' : '아니오'}</b>
        {!eligible && <span style={S.muted}> ({!doc.aiAllowed ? '관리자 승인 전' : !doc.approvedVersionId ? '승인본 없음' : '폐기 자료'})</span>}</div>
    </div>
  );
}

function AuditList({ rows }: { rows: any[] }) {
  return (
    <div>
      <h3 style={{ ...S.h2, fontSize: 13 }}>I. 열람·다운로드 감사기록 <span style={S.muted}>(최근 100건)</span></h3>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead><tr><th style={S.th}>일시</th><th style={S.th}>동작</th><th style={S.th}>사용자</th><th style={S.th}>내용</th></tr></thead>
        <tbody>
          {rows.map(r => (
            <tr key={r.id}>
              <td style={{ ...S.td, fontSize: 12, whiteSpace: 'nowrap' }}>{fmtDateTime(r.createdAt)}</td>
              <td style={{ ...S.td, fontSize: 12 }}>{AUDIT_ACTION_LABEL[r.action] ?? r.action}{r.actorType === 'ai' && ' (AI)'}</td>
              <td style={{ ...S.td, fontSize: 12 }}>{r.userEmail ?? '—'}</td>
              <td style={{ ...S.td, fontSize: 11, color: '#6b7280', maxWidth: 360, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={r.metadata ? JSON.stringify(r.metadata) : ''}>
                {r.metadata ? JSON.stringify(r.metadata) : ''}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ─── 공통 ───────────────────────────────────────────────────────────────────

export function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label style={{ display: 'block' }}><span style={S.label}>{label}</span>{children}</label>;
}

export function Modal({ title, children, onClose, wide }: { title: string; children: React.ReactNode; onClose: () => void; wide?: boolean }) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);
  return (
    <div role="dialog" aria-modal="true" aria-label={title} style={{ position: 'fixed', inset: 0, background: 'rgba(17,24,39,0.45)', zIndex: 1000, display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: '4vh 16px', overflowY: 'auto' }}
      onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={{ background: '#fff', borderRadius: 12, width: '100%', maxWidth: wide ? 1100 : 640, padding: 20, boxShadow: '0 20px 40px rgba(0,0,0,0.2)' }}>
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 12 }}>
          <h2 style={{ ...S.h2, margin: 0, flex: 1, fontSize: 16 }}>{title}</h2>
          <button type="button" onClick={onClose} style={{ ...S.btn, padding: '3px 10px' }} data-testid="archive-modal-close" aria-label="닫기">✕</button>
        </div>
        {children}
      </div>
    </div>
  );
}

