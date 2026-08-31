import { useState } from "react";

export default function LinkDialog({
  onSubmit,
  onClose,
}: {
  onSubmit: (url: string) => void;
  onClose: () => void;
}) {
  const [url, setUrl] = useState("");

  const submit = () => {
    const trimmed = url.trim();
    if (trimmed) onSubmit(trimmed.includes("://") ? trimmed : `https://${trimmed}`);
    onClose();
  };

  return (
    <div className="dialog-overlay" onMouseDown={onClose}>
      <div className="dialog" onMouseDown={(e) => e.stopPropagation()}>
        <div className="dialog-title">Indsæt link</div>
        <input
          className="dialog-input"
          autoFocus
          value={url}
          placeholder="https://…"
          onChange={(e) => setUrl(e.target.value)}
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
            Indsæt
          </button>
        </div>
      </div>
    </div>
  );
}
