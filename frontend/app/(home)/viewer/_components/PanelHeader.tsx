"use client";

import type { ReactNode } from "react";
import { useTranslations } from "next-intl";
import { Loader2 } from "lucide-react";

import { TOOL_TAB_ICONS, type ToolTab } from "./tool-tabs";

/**
 * The first row of every tool tab: the tab's icon and the panel's title on the
 * left, the panel's own actions on the right.
 *
 * Icon and title come from the tab, not the panel, so every header is the same
 * shape and says the same thing as the tab that opened it. The row keeps one
 * height with or without buttons, so switching tabs does not make the panel jump.
 */
export function PanelHeader({
  tab,
  busy = false,
  children,
}: {
  tab: ToolTab;
  /** Something in the panel is still loading. */
  busy?: boolean;
  /** Actions, right-aligned. */
  children?: ReactNode;
}) {
  const t = useTranslations("viewer.panelTitles");
  const Icon = TOOL_TAB_ICONS[tab];
  return (
    <div
      // 44 px either way: a row of h-7 buttons fits inside the padding, so a
      // header with actions is not a pixel taller than one without.
      className="flex min-h-11 shrink-0 items-center justify-between gap-2 border-b px-2 py-1.5 text-xs font-medium"
      data-panel-header={tab}
    >
      <h2 className="flex min-w-0 items-center gap-1.5">
        <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden />
        <span className="truncate">{t(tab)}</span>
        {busy && <Loader2 className="h-3 w-3 shrink-0 animate-spin" aria-hidden />}
      </h2>
      {children && <div className="flex shrink-0 flex-row items-center gap-1">{children}</div>}
    </div>
  );
}

export default PanelHeader;

/** A tool tab's icon, for its trigger in the tab bar. */
export function ToolTabIcon({ tab }: { tab: ToolTab }) {
  const Icon = TOOL_TAB_ICONS[tab];
  return <Icon className="h-3.5 w-3.5" aria-hidden />;
}
