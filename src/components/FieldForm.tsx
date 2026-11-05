import { CARD_FIELDS, type CardFields, type FieldFlags, type FieldKey } from "../../shared/fields";

const MULTILINE: FieldKey[] = ["address", "other"];

interface Props {
  fields: CardFields;
  onChange: (key: FieldKey, value: string) => void;
  /** 要確認の理由（OCR とルールチェックを合わせたもの） */
  flags: FieldFlags;
  /** 確認済みにした項目。undefined なら確認チェックを出さない（編集画面など） */
  confirmed?: Set<FieldKey>;
  onToggleConfirm?: (key: FieldKey, checked: boolean) => void;
  /** 会社名の入力候補（登録済みの会社名） */
  companySuggestions?: string[];
}

export function FieldForm({ fields, onChange, flags, confirmed, onToggleConfirm, companySuggestions }: Props) {
  return (
    <div className="field-form">
      {companySuggestions && companySuggestions.length > 0 && (
        <datalist id="company-suggestions">
          {companySuggestions.map((c) => (
            <option key={c} value={c} />
          ))}
        </datalist>
      )}
      {CARD_FIELDS.map(({ key, label }) => {
        const reason = flags[key];
        const needsConfirm = Boolean(reason && confirmed);
        const done = needsConfirm && confirmed!.has(key);
        const id = `field-${key}`;
        return (
          <div key={key} className={`field ${reason ? (done ? "flag-done" : "flag") : ""}`}>
            <label htmlFor={id}>{label}</label>
            {MULTILINE.includes(key) ? (
              <textarea id={id} rows={2} value={fields[key]} onChange={(e) => onChange(key, e.target.value)} />
            ) : (
              <input
                id={id}
                type={key === "email" ? "email" : key === "url" ? "url" : "text"}
                inputMode={["phone", "mobile", "fax", "postal_code"].includes(key) ? "tel" : undefined}
                list={key === "company_name" && companySuggestions?.length ? "company-suggestions" : undefined}
                autoComplete={key === "company_name" ? "off" : undefined}
                aria-invalid={reason && !done ? true : undefined}
                aria-describedby={reason ? `${id}-reason` : undefined}
                value={fields[key]}
                onChange={(e) => onChange(key, e.target.value)}
              />
            )}
            {reason && (
              <div className="flag-reason" id={`${id}-reason`}>
                <span>⚠ {reason}</span>
                {needsConfirm && (
                  <label className="confirm-check">
                    <input type="checkbox" checked={done} onChange={(e) => onToggleConfirm?.(key, e.target.checked)} />
                    確認した
                  </label>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
