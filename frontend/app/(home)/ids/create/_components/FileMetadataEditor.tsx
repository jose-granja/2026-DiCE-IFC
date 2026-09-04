"use client";

import { useTranslations } from "next-intl";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useIdsStore } from "@/lib/ids/store";

export default function FileMetadataEditor() {
  const t = useTranslations("idsCreate");
  const info = useIdsStore((s) => s.document.info);
  const updateInfo = useIdsStore((s) => s.updateInfo);

  return (
    <div className="space-y-5 p-4">
      <h2 className="text-lg font-semibold">{t("fileMetadata")}</h2>

      <div className="space-y-1.5">
        <Label htmlFor="ids-title" className="text-xs font-medium">
          {t("documentTitleLabel")}
        </Label>
        <Input
          id="ids-title"
          value={info.title}
          onChange={(event) => updateInfo({ title: event.target.value })}
          className="h-8"
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="ids-description" className="text-xs font-medium">
          {t("descriptionLabel")}
        </Label>
        <Textarea
          id="ids-description"
          value={info.description ?? ""}
          onChange={(event) =>
            updateInfo({ description: event.target.value || undefined })
          }
          className="min-h-14 text-xs"
        />
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="ids-author" className="text-xs font-medium">
            {t("authorLabel")}
          </Label>
          <Input
            id="ids-author"
            type="email"
            value={info.author ?? ""}
            onChange={(event) =>
              updateInfo({ author: event.target.value || undefined })
            }
            placeholder={t("authorPlaceholder")}
            className="h-8 text-xs"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="ids-version" className="text-xs font-medium">
            {t("versionLabel")}
          </Label>
          <Input
            id="ids-version"
            value={info.version ?? ""}
            onChange={(event) =>
              updateInfo({ version: event.target.value || undefined })
            }
            placeholder={t("versionPlaceholder")}
            className="h-8 text-xs"
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="ids-date" className="text-xs font-medium">
            {t("dateLabel")}
          </Label>
          <Input
            id="ids-date"
            type="date"
            value={info.date ?? ""}
            onChange={(event) =>
              updateInfo({ date: event.target.value || undefined })
            }
            className="h-8 text-xs"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="ids-milestone" className="text-xs font-medium">
            {t("milestoneLabel")}
          </Label>
          <Input
            id="ids-milestone"
            value={info.milestone ?? ""}
            onChange={(event) =>
              updateInfo({ milestone: event.target.value || undefined })
            }
            placeholder={t("milestonePlaceholder")}
            className="h-8 text-xs"
          />
        </div>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="ids-purpose" className="text-xs font-medium">
          {t("purposeLabel")}
        </Label>
        <Textarea
          id="ids-purpose"
          value={info.purpose ?? ""}
          onChange={(event) =>
            updateInfo({ purpose: event.target.value || undefined })
          }
          className="min-h-14 text-xs"
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="ids-copyright" className="text-xs font-medium">
          {t("copyrightLabel")}
        </Label>
        <Input
          id="ids-copyright"
          value={info.copyright ?? ""}
          onChange={(event) =>
            updateInfo({ copyright: event.target.value || undefined })
          }
          className="h-8 text-xs"
        />
      </div>
    </div>
  );
}
