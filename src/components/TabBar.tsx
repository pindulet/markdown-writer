import { useStore } from "../store";

function fileName(path: string) {
  const base = path.split("/").pop() ?? path;
  return base.replace(/\.md$/i, "");
}

export default function TabBar({ sidebarHidden }: { sidebarHidden: boolean }) {
  const tabs = useStore((s) => s.tabs);
  const activePath = useStore((s) => s.activePath);
  const docs = useStore((s) => s.docs);
  const view = useStore((s) => s.view);

  return (
    <div
      className={"tab-bar" + (sidebarHidden ? " sidebar-hidden" : "")}
      data-tauri-drag-region
    >
      <div className="tabs">
        {tabs.map((path) => {
          const doc = docs[path];
          const active = path === activePath;
          return (
            <div
              key={path}
              className={"tab" + (active ? " active" : "")}
              onClick={() => useStore.getState().activate(path)}
              onAuxClick={(e) => {
                if (e.button === 1) useStore.getState().closeTab(path);
              }}
              title={path}
            >
              <span className="tab-name">{fileName(path)}</span>
              {doc?.claudeUpdated && !active && <span className="claude-dot" />}
              <button
                className="tab-close"
                onClick={(e) => {
                  e.stopPropagation();
                  useStore.getState().closeTab(path);
                }}
                title="Luk fane"
              >
                <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                  <path d="M18 6 6 18M6 6l12 12" />
                </svg>
              </button>
            </div>
          );
        })}
      </div>
      <div className="flex-spacer" data-tauri-drag-region />
      <div className="view-switcher" title="Skift visning (⌘E)">
        <button
          className={"segment" + (view === "markdown" ? " active" : "")}
          onClick={() => useStore.getState().setView("markdown")}
        >
          Markdown
        </button>
        <button
          className={"segment" + (view === "layout" ? " active" : "")}
          onClick={() => useStore.getState().setView("layout")}
        >
          Layout
        </button>
      </div>
    </div>
  );
}
