"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { X } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { useBcfStore, type BulkPatch } from "@/lib/bcf/store";
import { VocabularyInput } from "./VocabularyInput";

/**
 * Bulk edit, shown only while topics are checked.
 *
 * Deliberately limited to the fields a triage pass actually changes across many
 * topics at once — status, priority, type, assignee, stage. Bulk-editing a
 * description or a due date is almost always a mistake, so it is not offered.
 *
 * Fields left blank are **not applied**. The alternative, treating blank as
 * "clear it", would wipe the assignee off forty topics because someone only
 * wanted to change their status.
 */
export function BulkEditBar() {
  const t = useTranslations("bcf.bulkEditBar");
  const checked = useBcfStore((s) => s.checked);
  const clearChecked = useBcfStore((s) => s.clearChecked);
  const bulkUpdate = useBcfStore((s) => s.bulkUpdate);
  const extensions = useBcfStore((s) => s.file.extensions);

  const [patch, setPatch] = useState<Partial<BulkPatch>>({});

  if (checked.size === 0) return null;

  const count = checked.size;
  const set = (key: keyof BulkPatch, value: string | undefined) =>
    setPatch((current) => ({ ...current, [key]: value }));

  const apply = () => {
    const entries = Object.entries(patch).filter(([, value]) => value);
    if (entries.length === 0) {
      toast.warning(t("setOneField"));
      return;
    }

    bulkUpdate([...checked], Object.fromEntries(entries));
    toast.success(t("updatedCount", { count }));
    setPatch({});
    clearChecked();
  };

  return (
    <div className="bg-accent/60 flex flex-wrap items-end gap-3 border-b p-3">
      <p className="text-xs font-medium">
        {t("topicsSelected", { count })}
      </p>

      <div className="grid flex-1 grid-cols-2 gap-2 lg:grid-cols-5">
        <VocabularyInput
          label={t("status")}
          value={patch.topicStatus}
          options={extensions.topicStatuses}
          onChange={(value) => set("topicStatus", value)}
        />
        <VocabularyInput
          label={t("priority")}
          value={patch.priority}
          options={extensions.priorities}
          onChange={(value) => set("priority", value)}
        />
        <VocabularyInput
          label={t("type")}
          value={patch.topicType}
          options={extensions.topicTypes}
          onChange={(value) => set("topicType", value)}
        />
        <VocabularyInput
          label={t("assignedTo")}
          value={patch.assignedTo}
          options={extensions.users}
          onChange={(value) => set("assignedTo", value)}
        />
        <VocabularyInput
          label={t("stage")}
          value={patch.stage}
          options={extensions.stages}
          onChange={(value) => set("stage", value)}
        />
      </div>

      <div className="flex items-center gap-1.5">
        <Button size="sm" className="h-8" onClick={apply}>
          {t("applyTo", { count })}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-8 w-8 p-0"
          onClick={clearChecked}
          aria-label={t("clearSelection")}
        >
          <X className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}

export default BulkEditBar;
