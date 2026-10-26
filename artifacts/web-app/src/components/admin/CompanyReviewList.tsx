// 거래처 대량등록 — '확인 필요' 거래처 검토: 사유 · 기존 거래처와 업로드 정보 나란히 비교 · 등록/수정/보류 선택
//   결정하지 않은 행은 보류(반영 안 함). 실행 시 서버가 허용 여부(중복 생성 방지)를 다시 검증한다.
import React from 'react';

const FIELDS: [string, string][] = [['name', '거래처명'], ['representativeName', '대표자'], ['industry', '업태'], ['businessCategory', '종목'], ['address', '주소']];
export const maskBiz = (v: unknown) => {
  const s = String(v ?? ''); const d = s.replace(/\D/g, '');
  if (s.includes('*')) return s;                                   // 서버에서 이미 마스킹(개인 식별번호)
  return d.length === 10 ? `${d.slice(0, 3)}-${d.slice(3, 5)}-*****` : (d ? `${d.slice(0, 3)}***` : '-');
};

export function CompanyReviewList({ rows, decisions, onChange }: {
  rows: any[]; decisions: Record<string, string>; onChange: (rowNumber: number, d: string) => void;
}) {
  const td: React.CSSProperties = { padding: '6px 8px', borderTop: '1px solid #f1f5f9', fontSize: 12, verticalAlign: 'top' };
  return (
    <div data-testid="company-review-list" style={{ display: 'grid', gap: 10, marginBottom: 12 }}>
      <div style={{ fontSize: 12, color: '#6b7280' }}>확인 필요 {rows.length.toLocaleString()}행 — 결정하지 않은 행은 보류되어 반영되지 않습니다. 기존 거래처 ID·담당자·판매·진행 이력은 유지됩니다.</div>
      {rows.map(r => {
        const rv = r.review ?? {}; const ex = rv.existing; const up = rv.upload ?? {};
        const d = decisions[String(r.rowNumber)] ?? 'hold';
        return (
          <div key={r.rowNumber} style={{ border: '1px solid #fde68a', borderRadius: 8, padding: 10, background: '#fffdf5' }} data-testid={`company-review-${r.rowNumber}`}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
              <div style={{ fontSize: 13 }}>
                <b>{r.name || '(거래처명 없음)'}</b> <span style={{ color: '#6b7280' }}>· 사업자번호 {maskBiz(r.businessNumber)} · 엑셀 {r.rowNumber}행{r.existingId ? ` · 기존 거래처 #${r.existingId}` : ''}</span>
              </div>
              <select value={d} onChange={e => onChange(r.rowNumber, e.target.value)} data-testid={`company-review-decision-${r.rowNumber}`} aria-label={`${r.rowNumber}행 처리 결정`}
                style={{ padding: '5px 8px', borderRadius: 6, border: '1px solid #d1d5db', fontSize: 12 }}>
                <option value="hold">보류(반영 안 함)</option>
                {rv.allowUpdate && <option value="update">수정 — 기존 #{r.existingId}에 이 행 값 반영</option>}
                {rv.allowNew && <option value="new">등록 — 신규 거래처로 생성</option>}
              </select>
            </div>
            <div style={{ fontSize: 12, color: '#b45309', marginTop: 4 }}>사유: {r.reason ?? '-'}</div>
            {ex ? (
              <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 6 }}>
                <thead><tr style={{ textAlign: 'left', fontSize: 11.5, color: '#6b7280' }}><th style={{ padding: '4px 8px', width: 90 }}>항목</th><th style={{ padding: '4px 8px' }}>기존 거래처 #{ex.id}</th><th style={{ padding: '4px 8px' }}>업로드(엑셀 {r.rowNumber}행)</th></tr></thead>
                <tbody>
                  {FIELDS.map(([k, label]) => {
                    const a = ex[k] ?? ''; const b = up[k] ?? '';
                    const diff = !!b && String(a).trim() !== String(b).trim();
                    return (<tr key={k}><td style={{ ...td, color: '#6b7280' }}>{label}</td><td style={td}>{a || <span style={{ color: '#9ca3af' }}>(없음)</span>}</td>
                      <td style={{ ...td, color: diff ? '#c2410c' : '#374151', fontWeight: diff ? 700 : 400 }}>{b || <span style={{ color: '#9ca3af' }}>(빈 셀 — 기존 유지)</span>}</td></tr>);
                  })}
                </tbody>
              </table>
            ) : (
              <div style={{ fontSize: 12, color: '#6b7280', marginTop: 4 }}>
                업로드 정보: {FIELDS.map(([k, l]) => up[k] ? `${l} ${up[k]}` : null).filter(Boolean).join(' · ') || '-'}
                {!rv.allowNew && <span style={{ color: '#b91c1c' }}> · 같은 사업자번호의 기존 거래처가 있어 신규 등록 불가</span>}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
