import Link from "next/link";
import { useTranslations } from "next-intl";
import { Laptop } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * The "Processed locally — nothing uploaded" badge required on every module.
 *
 * This is a promise to the user, so it is a plain static element: it must never
 * become conditional on runtime state, because a badge that can be wrong is
 * worse than no badge. If a module ever does send something, the module is the
 * thing that has to change, not this component.
 */
export function LocalOnlyBadge({ className }: { className?: string }) {
  const t = useTranslations("privacy");

  return (
    <Link
      href="/privacy"
      className={cn(
        "border-success/30 bg-success/10 text-success inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors",
        "hover:bg-success/15 focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none",
        className,
      )}
      title={t("badgeTitle")}
    >
      <Laptop className="h-3.5 w-3.5" aria-hidden />
      {t("badge")}
    </Link>
  );
}

export default LocalOnlyBadge;
