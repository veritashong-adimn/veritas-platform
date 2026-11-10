import React, { useMemo, useState } from 'react';

// ─── 거래처 대량등록 · 변경 원인 분석(읽기 전용) ─────────────────────────────────
//  · 이미 화면에 있는 분석 결과(analysis.rows 의 status='update' 행 changes = { 필드: { old, new } })만 사용한다.
//  · 서버 호출·저장·등록 없음. 기존 분석·등록 로직과 무관(표시 전용).
//  · 분류: 빈 값 채움(기존 공란) / 표기 차이만(정규화 후 동일) / 실제 덮어쓰기(기존 값이 다른 값으로 바뀜).

type Change = { old: string; new: string };
type Row = { status: string; existingId?: number | null; name?: unknown; rowNumber: number; changes?: Record<string, Change> };

const FIELDS: { key: string; label: string }[] = [
  { key: 'name', label: '상호명' },
  { key: 'representativeName', label: '대표자명' },
  { key: 'industry', label: '업태' },
  { key: 'businessCategory', label: '종목' },
  { key: 'address', label: '주소' },
  { key: 'phone', label: '전화번호' },
  { key: 'email', label: '이메일' },
];

const LEGAL = ['주식회사', '유한회사', '유한책임회사', '합자회사', '합명회사', '재단법인', '사단법인', '(주)', '㈜', '(유)', '(재)', '(사)', '(합)'];
const SIDO: [RegExp, string][] = [
  [/서울특별시/g, '서울'], [/부산광역시/g, '부산'], [/대구광역시/g, '대구'], [/인천광역시/g, '인천'], [/광주광역시/g, '광주'],
  [/대전광역시/g, '대전'], [/울산광역시/g, '울산'], [/세종특별자치시/g, '세종'], [/경기도/g, '경기'], [/강원특별자치도|강원도/g, '강원'],
  [/충청북도/g, '충북'], [/충청남도/g, '충남'], [/전북특별자치도|전라북도/g, '전북'], [/전라남도/g, '전남'], [/경상북도/g, '경북'],
  [/경상남도/g, '경남'], [/제주특별자치도/g, '제주'],
];
const squash = (s: string) => s.toLowerCase().replace(/[\s.,·・'"“”‘’()\[\]\-_/\\|&:;]+/g, '');

/** 필드별 '표기 차이' 판정용 정규화 — 이 화면 표시에만 사용(서버 판정과 무관). */
function canon(field: string, v: string): string {
  let s = String(v ?? '').trim();
  if (!s) return '';
  switch (field) {
    case 'name':
      for (const t of LEGAL) s = s.split(t).join(' ');
      s = s.replace(/\b(co\.?,?\s*ltd\.?|inc\.?|corp\.?|llc)\b/gi, ' ');
      return squash(s);
    case 'industry':
    case 'businessCategory':
      // 홈택스는 여러 업태·종목을 나열 — 순서·구분자·공백 차이는 같은 값
      return s.split(/[,/·;\n]+/).map(x => squash(x)).filter(Boolean).sort().join('|');
    case 'address':
      for (const [re, to] of SIDO) s = s.replace(re, to);
      s = s.replace(/\([^)]*\)/g, ' ');            // 괄호 안 동·건물명 보조표기
      return squash(s);
    case 'phone':
      return s.replace(/\D/g, '');
    case 'email':
      return s.toLowerCase().replace(/\s+/g, '');
    default:
      return squash(s);
  }
}

type Kind = 'fill' | 'format' | 'overwrite';
const KIND_LABEL: Record<Kind, string> = { fill: '빈 값 채움', format: '표기 차이만', overwrite: '실제 덮어쓰기' };
const KIND_COLOR: Record<Kind, string> = { fill: '#0369a1', format: '#6b7280', overwrite: '#b45309' };

function classify(field: string, ch: Change): Kind {
  if (!String(ch.old ?? '').trim()) return 'fill';
  return canon(field, ch.old) === canon(field, ch.new) ? 'format' : 'overwrite';
}

export function CompanyChangeAnalysis({ rows }: { rows: Row[] }) {
  const [open, setOpen] = useState(true);
  const [exField, setExField] = useState<string>('name');

  const stat = useMemo(() => {
    // 같은 기존 거래처를 가리키는 수정 행은 1건(서버 반영도 거래처별 1행)
    const byCompany = new Map<number | string, Row>();
    for (const r of rows) {
      if (r.status !== 'update' || !r.changes) continue;
      const k = r.existingId ?? `row:${r.rowNumber}`;
      if (!byCompany.has(k)) byCompany.set(k, r);
    }
    const fieldCount: Record<string, Record<Kind, number>> = {};
    const examples: Record<string, Record<Kind, { company: string; old: string; new: string }[]>> = {};
    for (const f of FIELDS) { fieldCount[f.key] = { fill: 0, format: 0, overwrite: 0 }; examples[f.key] = { fill: [], format: [], overwrite: [] }; }
    let realCompanies = 0, formatOnly = 0, withOverwrite = 0, fillOnly = 0;
    for (const r of byCompany.values()) {
      const kinds = new Set<Kind>();
      for (const [field, ch] of Object.entries(r.changes ?? {})) {
        if (!fieldCount[field]) continue;
        const k = classify(field, ch);
        kinds.add(k);
        fieldCount[field][k]++;
        if (examples[field][k].length < 5) examples[field][k].push({ company: String(r.name ?? ''), old: ch.old, new: ch.new });
      }
      if (kinds.size === 0) continue;
      if (kinds.has('fill') || kinds.has('overwrite')) realCompanies++; else formatOnly++;
      if (kinds.has('overwrite')) withOverwrite++;
      else if (kinds.has('fill')) fillOnly++;
    }
    return { total: byCompany.size, realCompanies, formatOnly, withOverwrite, fillOnly, fieldCount, examples };
  }, [rows]);

  if (stat.total === 0) return null;

  const card = (label: string, value: number, color: string, testid: string, sub?: string) => (
    <div data-testid={testid} style={{ flex: '1 1 150px', background: '#fff', border: '1px solid #e5e7eb', borderRadius: 8, padding: '8px 12px' }}>
      <div style={{ fontSize: 11, color: '#6b7280' }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 800, color }}>{value.toLocaleString()}</div>
      {sub && <div style={{ fontSize: 10.5, color: '#9ca3af' }}>{sub}</div>}
    </div>
  );
  const th: React.CSSProperties = { padding: '6px 10px', fontSize: 12, fontWeight: 700, color: '#374151', background: '#f8fafc', borderBottom: '1px solid #e5e7eb', textAlign: 'right', whiteSpace: 'nowrap' };
  const td: React.CSSProperties = { padding: '6px 10px', fontSize: 12.5, color: '#111827', borderBottom: '1px solid #f1f5f9', textAlign: 'right', fontVariantNumeric: 'tabular-nums' };
  const ex = stat.examples[exField];

  return (
    <div data-testid="company-change-analysis" style={{ background: '#fffdf7', border: '1px solid #fde68a', borderRadius: 10, padding: '12px 14px', marginBottom: 16 }}>
      <button type="button" onClick={() => setOpen(v => !v)} aria-expanded={open} aria-label="변경 원인 분석 접기/펼치기" data-testid="company-change-analysis-toggle"
        style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontSize: 13, fontWeight: 800, color: '#92400e' }}>
        {open ? '▾' : '▸'} 변경 원인 분석 <span style={{ fontWeight: 500, color: '#a16207', fontSize: 12 }}>(정보 수정 예정 {stat.total.toLocaleString()}개 거래처 · 화면 분석 결과 기준 · 읽기 전용)</span>
      </button>
      {open && (<>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', margin: '10px 0' }}>
          {card('정보 수정 예정 거래처', stat.total, '#1d4ed8', 'cca-total')}
          {card('실제 변경 필요', stat.realCompanies, '#b45309', 'cca-real', '빈 값 채움 또는 실제 다른 값 포함')}
          {card('표기 차이만', stat.formatOnly, '#6b7280', 'cca-format-only', '정리하면 기존 값과 같음')}
          {card('기존 값 덮어쓰기 포함', stat.withOverwrite, '#b45309', 'cca-overwrite', '기존 입력값이 다른 값으로 바뀜')}
          {card('빈 값 채움만', stat.fillOnly, '#0369a1', 'cca-fill-only', '기존 공란에 새 값만 추가')}
        </div>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', background: '#fff', border: '1px solid #e5e7eb', borderRadius: 8 }} data-testid="cca-field-table">
            <thead><tr>
              <th style={{ ...th, textAlign: 'left' }}>항목</th><th style={th}>변경 판정</th>
              <th style={{ ...th, color: KIND_COLOR.fill }}>빈 값 채움</th><th style={{ ...th, color: KIND_COLOR.format }}>표기 차이만</th><th style={{ ...th, color: KIND_COLOR.overwrite }}>실제 덮어쓰기</th>
            </tr></thead>
            <tbody>
              {FIELDS.map(f => { const c = stat.fieldCount[f.key]; const sum = c.fill + c.format + c.overwrite; return (
                <tr key={f.key} data-testid={`cca-row-${f.key}`} onClick={() => setExField(f.key)} style={{ cursor: 'pointer', background: exField === f.key ? '#fef9c3' : undefined }}>
                  <td style={{ ...td, textAlign: 'left', fontWeight: 700 }}>{f.label}</td>
                  <td style={td}>{sum.toLocaleString()}</td>
                  <td style={{ ...td, color: KIND_COLOR.fill }}>{c.fill.toLocaleString()}</td>
                  <td style={{ ...td, color: KIND_COLOR.format }}>{c.format.toLocaleString()}</td>
                  <td style={{ ...td, color: KIND_COLOR.overwrite, fontWeight: 700 }}>{c.overwrite.toLocaleString()}</td>
                </tr>
              ); })}
            </tbody>
          </table>
        </div>
        <div style={{ marginTop: 10, fontSize: 12, color: '#374151' }}>
          <b>대표 사례 — {FIELDS.find(f => f.key === exField)?.label}</b> <span style={{ color: '#9ca3af' }}>(표의 항목을 누르면 바뀝니다 · 유형별 최대 5건)</span>
          {(['overwrite', 'format', 'fill'] as Kind[]).map(k => ex[k].length > 0 && (
            <div key={k} style={{ marginTop: 6 }} data-testid={`cca-examples-${k}`}>
              <div style={{ fontWeight: 700, color: KIND_COLOR[k] }}>{KIND_LABEL[k]}</div>
              {ex[k].map((e, i) => (
                <div key={i} style={{ paddingLeft: 10, wordBreak: 'break-all' }}>
                  · {e.company}: <span style={{ color: '#9ca3af', textDecoration: k === 'fill' ? 'none' : 'line-through' }}>{e.old || '(빈 값)'}</span> → <span style={{ color: KIND_COLOR[k] }}>{e.new}</span>
                </div>
              ))}
            </div>
          ))}
        </div>
        <div style={{ marginTop: 8, fontSize: 11, color: '#9ca3af' }}>
          ※ 표기 차이 판정(이 화면 전용): 상호 법인표기·공백·특수문자·대소문자 / 업태·종목 나열 순서·구분자 / 주소 괄호 보조표기·시도 약칭·공백 / 전화 숫자 / 이메일 대소문자. 실제 등록 시 반영 여부는 기존 규칙 그대로입니다.
        </div>
      </>)}
    </div>
  );
}
