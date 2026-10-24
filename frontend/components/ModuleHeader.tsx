import { ReactNode } from "react";
import { cn } from "@/lib/utils";
import LocalOnlyBadge from "./LocalOnlyBadge";

/**
 * Standard header for a module page. Carries the local-processing badge so no
 * module can forget it.
 */
export function ModuleHeader({
  title,
  description,
  actions,
  className,
  actionsClassName,
}: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  className?: string;
  actionsClassName?: string;
}) {
  return (
    <header className={cn("module-header flex min-w-0 shrink-0 flex-wrap items-start justify-between gap-3 border-b px-3 py-3 sm:px-6 sm:py-4", className)}>
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
      {actions && <div className={cn("module-actions flex min-w-0 max-w-full flex-wrap items-center gap-2", actionsClassName)}>{actions}</div>}
    </header>
  );
}

export default ModuleHeader;
