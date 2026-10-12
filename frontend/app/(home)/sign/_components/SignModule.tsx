"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { Download, FileSignature, Upload, X } from "lucide-react";
import { toast } from "sonner";

import ModuleHeader from "@/components/ModuleHeader";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { registerSigningProviders } from "@/lib/signing/register";
import {
  defaultSigningProviderId,
  getSigningProvider,
  SigningError,
} from "@/lib/signing/provider";
import {
  signFiles,
  type SignMode,
  type SignProgress,
} from "@/lib/signing/sign";
import type { SignedOutput } from "@/lib/signing/sign";
import {
  requestTimestamp,
  timestampService,
  type TimestampService,
} from "@/lib/signing/timestamp-client";

/**
 * Container signing, used by `/sign/bcf`.
 *
 * A Client Component: the files being signed are user content and never leave
 * the browser. The companion receives signature metadata; the card retains
 * the private key. Optional timestamps send only a signature digest.
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
  const common = useTranslations("ifcSign");
  const embedded = useTranslations("embeddedSign");
  const [files, setFiles] = useState<
    Array<{ name: string; bytes: Uint8Array }>
  >([]);
  const [mode, setMode] = useState<SignMode>("per-file");
  const [progress, setProgress] = useState<SignProgress | null>(null);
  const [outputs, setOutputs] = useState<SignedOutput[]>([]);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  // Drag events fire for every child the pointer crosses; a counter is what
  // keeps the highlight from flickering.
  const dragDepth = useRef(0);

  useEffect(() => {
    registerSigningProviders();
  }, []);

  // Whether this deployment can time-stamp, asked once. Unknown (`null`) shows
  // nothing rather than a note that might be wrong for a moment.
  const [service, setService] = useState<TimestampService | null>(null);
  const [stamp, setStamp] = useState(true);
  useEffect(() => {
    let live = true;
    void timestampService().then((found) => live && setService(found));
    return () => {
      live = false;
    };
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

  const wanted = (name: string) => {
    const lower = name.toLowerCase();
    return accept.some((extension) => lower.endsWith(extension.toLowerCase()));
  };

  const onDropFiles = async (dropped: File[]) => {
    const usable = dropped.filter((file) => wanted(file.name));
    const ignored = dropped.filter((file) => !wanted(file.name));
    if (ignored.length > 0) {
      toast.error(
        t("unsupportedFiles", {
          names: ignored.map((file) => file.name).join(", "),
          extensions: accept.join(", "),
        }),
      );
    }
    if (usable.length > 0) await onAdd(usable);
  };

  const onSign = async () => {
    if (busy || !files.length) return;
    setError(null);
    setOutputs([]);
    setProgress({ phase: "certificate", current: 0, total: files.length });

    try {
      const provider = await getSigningProvider();
      const results = await signFiles(files, provider, {
        mode,
        kind,
        onProgress: setProgress,
        timestamper:
          service?.configured && stamp ? requestTimestamp : undefined,
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
      new Blob([output.bytes as BlobPart], {
        type: "application/octet-stream",
      }),
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
              variant="outline"
              size="sm"
              onClick={() => input.current?.click()}
              disabled={busy}
            >
              <Upload className="h-4 w-4" />
              {t("addFiles")}
            </Button>
            <Button
              size="sm"
              onClick={onSign}
              disabled={busy || files.length === 0}
            >
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
                if (picked.length > 0) await onDropFiles(picked);
              }}
            />
          </>
        }
      />

      <div
        className="mx-auto w-full max-w-5xl space-y-4 p-4 sm:p-6"
        onDragEnter={(event) => {
          if (busy || !event.dataTransfer.types.includes("Files")) return;
          event.preventDefault();
          dragDepth.current += 1;
          setDragging(true);
        }}
        onDragOver={(event) => {
          if (busy || !event.dataTransfer.types.includes("Files")) return;
          // Without this the browser opens the file instead of dropping it here.
          event.preventDefault();
          event.dataTransfer.dropEffect = "copy";
        }}
        onDragLeave={(event) => {
          if (busy || !event.dataTransfer.types.includes("Files")) return;
          dragDepth.current = Math.max(0, dragDepth.current - 1);
          if (dragDepth.current === 0) setDragging(false);
        }}
        onDrop={(event) => {
          if (busy || !event.dataTransfer.types.includes("Files")) return;
          event.preventDefault();
          dragDepth.current = 0;
          setDragging(false);
          void onDropFiles(Array.from(event.dataTransfer.files));
        }}
        data-sign-drop-zone
        data-dragging={dragging}
      >
        <Link
          href="/sign/setup"
          className="text-sm underline underline-offset-4"
        >
          {t("checkSigningSetup")}
        </Link>
        {providerId !== "companion" && (
          <p
            role="status"
            className="rounded-md border border-amber-500 p-3 text-sm"
          >
            {embedded("otherProvider", { provider: providerId })}
          </p>
        )}

          <section  className="space-y-4 rounded-lg border p-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">

                <Label className="text-sm font-medium">
                  {t("signatureMode")}
                </Label>
                <Select
                  value={mode}
                  onValueChange={(value) => {
                    setMode(value as SignMode);
                    setOutputs([]);
                    setError(null);
                  }}
                  disabled={busy}
                >
                  <SelectTrigger
                    className="w-full"
                    aria-label={t("signatureMode")}
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="per-file">
                      {t("oneSignaturePerFile")}
                    </SelectItem>
                    <SelectItem value="combined">
                      {t("oneSignatureAllFiles")}
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            <p className="text-muted-foreground text-sm">
              {mode === "combined"
                ? t.rich("combinedModeHint", {
                    count: files.length || t("theFilesWord"),
                    strong: (chunks) => <strong>{chunks}</strong>,
                  })
                : t.rich("perFileModeHint", {
                    strong: (chunks) => <strong>{chunks}</strong>,
                  })}
            </p>
            {/* {service && !service.configured && (
              // Not a box: it is information rather than a decision, and nothing on
              // this page can change it.
              <p
                className="text-muted-foreground flex items-center gap-1.5 px-1 text-[11px]"
                data-timestamp-option
                data-configured="false"
              >
                <Info className="size-3 shrink-0" aria-hidden />
                {t("timestamp.notConfigured")}
              </p>
            )} */}
            {service?.configured && (
              <div
                className="rounded-lg border p-4"
                data-timestamp-option
                data-configured="true"
              >
                <div className="flex items-start gap-2">
                  <Checkbox
                    id="sign-timestamp"
                    checked={stamp}
                    disabled={busy}
                    onCheckedChange={(checked) => setStamp(checked === true)}
                    className="mt-0.5"
                  />
                  <div className="space-y-0.5">
                    <Label htmlFor="sign-timestamp" className="text-sm font-medium">
                      {service.name
                        ? t("timestamp.add", { name: service.name })
                        : t("timestamp.addUnnamed")}
                    </Label>
                    <p className="text-muted-foreground text-[11px]">
                      {t("timestamp.hint")}
                    </p>
                  </div>
                </div>
              </div>
            )}
          </section>


        <section className="rounded-lg border">
          <div className="flex items-center justify-between gap-2 border-b px-4 py-3">
            <h2 className="text-sm font-medium">
              {common("queue", { count: files.length })}
            </h2>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy || !files.length}
              onClick={() => {
                setFiles([]);
                setOutputs([]);
                setError(null);
              }}
            >
              {common("clear")}
            </Button>
          </div>
          {files.length > 0 && (
            <div className="max-h-72 overflow-auto">
              <table className="w-full text-sm">
                <caption className="sr-only">{t("filesQueued")}</caption>
                <thead className="bg-muted/50">
                  <tr>
                    <th scope="col" className="p-3 text-left font-medium">
                      {t("fileColumn")}
                    </th>
                    <th scope="col" className="p-3 text-right font-medium">
                      {t("sizeColumn")}
                    </th>
                    <th scope="col" className="w-8" />
                  </tr>
                </thead>
                <tbody>
                  {files.map((file, index) => (
                    <tr key={`${file.name}-${index}`} className="border-t">
                      <td className="p-3">{file.name}</td>
                      <td className="p-3 text-right tabular-nums">
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

          {files.length === 0 && (
            <div
              className={cn(
                "space-y-1 p-10 text-center text-sm text-muted-foreground",
                dragging && "bg-primary/5",
              )}
            >
              <p>{t("noFilesSelected")}</p>
              <p>{common("dropHint")}</p>
            </div>
          )}
        </section>

        {progress && (
          <div className="space-y-3 rounded-lg border p-4">
            <p className="text-sm font-medium">{phaseLabel(progress, t)}</p>
            <Progress
              value={
                progress.total > 0
                  ? (progress.current / progress.total) * 100
                  : 0
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
          <div className="space-y-3 rounded-lg border p-4">
            <h2 className="font-medium">{t("signedContainers")}</h2>
            <ul className="space-y-2">
              {outputs.map((output) => (
                <li
                  key={output.name}
                  className="flex items-center justify-between gap-3 text-sm"
                >
                  <span className="min-w-0 flex-1 truncate">
                    {output.name}
                    <Badge
                      variant="secondary"
                      className="ml-1.5 h-4 px-1 text-[10px]"
                    >
                      {t("fileCount", { count: output.covers.length })}
                    </Badge>
                    {output.timestamp?.status === "added" && (
                      <Badge
                        variant="outline"
                        className="ml-1 h-4 px-1 text-[10px]"
                        data-timestamp-status="added"
                        title={output.timestamp.tsa}
                      >
                        {t("timestamp.stamped", {
                          time: new Date(
                            output.timestamp.time,
                          ).toLocaleString(),
                        })}
                      </Badge>
                    )}
                    {output.timestamp?.status === "failed" && (
                      <span
                        className="text-warning ml-1.5 text-[11px]"
                        data-timestamp-status="failed"
                        role="status"
                      >
                        {t("timestamp.failed", {
                          error: output.timestamp.error,
                        })}
                      </span>
                    )}
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
                  <Link
                    href="/sign/verify"
                    className="underline underline-offset-2"
                  >
                    {chunks}
                  </Link>
                ),
              })}
            </p>
          </div>
        )}

        <Link
          href="/sign/verify"
          className="inline-block text-sm underline underline-offset-4"
        >
          {common("verifySignatures")}
        </Link>
      </div>
    </div>
  );
}

function phaseLabel(
  progress: SignProgress,
  t: ReturnType<typeof useTranslations>,
): string {
  switch (progress.phase) {
    case "certificate":
      return t("phaseCertificate");
    case "preparing":
      return t("phasePreparing", {
        fileName: progress.fileName ?? t("theFilesPhrase"),
      });
    case "awaiting-pin":
      return t("phaseAwaitingPin", {
        current: progress.current,
        total: progress.total,
      });
    case "timestamping":
      return t("phaseTimestamping");
    case "assembling":
      return t("phaseAssembling");
    case "done":
      return t("phaseDone");
  }
}

function messageFor(
  error: SigningError,
  t: ReturnType<typeof useTranslations>,
): string {
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
