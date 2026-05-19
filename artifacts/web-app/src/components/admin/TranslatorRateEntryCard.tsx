import React, { useState } from "react";
import { ClickSelect, NumericInput } from "../ui";
import {
  SERVICE_TYPES as WORK_TYPES,
  SUB_SERVICE_TYPES as SUB_TYPES_MAP,
  UNIT_BY_SERVICE_TYPE as UNIT_BY_TYPE,
} from "./translatorRateConstants";
import { LanguageSearchSelect, LangCustomInput, isLangCustom } from "./LanguageSearchSelect";

export type RateEntryData = {
  workType: string;
  subType: string;
  sourceLang: string;
  sourceCustom: string;
  targetLang: string;
  targetCustom: string;
  unit: string;
  rate: string;
  currency: string;
  vatIncluded: boolean;
  isDefault: boolean;
  isActive: boolean;
  memo: string;
  minPrice: string;
  baseHours: string;
  overtimeRate: string;
};

export const emptyRateEntry = (): RateEntryData => ({
  workType: "번역",
  subType: "일반번역",
  sourceLang: "한국어",
  sourceCustom: "",
  targetLang: "영어",
  targetCustom: "",
  unit: "eojeol",
  rate: "",
  currency: "KRW",
  vatIncluded: false,
  isDefault: false,
  isActive: true,
  memo: "",
  minPrice: "",
  baseHours: "",
  overtimeRate: "",
});

const inputStyle: React.CSSProperties = {
  width: "100%", padding: "6px 10px", borderRadius: 7,
  border: "1px solid #d1d5db", fontSize: 13, color: "#111827",
  outline: "none", boxSizing: "border-box", background: "#fff",
};
const label11: React.CSSProperties = { fontSize: 11, color: "#6b7280", marginBottom: 2 };

interface Props {
  value: RateEntryData;
  onChange: (patch: Partial<RateEntryData>) => void;
  onRemove?: () => void;
  error?: string;
  actionLabel?: string;
  onAction?: () => void;
  actionLoading?: boolean;
}

export function TranslatorRateEntryCard({
  value: r,
  onChange,
  onRemove,
  error,
  actionLabel,
  onAction,
  actionLoading,
}: Props) {
  const [showAdvanced, setShowAdvanced] = useState(false);
  const up = (patch: Partial<RateEntryData>) => onChange(patch);
  const unitOpts = UNIT_BY_TYPE[r.workType] ?? UNIT_BY_TYPE["번역"];

  return (
    <div style={{ background: "#f8fafc", border: "1px solid #e5e7eb", borderRadius: 10, padding: "10px 12px" }}>
      {/* 행1: 업무유형 / 세부유형 */}
      <div style={{ display: "grid", gridTemplateColumns: onRemove ? "1fr 1fr auto" : "1fr 1fr", gap: "6px 8px", marginBottom: 6, alignItems: "end" }}>
        <div>
          <div style={label11}>업무유형</div>
          <ClickSelect value={r.workType}
            onChange={v => {
              const units = UNIT_BY_TYPE[v] ?? UNIT_BY_TYPE["번역"];
              const subs = SUB_TYPES_MAP[v] ?? [];
              up({ workType: v, subType: subs[0] ?? "", unit: units[0]?.value ?? "eojeol" });
            }}
            triggerStyle={{ fontSize: 13, padding: "6px 10px", borderRadius: 7, width: "100%" }}
            options={WORK_TYPES.map(w => ({ value: w, label: w }))} />
        </div>
        <div>
          <div style={label11}>세부유형</div>
          <ClickSelect value={r.subType}
            onChange={v => up({ subType: v })}
            triggerStyle={{ fontSize: 13, padding: "6px 10px", borderRadius: 7, width: "100%" }}
            options={[{ value: "", label: "세부유형 선택" }, ...(SUB_TYPES_MAP[r.workType] ?? []).map(s => ({ value: s, label: s }))]} />
        </div>
        {onRemove && (
          <button onClick={onRemove}
            style={{ background: "none", border: "none", color: "#dc2626", fontSize: 18, cursor: "pointer", padding: "0 4px", marginTop: 16 }}>
            ×
          </button>
        )}
      </div>

      {/* 행2: 출발언어 / 도착언어 (searchable) */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "6px 8px", marginBottom: 6 }}>
        <div>
          <div style={label11}>출발 언어</div>
          <LanguageSearchSelect
            value={r.sourceLang}
            onChange={v => up({ sourceLang: v, sourceCustom: "" })}
            mode="label"
            placeholder="출발언어 선택..."
            triggerStyle={{ fontSize: 13, padding: "6px 10px", borderRadius: 7, width: "100%" }}
          />
          {isLangCustom(r.sourceLang, "label") && (
            <LangCustomInput
              value={r.sourceCustom}
              onChange={v => up({ sourceCustom: v })}
              label="직접 입력 출발언어"
            />
          )}
        </div>
        <div>
          <div style={label11}>도착 언어</div>
          <LanguageSearchSelect
            value={r.targetLang}
            onChange={v => up({ targetLang: v, targetCustom: "" })}
            mode="label"
            placeholder="도착언어 선택..."
            triggerStyle={{ fontSize: 13, padding: "6px 10px", borderRadius: 7, width: "100%" }}
          />
          {isLangCustom(r.targetLang, "label") && (
            <LangCustomInput
              value={r.targetCustom}
              onChange={v => up({ targetCustom: v })}
              label="직접 입력 도착언어"
            />
          )}
        </div>
      </div>

      {/* 행3: 단가단위 / 단가 / 통화 / VAT / 기본단가 / 활성 */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 100px 80px auto auto auto", gap: "6px 8px", marginBottom: 6, alignItems: "end" }}>
        <div>
          <div style={label11}>단가단위</div>
          <ClickSelect value={r.unit}
            onChange={v => up({ unit: v })}
            triggerStyle={{ fontSize: 13, padding: "6px 10px", borderRadius: 7, width: "100%" }}
            options={unitOpts} />
        </div>
        <div>
          <div style={label11}>단가</div>
          <NumericInput value={r.rate} onChange={raw => up({ rate: raw })}
            allowDecimal placeholder="예: 40" style={inputStyle} />
        </div>
        <div>
          <div style={label11}>통화</div>
          <ClickSelect value={r.currency}
            onChange={v => up({ currency: v })}
            triggerStyle={{ fontSize: 13, padding: "6px 10px", borderRadius: 7, width: "100%" }}
            options={["KRW","USD","EUR","JPY","CNY"].map(c => ({ value: c, label: c }))} />
        </div>
        <label style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 2, fontSize: 11, color: "#6b7280", cursor: "pointer", paddingBottom: 6 }}>
          <input type="checkbox" checked={r.vatIncluded} onChange={e => up({ vatIncluded: e.target.checked })} />
          VAT포함
        </label>
        <label style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 2, fontSize: 11, color: "#6b7280", cursor: "pointer", paddingBottom: 6 }}>
          <input type="checkbox" checked={r.isDefault} onChange={e => up({ isDefault: e.target.checked })} />
          기본단가
        </label>
        <label style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 2, fontSize: 11, color: "#6b7280", cursor: "pointer", paddingBottom: 6 }}>
          <input type="checkbox" checked={r.isActive} onChange={e => up({ isActive: e.target.checked })} />
          활성
        </label>
      </div>

      {/* 행4: 메모 (+ 액션버튼) */}
      <div style={{ display: "grid", gridTemplateColumns: actionLabel ? "1fr auto" : "1fr", gap: "6px 8px", alignItems: "end", marginBottom: 4 }}>
        <div>
          <div style={label11}>메모</div>
          <input value={r.memo} onChange={e => up({ memo: e.target.value })}
            placeholder="메모 (선택)" style={inputStyle} />
        </div>
        {actionLabel && onAction && (
          <button onClick={onAction} disabled={actionLoading}
            style={{ fontSize: 12, fontWeight: 600, padding: "6px 16px", borderRadius: 7, border: "none", background: actionLoading ? "#9ca3af" : "#2563eb", color: "#fff", cursor: actionLoading ? "not-allowed" : "pointer", whiteSpace: "nowrap" }}>
            {actionLoading ? "추가 중..." : actionLabel}
          </button>
        )}
      </div>

      {/* 고급설정 토글 */}
      <div>
        <button onClick={() => setShowAdvanced(p => !p)}
          style={{ background: "none", border: "none", fontSize: 11, color: "#6b7280", cursor: "pointer", padding: 0, textDecoration: "underline" }}>
          {showAdvanced ? "▲ 고급설정 접기" : "▼ 고급설정 (최소금액·기본시간·추가시간단가)"}
        </button>
        <div style={{ overflow: "hidden", maxHeight: showAdvanced ? "120px" : "0", transition: "max-height 320ms cubic-bezier(0.22, 1, 0.36, 1)" }}>
          {showAdvanced && (
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "6px 8px", marginTop: 6 }}>
              <div>
                <div style={label11}>최소금액 (선택)</div>
                <NumericInput value={r.minPrice} onChange={raw => up({ minPrice: raw })}
                  placeholder="예: 50000" suffix="원" style={inputStyle} />
              </div>
              <div>
                <div style={label11}>기본시간 (선택)</div>
                <input type="number" value={r.baseHours} onChange={e => up({ baseHours: e.target.value })}
                  placeholder="예: 4" style={inputStyle} />
              </div>
              <div>
                <div style={label11}>추가시간 단가 (선택)</div>
                <NumericInput value={r.overtimeRate} onChange={raw => up({ overtimeRate: raw })}
                  placeholder="예: 30000" suffix="원" style={inputStyle} />
              </div>
            </div>
          )}
        </div>
      </div>

      {error && <p style={{ color: "#dc2626", fontSize: 12, marginTop: 4 }}>{error}</p>}
    </div>
  );
}
