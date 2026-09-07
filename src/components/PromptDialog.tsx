import { useState } from "react";

export default function PromptDialog({
  title,
  placeholder,
  submitLabel,
  inputType = "text",
  onSubmit,
  onClose,
}: {
  title: string;
  placeholder: string;
  submitLabel: string;
  inputType?: string;
  onSubmit: (value: string) => void;
  onClose: () => void;
}) {
  const [value, setValue] = useState("");

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
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
            if (e.key === "Escape") onClose();
          }}
        />
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
