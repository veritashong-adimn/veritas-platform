import React from "react";
import { LangExpEntry, emptyLangExp } from "../../lib/constants";

const LEVEL_OPTIONS = ["원어민", "고급", "중급", "초급"] as const;
const ACQUISITION_BG_OPTIONS = [
  "해외거주", "해외유학", "국내교육", "자기학습", "이중언어(가정환경)", "기타",
];

const BOOL_FIELDS: { key: keyof LangExpEntry; label: string }[] = [
  { key: "abroadElementary",    label: "해외초등학교" },
  { key: "abroadMiddle",        label: "해외중학교" },
  { key: "abroadHigh",          label: "해외고등학교" },
  { key: "abroadUniversity",    label: "해외대학교" },
  { key: "abroadGraduate",      label: "해외대학원" },
  { key: "internationalSchool", label: "국제학교" },
  { key: "exchangeStudent",     label: "교환학생" },
  { key: "languageStudyAbroad", label: "어학연수" },
];

const inputS: React.CSSProperties = {
  border: "1px solid #d1d5db", borderRadius: 6, padding: "5px 8px",
  fontSize: 12, color: "#111827", width: "100%", boxSizing: "border-box",
  background: "#fff",
};
const labelS: React.CSSProperties = {
  fontSize: 11, fontWeight: 600, color: "#6b7280", marginBottom: 3, display: "block",
};

interface Props {
  entries: LangExpEntry[];
  onChange: (entries: LangExpEntry[]) => void;
  readOnly?: boolean;
}

export const TranslatorLangExpSection: React.FC<Props> = ({ entries, onChange, readOnly }) => {
  const update = (idx: number, patch: Partial<LangExpEntry>) => {
    onChange(entries.map((e, i) => i === idx ? { ...e, ...patch } : e));
  };

  const addEntry = () => onChange([...entries, emptyLangExp()]);
  const removeEntry = (idx: number) => onChange(entries.filter((_, i) => i !== idx));

  return (
    <div>
      {entries.length === 0 && (
        <div style={{ color: "#9ca3af", fontSize: 12, padding: "10px 0", textAlign: "center" }}>
          등록된 언어·국제경험이 없습니다.
          {!readOnly && " 아래 버튼으로 추가하세요."}
        </div>
      )}

      {entries.map((entry, idx) => (
        <div key={idx} style={{
          border: "1px solid #e5e7eb", borderRadius: 10, padding: "14px 16px",
          marginBottom: 12, background: "#fafafa", position: "relative",
        }}>
          {/* 헤더 */}
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
            <span style={{
              fontSize: 13, fontWeight: 700, color: "#1e40af",
              background: "#eff6ff", border: "1px solid #bfdbfe",
              borderRadius: 20, padding: "2px 12px",
            }}>
              {entry.language || "언어 미지정"}
            </span>
            {entry.canWork && (
              <span style={{
                fontSize: 11, fontWeight: 700, color: "#fff",
                background: "#059669", borderRadius: 20, padding: "2px 8px",
              }}>
                ✓ 실무가능
              </span>
            )}
            {entry.level && (
              <span style={{
                fontSize: 11, fontWeight: 600, color: "#374151",
                background: "#f3f4f6", border: "1px solid #e5e7eb",
                borderRadius: 20, padding: "2px 8px",
              }}>
                {entry.level}
              </span>
            )}
            {!readOnly && (
              <button
                onClick={() => removeEntry(idx)}
                aria-label={`${entry.language || "언어"} 항목 삭제`}
                style={{
                  marginLeft: "auto", fontSize: 11, color: "#dc2626",
                  background: "none", border: "none", cursor: "pointer", padding: "2px 6px",
                }}
              >
                삭제
              </button>
            )}
          </div>

          {/* 기본정보 3열 */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, marginBottom: 10 }}>
            <div>
              <label style={labelS}>언어 *</label>
              {readOnly ? (
                <div style={{ ...inputS, background: "#f9fafb", color: "#374151" }}>{entry.language || "-"}</div>
              ) : (
                <input
                  style={inputS}
                  value={entry.language}
                  placeholder="예: 영어"
                  aria-label="언어"
                  onChange={e => update(idx, { language: e.target.value })}
                />
              )}
            </div>
            <div>
              <label style={labelS}>언어레벨</label>
              {readOnly ? (
                <div style={{ ...inputS, background: "#f9fafb", color: "#374151" }}>{entry.level || "-"}</div>
              ) : (
                <select style={inputS} value={entry.level} aria-label="언어레벨"
                  onChange={e => update(idx, { level: e.target.value as LangExpEntry["level"] })}>
                  <option value="">선택</option>
                  {LEVEL_OPTIONS.map(l => <option key={l} value={l}>{l}</option>)}
                </select>
              )}
            </div>
            <div>
              <label style={labelS}>언어습득배경</label>
              {readOnly ? (
                <div style={{ ...inputS, background: "#f9fafb", color: "#374151" }}>{entry.acquisitionBg || "-"}</div>
              ) : (
                <select style={inputS} value={entry.acquisitionBg} aria-label="언어습득배경"
                  onChange={e => update(idx, { acquisitionBg: e.target.value })}>
                  <option value="">선택</option>
                  {ACQUISITION_BG_OPTIONS.map(o => <option key={o} value={o}>{o}</option>)}
                </select>
              )}
            </div>
          </div>

          {/* 실무 가능 여부 */}
          <div style={{ marginBottom: 10 }}>
            {readOnly ? (
              <span style={{ fontSize: 12, color: entry.canWork ? "#059669" : "#6b7280" }}>
                실무 가능: <strong>{entry.canWork ? "예" : "아니오"}</strong>
              </span>
            ) : (
              <label style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer", fontSize: 12, fontWeight: 600, color: "#374151" }}>
                <input
                  type="checkbox"
                  checked={entry.canWork}
                  aria-label="실무 가능 여부"
                  onChange={e => update(idx, { canWork: e.target.checked })}
                  style={{ width: 14, height: 14, accentColor: "#059669" }}
                />
                실무 가능 (번역·통역 업무 수행 가능한 언어)
              </label>
            )}
          </div>

          {/* 해외거주 정보 3열 */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, marginBottom: 10 }}>
            <div>
              <label style={labelS}>해외거주국가</label>
              {readOnly ? (
                <div style={{ ...inputS, background: "#f9fafb", color: "#374151" }}>{entry.residenceCountry || "-"}</div>
              ) : (
                <input style={inputS} value={entry.residenceCountry} placeholder="예: 미국" aria-label="해외거주국가"
                  onChange={e => update(idx, { residenceCountry: e.target.value })} />
              )}
            </div>
            <div>
              <label style={labelS}>해외거주도시</label>
              {readOnly ? (
                <div style={{ ...inputS, background: "#f9fafb", color: "#374151" }}>{entry.residenceCity || "-"}</div>
              ) : (
                <input style={inputS} value={entry.residenceCity} placeholder="예: 뉴욕" aria-label="해외거주도시"
                  onChange={e => update(idx, { residenceCity: e.target.value })} />
              )}
            </div>
            <div>
              <label style={labelS}>해외거주기간</label>
              {readOnly ? (
                <div style={{ ...inputS, background: "#f9fafb", color: "#374151" }}>{entry.residencePeriod || "-"}</div>
              ) : (
                <input style={inputS} value={entry.residencePeriod} placeholder="예: 3년 6개월" aria-label="해외거주기간"
                  onChange={e => update(idx, { residencePeriod: e.target.value })} />
              )}
            </div>
          </div>

          {/* 체크박스 그리드 */}
          <div style={{ marginBottom: 10 }}>
            <label style={{ ...labelS, marginBottom: 6 }}>해외·국제 교육 경험</label>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: "4px 12px" }}>
              {BOOL_FIELDS.map(({ key, label }) => (
                <label key={key} style={{
                  display: "flex", alignItems: "center", gap: 5,
                  fontSize: 12, cursor: readOnly ? "default" : "pointer",
                  color: (entry[key] as boolean) ? "#1d4ed8" : "#6b7280",
                  fontWeight: (entry[key] as boolean) ? 600 : 400,
                }}>
                  <input
                    type="checkbox"
                    checked={entry[key] as boolean}
                    disabled={readOnly}
                    aria-label={label}
                    onChange={e => !readOnly && update(idx, { [key]: e.target.checked })}
                    style={{ width: 13, height: 13, accentColor: "#1d4ed8" }}
                  />
                  {label}
                </label>
              ))}
            </div>
          </div>

          {/* 비고 */}
          <div>
            <label style={labelS}>비고</label>
            {readOnly ? (
              <div style={{ ...inputS, background: "#f9fafb", color: "#374151", minHeight: 32 }}>
                {entry.notes || "-"}
              </div>
            ) : (
              <input style={inputS} value={entry.notes} placeholder="기타 메모" aria-label="비고"
                onChange={e => update(idx, { notes: e.target.value })} />
            )}
          </div>
        </div>
      ))}

      {!readOnly && (
        <button
          onClick={addEntry}
          aria-label="언어 국제경험 추가"
          style={{
            width: "100%", padding: "8px 0", fontSize: 12, fontWeight: 600,
            color: "#1d4ed8", background: "#eff6ff", border: "1.5px dashed #93c5fd",
            borderRadius: 8, cursor: "pointer", marginTop: 4,
          }}
        >
          + 언어·국제경험 추가
        </button>
      )}
    </div>
  );
};
