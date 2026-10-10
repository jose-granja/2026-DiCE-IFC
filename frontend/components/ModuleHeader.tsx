import { ReactNode } from "react";
import LocalOnlyBadge from "./LocalOnlyBadge";

/**
 * Standard header for a module page. Carries the local-processing badge so no
 * module can forget it.
 */
export function ModuleHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="flex flex-wrap items-start justify-between gap-4 border-b px-6 py-4">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="truncate text-lg font-semibold tracking-tight">{title}</h1>
          <LocalOnlyBadge />
        </div>
        {description && (
          <p className="text-muted-foreground mt-1 max-w-3xl text-sm">
            {description}
          </p>
        )}
      </div>
      {actions && <div className="flex max-w-full flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}

export default ModuleHeader;
