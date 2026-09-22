import { useState, type ReactNode } from "react";

/**
 * Spec §7 template picker: creation opens a picker first. Left = 2-col grid of
 * template cards (20px icon, 13px/600 name, one-line description), right rail =
 * "Create from scratch" + "Show all templates →". Progressive disclosure: only
 * the first few templates show until expanded.
 */
export interface TemplatePickerItem {
  id: string;
  name: string;
  description: string;
  icon?: ReactNode;
}

export function TemplatePicker({
  title,
  templates,
  onPick,
  onScratch,
  initialVisible = 4,
}: {
  title: string;
  templates: TemplatePickerItem[];
  onPick: (id: string) => void;
  onScratch: () => void;
  initialVisible?: number;
}) {
  const [showAll, setShowAll] = useState(false);
  const visible = showAll ? templates : templates.slice(0, initialVisible);
  const hidden = templates.length - visible.length;

  return (
    <div className="cp-picker-layout">
      <div className="cp-picker-main">
        <div className="cp-picker-title">{title}</div>
        <div className="cp-picker-grid" role="list">
          {visible.map((t) => (
            <button key={t.id} type="button" role="listitem" className="cp-template-card" onClick={() => onPick(t.id)}>
              <span className="cp-template-icon" aria-hidden="true">
                {t.icon}
              </span>
              <span className="cp-template-name">{t.name}</span>
              <span className="cp-template-desc">{t.description}</span>
            </button>
          ))}
        </div>
        {hidden > 0 && !showAll ? (
          <button type="button" className="cp-picker-showall" onClick={() => setShowAll(true)}>
            Show all templates →
          </button>
        ) : null}
      </div>
      <div className="cp-picker-rail">
        <button type="button" className="cp-template-scratch" onClick={onScratch}>
          Create from scratch
        </button>
        <p className="cp-field-hint">Every template pre-fills identity and runtime; every field stays editable.</p>
      </div>
    </div>
  );
}
