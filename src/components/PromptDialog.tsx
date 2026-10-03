import { useState } from "react";

export default function PromptDialog({
  title,
  placeholder,
  submitLabel,
  inputType = "text",
  initialValue,
  error,
  onSubmit,
  onClose,
}: {
  title: string;
  placeholder: string;
  submitLabel: string;
  inputType?: string;
  initialValue?: string; // fx det nuværende navn ved omdøbning
  error?: string; // vises under feltet (fx når navnet er optaget)
  onSubmit: (value: string) => void;
  onClose: () => void;
}) {
  const [value, setValue] = useState(initialValue ?? "");

  const submit = () => {
    const trimmed = value.trim();
    if (trimmed) onSubmit(trimmed);
    onClose();
  };

  return (
    <div className="dialog-overlay" onMouseDown={onClose}>
      <div className="dialog" onMouseDown={(e) => e.stopPropagation()}>
        <div className="dialog-title">{title}</div>
        <input
          className="dialog-input"
          autoFocus
          type={inputType}
          value={value}
          placeholder={placeholder}
          onFocus={initialValue ? (e) => e.currentTarget.select() : undefined}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
            if (e.key === "Escape") onClose();
          }}
        />
        {error && <div className="dialog-error">{error}</div>}
        <div className="dialog-actions">
          <button className="secondary-btn" onClick={onClose}>
            Annuller
          </button>
          <button className="primary-btn" onClick={submit}>
            {submitLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
