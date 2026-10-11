"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { AlertTriangle, BookText, CheckCircle2, CodeXml, ShieldCheck, XCircle } from "lucide-react";
import { toast } from "sonner";

import { serializeIds } from "@/lib/ids/serialize";
import {
  checkDocument,
  validateAgainstSchema,
  type IdsIssue,
  type SchemaValidation,
} from "@/lib/ids/validate";
import type { IdsDocument } from "@/lib/ids/types";
import { useIdsStore } from "@/lib/ids/store";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import SpecificationSummary from "./SpecificationSummary";

/**
 * Live XML, authoring issues, and on-demand schema validation.
 *
 * The XML updates on every keystroke because it is the artefact being authored —
 * seeing it is how someone learns what a facet actually produces. Schema
 * validation is a button: it loads a WebAssembly libxml2 and three schemas, and
 * doing that continuously would be absurd.
 */
/**
 * An authoring issue in the user's language.
 *
 * Built from the issue's code and parameters rather than read from `message`,
 * which is the English sentence tests and logs use. A code this does not know —
 * one added to `checkDocument` without its words — falls back to that sentence
 * rather than showing a key.
 */
function issueText(
  issue: IdsIssue,
  t: ReturnType<typeof useTranslations>,
): { message: string; where: string } {
  const known = (key: string) => t.has(key);

  const params = issue.params ?? {};
  const values: Record<string, string | number> = {
    min: params.min ?? 0,
    max: params.max ?? 0,
    facet: params.facet && known(`issues.facets.${params.facet}`) ? t(`issues.facets.${params.facet}`) : "",
    field: params.field && known(`issues.fields.${params.field}`) ? t(`issues.fields.${params.field}`) : "",
  };

  let message = known(`issues.codes.${issue.code}`) ? t(`issues.codes.${issue.code}`, values) : issue.message;
  if (issue.scope && known(`issues.codes.${issue.code}`)) {
    message = t("issues.scoped", { scope: t(`issues.scopes.${issue.scope}`), problem: message });
  }

  const where =
    issue.whereKind === "document"
      ? t("issues.where.document")
      : issue.whereIndex !== undefined
        ? t("issues.where.specification", { index: issue.whereIndex })
        : issue.where;

  return { message, where };
}

export function PreviewPanel({ document }: { document: IdsDocument }) {
  const t = useTranslations("idsCreate.previewPanel");
  const select = useIdsStore((s) => s.select);
  const selectedId = useIdsStore((s) => s.selectedId);
  const selected = document.specifications.find((s) => s.id === selectedId);
  const [tab, setTab] = useState("issues");
  const [schema, setSchema] = useState<SchemaValidation | null>(null);
  const [validating, setValidating] = useState(false);

  const xml = serializeIds(document, { generator: "DiCE-IFC" });
  const issues = checkDocument(document);
  const errors = issues.filter((i) => i.severity === "error");
  const warnings = issues.filter((i) => i.severity === "warning");

  const onValidate = async () => {
    setValidating(true);
    try {
      const result = await validateAgainstSchema(document);
      setSchema(result);
      if (result.valid) {
        toast.success(t("validAgainstSchema"));
      } else {
        toast.error(t("schemaErrorCount", { count: result.errors.length }));
      }
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : t("schemaValidationFailed"),
      );
    } finally {
      setValidating(false);
    }
  };

  return (
    <Tabs
      value={!selected && tab === "natural" ? "issues" : tab}
      onValueChange={setTab}
      className="flex h-full min-h-0 flex-col"
    >
      {/*
        Icon-only tabs, so each says what it is twice: as its accessible name
        (`aria-label`) and in a tooltip for anyone who can see but not guess.
      */}
      <TabsList className="m-2 grid grid-cols-3">
        <Tooltip>
          <TooltipTrigger asChild>
            <TabsTrigger value="issues" aria-label={t("tabs.issues")}>
              <ShieldCheck />
              {issues.length > 0 && ` (${issues.length})`}
            </TabsTrigger>
          </TooltipTrigger>
          <TooltipContent>{t("tabs.issues")}</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <TabsTrigger value="xml" aria-label={t("tabs.xml")}>
              <CodeXml />
            </TabsTrigger>
          </TooltipTrigger>
          <TooltipContent>{t("tabs.xml")}</TooltipContent>
        </Tooltip>
        <Tooltip>
          {/*
            A disabled button receives no pointer events, so the tooltip would
            never open on it — and this is the tab that needs explaining. The
            wrapper takes the hover instead.
          */}
          <TooltipTrigger asChild>
            <span className="flex min-w-0" data-natural-tab-wrapper>
              <TabsTrigger
                value="natural"
                disabled={!selected}
                aria-label={t("tabs.natural")}
                className="w-full"
              >
                <BookText />
              </TabsTrigger>
            </span>
          </TooltipTrigger>
          <TooltipContent>
            {selected ? t("tabs.natural") : t("tabs.naturalDisabled")}
          </TooltipContent>
        </Tooltip>
      </TabsList>

      <TabsContent value="issues" className="min-h-0 flex-1 overflow-auto">
        <div className="border-b p-2">
          <Button
            size="sm"
            className="w-full"
            disabled={validating}
            onClick={onValidate}
          >
            <ShieldCheck className="h-4 w-4" />
            {validating ? t("validating") : t("validateAgainstSchema")}
          </Button>
          <p className="text-muted-foreground mt-1.5 text-[11px]">
            {t("libxml2Hint")}
          </p>
        </div>

        {schema && (
          <div
            className={cn(
              "flex items-start gap-2 border-b p-3 text-xs",
              schema.valid ? "text-success" : "text-destructive",
            )}
          >
            {schema.valid ? (
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
            ) : (
              <XCircle className="mt-0.5 h-4 w-4 shrink-0" />
            )}
            <div className="min-w-0">
              <p className="font-medium">
                {schema.valid
                  ? t("schemaValidIds")
                  : t("schemaErrorCountNoun", { count: schema.errors.length })}
              </p>
              <ul className="mt-1 space-y-1">
                {schema.errors.map((error, index) => (
                  <li key={index} className="text-muted-foreground">
                    {error.line !== undefined && (
                      <span className="font-mono">{t("lineNumber", { line: error.line })}</span>
                    )}
                    {error.message}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        )}

        {issues.length === 0 ? (
          <p className="text-muted-foreground p-3 text-xs">
            {t("noAuthoringIssues")}
          </p>
        ) : (
          <ul className="divide-y">
            {[...errors, ...warnings].map((issue, index) => {
              const text = issueText(issue, t);
              return (
                <li key={index} className="flex items-start gap-2 px-3 py-2">
                {issue.severity === "error" ? (
                  <XCircle className="text-destructive mt-0.5 h-3.5 w-3.5 shrink-0" />
                ) : (
                  <AlertTriangle className="text-warning mt-0.5 h-3.5 w-3.5 shrink-0" />
                )}
                <div className="min-w-0 flex-1">
                  <p className="text-xs">{text.message}</p>
                  {issue.specificationId ? (
                    <button
                      type="button"
                      onClick={() => select(issue.specificationId!)}
                      className="text-muted-foreground hover:text-foreground text-[11px] underline underline-offset-2"
                    >
                      {text.where}
                    </button>
                  ) : (
                    <p className="text-muted-foreground text-[11px]">{text.where}</p>
                  )}
                </div>
              </li>
            );
            })}
          </ul>
        )}
      </TabsContent>

      <TabsContent value="xml" className="min-h-0 flex-1 overflow-auto">
        <pre className="p-3 font-mono text-[11px] leading-relaxed whitespace-pre">
          {xml}
        </pre>
      </TabsContent>

      <TabsContent value="natural" className="min-h-0 flex-1 overflow-auto">
        {selected && <SpecificationSummary specification={selected} />}
      </TabsContent>
    </Tabs>
  );
}

export default PreviewPanel;
