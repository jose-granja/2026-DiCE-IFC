"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";

import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  companionTimestampStatus,
  requestCompanionTimestamp,
  type CompanionTimestamp,
} from "@/lib/signing/providers/companion";
import type { SignOptions } from "@/lib/signing/sign";
import {
  requestTimestamp,
  timestampService,
  type TimestampService,
} from "@/lib/signing/timestamp-client";

/**
 * Where a time-stamp can come from (ADR 012, amended 2026-11-22):
 *
 * - **`cartao`** — the Cartão de Cidadão service the Autenticação.gov app uses,
 *   free, asked from this machine through the companion, so its limit (20 in 20
 *   minutes, per caller) is the citizen's own;
 * - **`server`** — the authority this deployment configured (`TSA_URL`),
 *   through `/api/tsa`.
 *
 * The Cartão de Cidadão service comes first when both exist: it is free, and it
 * is what the citizen's other signing tool uses.
 */
export type StampSource =
  | { id: "cartao"; name: string; remaining: number }
  | { id: "server"; name?: string };

export function useTimestamping() {
  const [server, setServer] = useState<TimestampService | null>(null);
  const [cartao, setCartao] = useState<CompanionTimestamp | null>(null);
  // Off until the user ticks it: a time-stamp is a request to a third party,
  // and asking is the user's choice.
  const [enabled, setEnabled] = useState(false);
  const [choice, setChoice] = useState<StampSource["id"] | null>(null);

  const refresh = useCallback(() => {
    void companionTimestampStatus().then(setCartao);
  }, []);

  useEffect(() => {
    let live = true;
    void timestampService().then((found) => live && setServer(found));
    void companionTimestampStatus().then((found) => live && setCartao(found));
    return () => {
      live = false;
    };
  }, []);

  const sources: StampSource[] = [
    ...(cartao?.state === "available"
      ? [{ id: "cartao" as const, name: cartao.name, remaining: cartao.remaining }]
      : []),
    ...(server?.configured ? [{ id: "server" as const, name: server.name }] : []),
  ];
  const source = sources.find((candidate) => candidate.id === choice) ?? sources[0];
  const timestamper: SignOptions["timestamper"] =
    enabled && source
      ? source.id === "cartao"
        ? requestCompanionTimestamp
        : requestTimestamp
      : undefined;

  return {
    sources,
    source,
    enabled,
    setEnabled,
    setChoice,
    timestamper,
    /** A companion is running, from before it could time-stamp. */
    outdated: cartao?.state === "outdated",
    /** Ask the companion again how many stamps are left — after a batch, say. */
    refresh,
  };
}

export type Timestamping = ReturnType<typeof useTimestamping>;

export function TimestampOption({
  stamping,
  idPrefix,
  disabled,
  signatures,
}: {
  stamping: Timestamping;
  idPrefix: string;
  disabled?: boolean;
  /** How many signatures the next run makes, to warn when the budget is short. */
  signatures: number;
}) {
  const t = useTranslations("signModule");
  const { sources, source, enabled } = stamping;

  if (!source) {
    return stamping.outdated ? (
      <p
        className="text-muted-foreground text-xs"
        data-timestamp-option
        data-configured="false"
        data-companion-outdated
      >
        {t("timestamp.companionOutdated")}
      </p>
    ) : null;
  }

  const label =
    sources.length > 1
      ? t("timestamp.addUnnamed")
      : source.id === "cartao"
        ? t("timestamp.addCartao")
        : source.name
          ? t("timestamp.add", { name: source.name })
          : t("timestamp.addUnnamed");

  return (
    <div
      className="space-y-1 rounded-md border p-3"
      data-timestamp-option
      data-configured="true"
      data-timestamp-source={source.id}
    >
      <div className="flex items-start gap-2">
        <Checkbox
          id={`${idPrefix}-timestamp`}
          checked={enabled}
          disabled={disabled}
          className="mt-0.5"
          onCheckedChange={(checked) => stamping.setEnabled(checked === true)}
        />
        <div className="min-w-0 flex-1 space-y-1">
          <Label htmlFor={`${idPrefix}-timestamp`} className="text-sm">
            {label}
          </Label>
          {sources.length > 1 && (
            <Select
              value={source.id}
              disabled={disabled || !enabled}
              onValueChange={(next) => stamping.setChoice(next as StampSource["id"])}
            >
              <SelectTrigger
                id={`${idPrefix}-timestamp-source`}
                aria-label={t("timestamp.source")}
                className="h-8 w-full sm:w-auto"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {sources.map((candidate) => (
                  <SelectItem key={candidate.id} value={candidate.id}>
                    {candidate.id === "cartao"
                      ? t("timestamp.cartaoService")
                      : candidate.name ?? t("timestamp.deploymentService")}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <p className="text-muted-foreground text-xs">{t("timestamp.hint")}</p>
          {source.id === "cartao" && (
            <p className="text-muted-foreground text-xs" data-timestamp-budget={source.remaining}>
              {t("timestamp.cartaoHint", { remaining: source.remaining })}
            </p>
          )}
          {source.id === "cartao" && enabled && signatures > source.remaining && (
            <p className="text-xs text-amber-700 dark:text-amber-400" data-timestamp-budget-short>
              {t("timestamp.cartaoShort", { remaining: source.remaining, count: signatures })}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
