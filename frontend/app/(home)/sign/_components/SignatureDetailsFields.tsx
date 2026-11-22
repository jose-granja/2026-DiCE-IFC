"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";

import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { DETAIL_MAX_LENGTH } from "@/lib/signing/details";
import { scap, type AttributeSourceAvailability } from "@/lib/signing/professional-attributes";

export type DetailsDraft = { reason: string; location: string };

/**
 * Motivo, Localização and professional attributes: what the signer states,
 * signed with the signature (`lib/signing/details.ts`). Both texts are
 * optional; an empty one adds nothing.
 *
 * Professional attributes are shown, and switched off, until a source exists
 * (ADR 019): saying why beats a control that silently is not there.
 */
export function SignatureDetailsFields({
  idPrefix,
  value,
  onChange,
  disabled,
}: {
  idPrefix: string;
  value: DetailsDraft;
  onChange: (next: DetailsDraft) => void;
  disabled?: boolean;
}) {
  const t = useTranslations("signatureDetails");
  const [attributes, setAttributes] = useState<AttributeSourceAvailability | null>(null);
  useEffect(() => {
    let live = true;
    void scap.availability().then((found) => live && setAttributes(found));
    return () => {
      live = false;
    };
  }, []);

  return (
    <fieldset className="space-y-3 rounded-md border p-3" data-signature-details disabled={disabled}>
      <legend className="px-1 text-sm font-medium">{t("title")}</legend>
      <p className="text-muted-foreground text-xs">{t("hint")}</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor={`${idPrefix}-reason`}>{t("reason")}</Label>
          <Input
            id={`${idPrefix}-reason`}
            value={value.reason}
            maxLength={DETAIL_MAX_LENGTH}
            placeholder={t("reasonPlaceholder")}
            autoComplete="off"
            onChange={(event) => onChange({ ...value, reason: event.target.value })}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`${idPrefix}-location`}>{t("location")}</Label>
          <Input
            id={`${idPrefix}-location`}
            value={value.location}
            maxLength={DETAIL_MAX_LENGTH}
            placeholder={t("locationPlaceholder")}
            autoComplete="address-level2"
            onChange={(event) => onChange({ ...value, location: event.target.value })}
          />
        </div>
      </div>
      {attributes && (
        <div className="flex items-start gap-2" data-professional-attributes={attributes.available ? "available" : "unavailable"}>
          <Checkbox id={`${idPrefix}-professional`} checked={false} disabled className="mt-0.5" />
          <div className="space-y-0.5">
            <Label htmlFor={`${idPrefix}-professional`} className="text-sm">
              {t("professional")}
            </Label>
            {!attributes.available && (
              <p className="text-muted-foreground text-xs">{t("professionalUnavailable")}</p>
            )}
          </div>
        </div>
      )}
    </fieldset>
  );
}
