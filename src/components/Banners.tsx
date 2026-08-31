import { useStore, type Doc } from "../store";

export default function Banners({ doc }: { doc: Doc }) {
  if (doc.conflict !== null) {
    return (
      <div className="banner conflict-banner">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <path d="M12 9v4M12 17h.01" />
          <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
        </svg>
        <span className="banner-text">
          Filen er ændret på disken, mens du har ugemte ændringer.
        </span>
        <span className="flex-spacer" />
        <button
          className="banner-btn strong"
          onClick={() => void useStore.getState().resolveConflict(doc.path, true)}
        >
          Behold min version
        </button>
        <button
          className="banner-btn"
          onClick={() => void useStore.getState().resolveConflict(doc.path, false)}
        >
          Brug den nye
        </button>
      </div>
    );
  }
  if (doc.showExternalBanner) {
    return (
      <div className="banner external-banner">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor">
          <path d="M12 2l2.3 7.7L22 12l-7.7 2.3L12 22l-2.3-7.7L2 12l7.7-2.3z" />
        </svg>
        <span className="banner-text">
          Claude har opdateret filen — den nye version vises.
        </span>
        <span className="flex-spacer" />
        {doc.prevContent !== null && (
          <button
            className="banner-btn strong"
            onClick={() => void useStore.getState().undoExternal(doc.path)}
          >
            Fortryd
          </button>
        )}
        <button
          className="banner-btn"
          onClick={() => useStore.getState().dismissExternalBanner(doc.path)}
        >
          OK
        </button>
      </div>
    );
  }
  return null;
}
