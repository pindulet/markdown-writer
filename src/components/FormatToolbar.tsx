import { useEffect, useState, type ReactNode } from "react";
import { useActiveEditor } from "../editorCommands";
import "../mobile-editor.css";

// Linjen må aldrig tage fokus fra editoren (så lukker iOS tastaturet og
// glemmer markeringen); handlingen sker på klik. mousedown forhindres også,
// fordi iOS 26 ikke lader pointerdown stoppe den.
const keepFocus = (e: { preventDefault: () => void }) => e.preventDefault();

// "Utilgængelig" uden disabled-attributten: et tryk på en deaktiveret knap
// ville ellers kunne flytte fokus væk fra editoren
function ToolButton({
  label,
  onRun,
  active,
  disabled,
  text,
  className,
  children,
}: {
  label: string;
  onRun: () => void;
  active?: boolean; // vises som slået til (aria-pressed)
  disabled?: boolean;
  text?: boolean; // knap med tekst i stedet for ikon
  className?: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className={
        "ft-btn" +
        (active ? " active" : "") +
        (text ? " ft-text" : "") +
        (className ? ` ${className}` : "")
      }
      aria-label={text ? undefined : label}
      aria-pressed={active}
      aria-disabled={disabled || undefined}
      tabIndex={-1}
      onPointerDown={keepFocus}
      onMouseDown={keepFocus}
      onClick={() => {
        if (!disabled) onRun();
      }}
    >
      {children}
    </button>
  );
}

function Icon({ children }: { children: ReactNode }) {
  return (
    <svg
      width="22"
      height="22"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

// Formateringslinjen over tastaturet på mobil. Den betjener den editor, der
// er registreret i editorCommands (layout eller markdown). Står markøren i
// en tabel, giver "Tabel" række- og kolonnehandlingerne, og lister er slået
// fra (en GFM-celle rummer kun én linje).
export default function FormatToolbar() {
  const { commands, state } = useActiveEditor();
  const [tableMode, setTableMode] = useState(false);

  useEffect(() => {
    if (!state.inTable) setTableMode(false);
  }, [state.inTable]);

  if (!commands) return null;
  const table = state.inTable ? commands.table : undefined;

  return (
    <div
      className="format-toolbar"
      role="toolbar"
      aria-label="Formatering"
      onPointerDown={keepFocus}
      onMouseDown={keepFocus}
    >
      <div className="ft-scroll">
        {table && tableMode ? (
          <>
            <ToolButton label="Tilbage til formatering" onRun={() => setTableMode(false)}>
              <Icon>
                <path d="m15 5-7 7 7 7" />
              </Icon>
            </ToolButton>
            <ToolButton label="Ny række" text onRun={table.addRowAfter}>
              Ny række
            </ToolButton>
            <ToolButton label="Ny kolonne" text onRun={table.addColumnAfter}>
              Ny kolonne
            </ToolButton>
            <ToolButton label="Slet række" text onRun={table.deleteRow}>
              Slet række
            </ToolButton>
            <ToolButton label="Slet kolonne" text onRun={table.deleteColumn}>
              Slet kolonne
            </ToolButton>
            <ToolButton label="Slet tabel" text className="danger" onRun={table.deleteTable}>
              Slet tabel
            </ToolButton>
          </>
        ) : (
          <>
            {table && (
              <ToolButton label="Tabel" className="ft-table" onRun={() => setTableMode(true)}>
                <Icon>
                  <rect x="3" y="4.5" width="18" height="15" rx="2" />
                  <path d="M3 10h18M3 14.75h18M10 4.5v15" />
                </Icon>
              </ToolButton>
            )}
            <ToolButton label="Fed" active={state.bold} onRun={commands.bold}>
              <span className="ft-glyph ft-bold">B</span>
            </ToolButton>
            <ToolButton label="Kursiv" active={state.italic} onRun={commands.italic}>
              <span className="ft-glyph ft-italic">I</span>
            </ToolButton>
            <ToolButton
              label={state.heading ? `Overskrift ${state.heading}` : "Overskrift"}
              active={state.heading > 0}
              onRun={commands.heading}
            >
              <span className="ft-glyph ft-heading">
                H{state.heading > 0 && <sub>{state.heading}</sub>}
              </span>
            </ToolButton>
            <ToolButton
              label="Punktliste"
              active={state.bulletList}
              disabled={state.inTable}
              onRun={commands.bulletList}
            >
              <Icon>
                <path d="M10 6.5h10M10 12h10M10 17.5h10" />
                <circle cx="5" cy="6.5" r="1.1" fill="currentColor" />
                <circle cx="5" cy="12" r="1.1" fill="currentColor" />
                <circle cx="5" cy="17.5" r="1.1" fill="currentColor" />
              </Icon>
            </ToolButton>
            <ToolButton
              label="Tjekliste"
              active={state.taskList}
              disabled={state.inTable}
              onRun={commands.taskList}
            >
              <Icon>
                <rect x="3.5" y="4" width="6" height="6" rx="1.5" />
                <path d="m5 7 1.1 1.1L8 5.9" />
                <rect x="3.5" y="14" width="6" height="6" rx="1.5" />
                <path d="M13 7h8M13 17h8" />
              </Icon>
            </ToolButton>
            <ToolButton label="Ryk ud" onRun={commands.outdent}>
              <Icon>
                <path d="M21 6H11M21 12H11M21 18H11" />
                <path d="m7 9-3 3 3 3" />
              </Icon>
            </ToolButton>
            <ToolButton label="Ryk ind" disabled={state.inTable} onRun={commands.indent}>
              <Icon>
                <path d="M21 6H11M21 12H11M21 18H11" />
                <path d="m3 9 3 3-3 3" />
              </Icon>
            </ToolButton>
            <ToolButton label="Link" onRun={commands.link}>
              <Icon>
                <path d="M10 13.5a4.5 4.5 0 0 0 6.4.4l3-3a4.5 4.5 0 0 0-6.4-6.4l-1.6 1.6" />
                <path d="M14 10.5a4.5 4.5 0 0 0-6.4-.4l-3 3a4.5 4.5 0 0 0 6.4 6.4l1.6-1.6" />
              </Icon>
            </ToolButton>
            <ToolButton label="Fortryd" disabled={!state.canUndo} onRun={commands.undo}>
              <Icon>
                <path d="M9 14 4 9l5-5" />
                <path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" />
              </Icon>
            </ToolButton>
            <ToolButton label="Gentag" disabled={!state.canRedo} onRun={commands.redo}>
              <Icon>
                <path d="m15 14 5-5-5-5" />
                <path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13" />
              </Icon>
            </ToolButton>
          </>
        )}
      </div>
      {state.focused && (
        <ToolButton label="Skjul tastatur" className="ft-end" onRun={commands.blur}>
          <Icon>
            <rect x="2.5" y="3.5" width="19" height="12" rx="2" />
            <path d="M6.5 7.5h.01M10 7.5h.01M14 7.5h.01M17.5 7.5h.01M8 11.5h8" />
            <path d="m9 18.5 3 2.5 3-2.5" />
          </Icon>
        </ToolButton>
      )}
    </div>
  );
}
