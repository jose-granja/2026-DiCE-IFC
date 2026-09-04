"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { Download, FileSignature, ShieldAlert, Upload, X } from "lucide-react";
import { toast } from "sonner";

import ModuleHeader from "@/components/ModuleHeader";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { registerSigningProviders } from "@/lib/signing/register";
import {
  defaultSigningProviderId,
  getSigningProvider,
  SigningError,
} from "@/lib/signing/provider";
import { signFiles, type SignMode, type SignProgress } from "@/lib/signing/sign";
import type { SignedOutput } from "@/lib/signing/sign";

/**
 * The signing module, shared by `/sign/ifc` and `/sign/bcf`.
 *
 * A Client Component: the files being signed are user content and never leave
 * the browser. Not even the digest crosses the wire — with card signing the
 * private key is on the card and the container is assembled here, which is what
 * makes the privacy line absolute (AGENTS.md §1).
 */
export function SignModule({
  kind,
  title,
  description,
  accept,
}: {
  kind: "ifc" | "bcf";
  title: string;
  description: string;
  accept: string[];
}) {
  const t = useTranslations("signModule");
  const [files, setFiles] = useState<Array<{ name: string; bytes: Uint8Array }>>([]);
  const [mode, setMode] = useState<SignMode>("combined");
  const [progress, setProgress] = useState<SignProgress | null>(null);
  const [outputs, setOutputs] = useState<SignedOutput[]>([]);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    registerSigningProviders();
  }, []);

  const providerId = useMemo(() => defaultSigningProviderId(), []);
  const busy = progress !== null;

  const onAdd = async (picked: File[]) => {
    const loaded = await Promise.all(
      picked.map(async (file) => ({
        name: file.name,
        bytes: new Uint8Array(await file.arrayBuffer()),
      })),
    );
    setFiles((current) => [...current, ...loaded]);
    setOutputs([]);
  };

  const onSign = async () => {
    setError(null);
    setOutputs([]);

    try {
      const provider = await getSigningProvider();
      const results = await signFiles(files, provider, {
        mode,
        kind,
        onProgress: setProgress,
      });

      setOutputs(results);
      toast.success(
        results.length === 1
          ? t("signedReady")
          : t("signedCount", { count: results.length }),
      );
    } catch (caught) {
      const message =
        caught instanceof SigningError
          ? messageFor(caught, t)
          : caught instanceof Error
            ? caught.message
            : t("signingFailed");
      setError(message);
      toast.error(message);
    } finally {
      setProgress(null);
    }
  };

  const download = (output: SignedOutput) => {
    const url = URL.createObjectURL(
      new Blob([output.bytes as BlobPart], { type: "application/octet-stream" }),
    );
    const link = window.document.createElement("a");
    link.href = url;
    link.download = output.name;
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="flex h-[calc(100vh-3.25rem)] flex-col overflow-auto">
      <ModuleHeader
        title={title}
        description={description}
        actions={
          <>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => input.current?.click()}
              disabled={busy}
            >
              <Upload className="h-4 w-4" />
              {t("addFiles")}
            </Button>
            <Button size="sm" onClick={onSign} disabled={busy || files.length === 0}>
              <FileSignature className="h-4 w-4" />
              {busy ? t("signing") : t("sign")}
            </Button>
            <input
              ref={input}
              type="file"
              multiple
              accept={accept.join(",")}
              className="hidden"
              onChange={async (event) => {
                const picked = Array.from(event.target.files ?? []);
                event.target.value = "";
                if (picked.length > 0) await onAdd(picked);
              }}
            />
          </>
        }
      />

      <div className="space-y-4 p-4">
        {providerId !== "webeid" && (
          <p
            className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-800 dark:text-amber-300"
            role="status"
          >
            <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
            <span>
              {t.rich("signingWithProvider", {
                provider: providerId,
                strong: (chunks) => <strong>{chunks}</strong>,
              })}
            </span>
          </p>
        )}

        <div className="rounded-md border p-3">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs font-medium">{t("signatureMode")}</Label>
              <Select
                value={mode}
                onValueChange={(value) => setMode(value as SignMode)}
                disabled={busy}
              >
                <SelectTrigger className="h-8 w-72 text-xs" aria-label={t("signatureMode")}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="combined">
                    {t("oneSignatureAllFiles")}
                  </SelectItem>
                  <SelectItem value="per-file">{t("oneSignaturePerFile")}</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <p className="text-muted-foreground max-w-md text-[11px]">
              {mode === "combined" ? (
                t.rich("combinedModeHint", {
                  count: files.length || t("theFilesWord"),
                  strong: (chunks) => <strong>{chunks}</strong>,
                })
              ) : (
                t.rich("perFileModeHint", {
                  strong: (chunks) => <strong>{chunks}</strong>,
                })
              )}
            </p>
          </div>
        </div>

        {files.length > 0 && (
          <div className="overflow-hidden rounded-md border">
            <table className="w-full text-xs">
              <caption className="sr-only">{t("filesQueued")}</caption>
              <thead className="bg-muted/50">
                <tr>
                  <th scope="col" className="px-2 py-1.5 text-left font-medium">
                    {t("fileColumn")}
                  </th>
                  <th scope="col" className="px-2 py-1.5 text-right font-medium">
                    {t("sizeColumn")}
                  </th>
                  <th scope="col" className="w-8" />
                </tr>
              </thead>
              <tbody>
                {files.map((file, index) => (
                  <tr key={`${file.name}-${index}`} className="border-t">
                    <td className="px-2 py-1.5">{file.name}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">
                      {formatBytes(file.bytes.length)}
                    </td>
                    <td className="px-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 w-6 p-0"
                        disabled={busy}
                        onClick={() =>
                          setFiles((current) =>
                            current.filter((_, at) => at !== index),
                          )
                        }
                        aria-label={t("removeFile", { name: file.name })}
                      >
                        <X className="h-3.5 w-3.5" />
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {progress && (
          <div className="space-y-2 rounded-md border p-3">
            <p className="text-xs font-medium">{phaseLabel(progress, t)}</p>
            <Progress
              value={
                progress.total > 0 ? (progress.current / progress.total) * 100 : 0
              }
            />
            {progress.phase === "awaiting-pin" && (
              <p className="text-muted-foreground text-[11px]">
                {t("pinInOwnWindow")}
              </p>
            )}
          </div>
        )}

        {error && (
          <div
            className="border-destructive/40 bg-destructive/10 space-y-2 rounded-md border p-3 text-xs"
            role="alert"
          >
            <p className="text-destructive font-medium">{error}</p>
            <p>
              <Link href="/sign/setup" className="underline underline-offset-2">
                {t("checkSigningSetup")}
              </Link>
            </p>
          </div>
        )}

        {outputs.length > 0 && (
          <div className="space-y-2 rounded-md border p-3">
            <h2 className="text-xs font-semibold">{t("signedContainers")}</h2>
            <ul className="space-y-1.5">
              {outputs.map((output) => (
                <li
                  key={output.name}
                  className="flex items-center justify-between gap-2 text-xs"
                >
                  <span className="min-w-0 flex-1 truncate">
                    {output.name}
                    <Badge variant="secondary" className="ml-1.5 h-4 px-1 text-[10px]">
                      {t("fileCount", { count: output.covers.length })}
                    </Badge>
                  </span>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 px-2"
                    onClick={() => download(output)}
                  >
                    <Download className="h-3.5 w-3.5" />
                    {t("download")}
                  </Button>
                </li>
              ))}
            </ul>
            <p className="text-muted-foreground text-[11px]">
              {t.rich("stillValidContainer", {
                kind: kind === "ifc" ? "ifcZIP" : "BCF zip",
                code: (chunks) => <code>{chunks}</code>,
                verifyLink: (chunks) => (
                  <Link href="/sign/verify" className="underline underline-offset-2">
                    {chunks}
                  </Link>
                ),
              })}
            </p>
          </div>
        )}

        {files.length === 0 && (
          <div className="text-muted-foreground rounded-md border border-dashed p-10 text-center text-sm">
            <p className="font-medium">{t("noFilesSelected")}</p>
            <p className="mt-1 text-xs">
              {t("addFilesHint", { kind: kind === "ifc" ? t("ifcModels") : t("bcfIssueSets") })}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

function phaseLabel(progress: SignProgress, t: ReturnType<typeof useTranslations>): string {
  switch (progress.phase) {
    case "certificate":
      return t("phaseCertificate");
    case "preparing":
      return t("phasePreparing", { fileName: progress.fileName ?? t("theFilesPhrase") });
    case "awaiting-pin":
      return t("phaseAwaitingPin", { current: progress.current, total: progress.total });
    case "assembling":
      return t("phaseAssembling");
    case "done":
      return t("phaseDone");
  }
}

function messageFor(error: SigningError, t: ReturnType<typeof useTranslations>): string {
  switch (error.code) {
    case "not-ready":
      return t("errorNotReady");
    case "cancelled":
      return t("errorCancelled");
    case "pin-incorrect":
      return t("errorPinIncorrect");
    case "pin-blocked":
      return t("errorPinBlocked");
    case "card-changed":
      return t("errorCardChanged");
    case "unsupported-algorithm":
      return error.message;
    default:
      return error.message;
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} kB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export default SignModule;
