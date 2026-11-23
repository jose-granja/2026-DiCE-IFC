"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";

import { InfoTip } from "@/components/InfoTip";
import { Switch } from "@/components/ui/switch";
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
      <legend className="flex items-center gap-1 px-1 text-sm font-medium">
        {t("title")}
        <InfoTip>{t("hint")}</InfoTip>
      </legend>
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
        <div className="flex items-center gap-2" data-professional-attributes={attributes.available ? "available" : "unavailable"}>
          <Switch id={`${idPrefix}-professional`} checked={false} disabled />
          <Label htmlFor={`${idPrefix}-professional`} className="text-sm font-normal">
            {t("professional")}
          </Label>
          {!attributes.available && (
            <InfoTip>{t("professionalUnavailable")}</InfoTip>
          )}
        </div>
      )}
    </fieldset>
  );
}
