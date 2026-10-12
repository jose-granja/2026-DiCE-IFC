"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { Download, FileSignature, Upload, X } from "lucide-react";
import { zip } from "fflate";
import ModuleHeader from "@/components/ModuleHeader";
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
import { IFC_FILE_EXTENSIONS } from "@/config";
import { cn } from "@/lib/utils";
import { registerSigningProviders } from "@/lib/signing/register";
import {
  defaultSigningProviderId,
  getSigningProvider,
  SigningError,
} from "@/lib/signing/provider";
import {
  BulkSigningError,
  signIfcBatch,
  type BatchOutput,
} from "@/lib/signing/bulk";
import { EmbeddedIfcError } from "@/lib/signing/embedded";
import type { SignMode } from "@/lib/signing/sign";
import {
  requestTimestamp,
  timestampService,
  type TimestampService,
} from "@/lib/signing/timestamp-client";

type Format = "ifczip" | "embedded";
type ProgressState = {
  current: number;
  total: number;
  fileName?: string;
  phase: string;
};

function downloadBytes(name: string, bytes: Uint8Array) {
  const url = URL.createObjectURL(
    new Blob([new Uint8Array(bytes)], { type: "application/octet-stream" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export default function IfcSignModule() {
  const t = useTranslations("signModule");
  const m = useTranslations("ifcSign");
  const e = useTranslations("embeddedSign");
  const pages = useTranslations("signPages.ifc");
  const input = useRef<HTMLInputElement>(null);
  const locked = useRef(false);
  const dragDepth = useRef(0);
  const [files, setFiles] = useState<File[]>([]);
  const [format, setFormat] = useState<Format>("embedded");
  const [mode, setMode] = useState<SignMode>("per-file");
  const [operation, setOperation] = useState<"sign" | "download" | null>(null);
  const [progress, setProgress] = useState<ProgressState | null>(null);
  const [outputs, setOutputs] = useState<BatchOutput[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const [dragging, setDragging] = useState(false);
  // Whether this deployment can time-stamp. Unknown (`null`) shows nothing.
  const [service, setService] = useState<TimestampService | null>(null);
  const [stamp, setStamp] = useState(true);
  useEffect(() => {
    let live = true;
    void timestampService().then((found) => live && setService(found));
    return () => {
      live = false;
    };
  }, []);
  const busy = operation !== null;
  const embedded = format === "embedded";
  const accept: readonly string[] = embedded ? [".ifc"] : IFC_FILE_EXTENSIONS;
  const incompatible = files.some(
    (file) =>
      !accept.some((extension) => file.name.toLowerCase().endsWith(extension)),
  );

  const resetResults = () => {
    setOutputs([]);
    setErrors([]);
  };
  const errorMessage = (error: unknown): string => {
    if (error instanceof BulkSigningError) return m(`errors.${error.code}`);
    if (error instanceof EmbeddedIfcError) return e(`errors.${error.code}`);
    if (error instanceof SigningError) {
      const keys = {
        "not-ready": "errorNotReady",
        cancelled: "errorCancelled",
        "pin-incorrect": "errorPinIncorrect",
        "pin-blocked": "errorPinBlocked",
        "card-changed": "errorCardChanged",
      } as const;
      if (error.code in keys) return t(keys[error.code as keyof typeof keys]);
      if (error.code === "unsupported-algorithm")
        return m("unsupportedAlgorithm");
    }
    return e("errors.unknown");
  };
  const addFiles = (picked: File[]) => {
    if (locked.current) return;
    resetResults();
    const accepted: File[] = [];
    const rejected: string[] = [];
    const names = new Set(files.map((file) => file.name.toLowerCase()));
    for (const file of picked) {
      if (
        !accept.some((extension) => file.name.toLowerCase().endsWith(extension))
      ) {
        rejected.push(
          t("unsupportedFiles", {
            names: file.name,
            extensions: accept.join(", "),
          }),
        );
      } else if (names.has(file.name.toLowerCase())) {
        rejected.push(`${file.name}: ${m("errors.duplicate-name")}`);
      } else {
        names.add(file.name.toLowerCase());
        accepted.push(file);
      }
    }
    setFiles((current) => [...current, ...accepted]);
    setErrors(rejected);
  };
  const sign = async () => {
    if (locked.current || !files.length || incompatible) return;
    locked.current = true;
    setOperation("sign");
    resetResults();
    try {
      registerSigningProviders();
      const result = await signIfcBatch(files, await getSigningProvider(), {
        format,
        mode: embedded ? "per-file" : mode,
        timestamper:
          !embedded && service?.configured && stamp
            ? requestTimestamp
            : undefined,
        onProgress: setProgress,
        onOutput: (output) => setOutputs((current) => [...current, output]),
      });
      setOutputs(result.outputs);
      setErrors(
        result.failures.map(
          (failure) => `${failure.fileName}: ${errorMessage(failure.error)}`,
        ),
      );
    } catch (error) {
      setErrors([errorMessage(error)]);
    } finally {
      setOperation(null);
      setProgress(null);
      locked.current = false;
    }
  };
  const downloadAll = async () => {
    if (locked.current || !outputs.length) return;
    locked.current = true;
    setOperation("download");
    try {
      // fflate compresses large entries in workers. Preserve the originals so
      // individual downloads remain available after downloading the archive.
      const bytes = await new Promise<Uint8Array>((resolve, reject) => {
        zip(
          Object.fromEntries(
            outputs.map((output) => [output.name, output.bytes]),
          ),
          (error, archive) => (error ? reject(error) : resolve(archive)),
        );
      });
      downloadBytes("signed-ifc-files.zip", bytes);
    } catch {
      setErrors((current) => [...current, m("downloadFailed")]);
    } finally {
      setOperation(null);
      locked.current = false;
    }
  };
  const progressLabel = () => {
    if (!progress) return "";
    switch (progress.phase) {
      case "reading":
      case "preparing":
        return t("phasePreparing", {
          fileName: progress.fileName ?? t("theFilesPhrase"),
        });
      case "certificate":
        return t("phaseCertificate");
      case "signing":
      case "awaiting-pin":
        return t("phaseAwaitingPin", {
          current: progress.current,
          total: progress.total,
        });
      case "verifying":
        return e("phases.verifying");
      case "timestamping":
        return t("phaseTimestamping");
      case "assembling":
        return t("phaseAssembling");
      case "done":
        return t("phaseDone");
      default:
        return t("signing");
    }
  };

  return (
    <div className="flex h-[calc(100vh-3.25rem)] flex-col overflow-auto">
      <ModuleHeader
        title={pages("title")}
        description={m("description")}
        actions={
          <>
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => input.current?.click()}
            >
              <Upload className="size-4" />
              {t("addFiles")}
            </Button>
            <Button
              size="sm"
              disabled={busy || !files.length || incompatible}
              onClick={() => void sign()}
            >
              <FileSignature className="size-4" />
              {operation === "sign" ? t("signing") : t("sign")}
            </Button>
            <input
              ref={input}
              type="file"
              multiple
              accept={accept.join(",")}
              className="hidden"
              disabled={busy}
              onChange={(event) => {
                addFiles(Array.from(event.target.files ?? []));
                event.target.value = "";
              }}
            />
          </>
        }
      />
      <div
        className="mx-auto w-full max-w-5xl space-y-4 p-4 sm:p-6"
        data-sign-drop-zone
        data-dragging={dragging}
        onDragEnter={(event) => {
          if (!event.dataTransfer.types.includes("Files")) return;
          event.preventDefault();
          if (!busy) {
            dragDepth.current++;
            setDragging(true);
          }
        }}
        onDragOver={(event) => {
          if (event.dataTransfer.types.includes("Files"))
            event.preventDefault();
        }}
        onDragLeave={() => {
          dragDepth.current = Math.max(0, dragDepth.current - 1);
          if (!dragDepth.current) setDragging(false);
        }}
        onDrop={(event) => {
          event.preventDefault();
          dragDepth.current = 0;
          setDragging(false);
          addFiles(Array.from(event.dataTransfer.files));
        }}
      >
        <Link
          href="/sign/setup"
          className="text-sm underline underline-offset-4"
        >
          {t("checkSigningSetup")}
        </Link>
        {defaultSigningProviderId() !== "companion" && (
          <p
            role="status"
            className="rounded-md border border-amber-500 p-3 text-sm"
          >
            {e("otherProvider", { provider: defaultSigningProviderId() })}
          </p>
        )}

        <section className="space-y-4 rounded-lg border p-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="ifc-sign-format">{m("format")}</Label>
              <Select
                value={format}
                disabled={busy}
                onValueChange={(next) => {
                  resetResults();
                  setFormat(next as Format);
                }}
              >
                <SelectTrigger
                  id="ifc-sign-format"
                  aria-label={m("format")}
                  className="w-full"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="embedded">{m("embedded")}</SelectItem>
                  <SelectItem value="ifczip">{m("ifczip")}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {!embedded && (
              <div className="space-y-2">
                <Label htmlFor="ifc-sign-mode">{t("signatureMode")}</Label>
                <Select
                  value={mode}
                  disabled={busy}
                  onValueChange={(next) => {
                    resetResults();
                    setMode(next as SignMode);
                  }}
                >
                  <SelectTrigger
                    id="ifc-sign-mode"
                    aria-label={t("signatureMode")}
                    className="w-full"
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
            )}
          </div>
          <p className="text-muted-foreground text-sm">
            {embedded
              ? m("embeddedHint")
              : t.rich(
                  mode === "combined" ? "combinedModeHint" : "perFileModeHint",
                  {
                    count: files.length || t("theFilesWord"),
                    strong: (chunks) => <strong>{chunks}</strong>,
                  },
                )}
          </p>
          {/* {service && !service.configured && <p className="text-muted-foreground flex items-center gap-1.5 text-xs" data-timestamp-option data-configured="false">
            <Info className="size-3.5 shrink-0" aria-hidden />{t("timestamp.notConfigured")}
          </p>} */}
          {service?.configured && (
            <div
              className="space-y-1 rounded-md border p-3"
              data-timestamp-option
              data-configured="true"
            >
              {embedded ? (
                <p className="text-muted-foreground text-xs">
                  {t("timestamp.embeddedNote")}
                </p>
              ) : (
                <div className="flex items-start gap-2">
                  <Checkbox
                    id="ifc-sign-timestamp"
                    checked={stamp}
                    disabled={busy}
                    className="mt-0.5"
                    onCheckedChange={(checked) => setStamp(checked === true)}
                  />
                  <div className="space-y-0.5">
                    <Label htmlFor="ifc-sign-timestamp" className="text-sm">
                      {service.name
                        ? t("timestamp.add", { name: service.name })
                        : t("timestamp.addUnnamed")}
                    </Label>
                    <p className="text-muted-foreground text-xs">
                      {t("timestamp.hint")}
                    </p>
                  </div>
                </div>
              )}
            </div>
          )}
          {/* {embedded && (
            <details className="text-muted-foreground text-sm">
              <summary className="cursor-pointer">{m("compatibility")}</summary>
              <div className="space-y-2 pt-2"><p>{e("compatibility")}</p><p>{e("normalization")}</p></div>
            </details>
          )} */}
        </section>

        <section
          className={cn(
            "rounded-lg border",
            dragging && "border-primary bg-primary/5",
          )}
        >
          <div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3">
            <h2 className="text-sm font-medium">
              {m("queue", { count: files.length })}
            </h2>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy || !files.length}
              onClick={() => {
                setFiles([]);
                resetResults();
              }}
            >
              {m("clear")}
            </Button>
          </div>
          {files.length ? (
            <div className="max-h-72 overflow-auto">
              <table className="w-full text-sm">
                <thead className="bg-muted/50">
                  <tr>
                    <th scope="col" className="p-3 text-left font-medium">
                      {t("fileColumn")}
                    </th>
                    <th scope="col" className="p-3 text-right font-medium">
                      {t("sizeColumn")}
                    </th>
                    <th scope="col" className="w-10" />
                  </tr>
                </thead>
                <tbody>
                  {files.map((file, index) => (
                    <tr key={`${file.name}-${index}`} className="border-t">
                      <td className="break-all p-3">
                        {file.name}
                        {embedded &&
                          !file.name.toLowerCase().endsWith(".ifc") && (
                            <p className="text-destructive text-xs">
                              {m("incompatible")}
                            </p>
                          )}
                      </td>
                      <td className="whitespace-nowrap p-3 text-right tabular-nums">
                        {file.size < 1024
                          ? `${file.size} B`
                          : `${(file.size / 1024).toFixed(0)} kB`}
                      </td>
                      <td className="pr-2">
                        <Button
                          variant="ghost"
                          size="icon"
                          className="size-7"
                          disabled={busy}
                          aria-label={t("removeFile", { name: file.name })}
                          onClick={() => {
                            setFiles((current) =>
                              current.filter((_, at) => index !== at),
                            );
                            resetResults();
                          }}
                        >
                          <X className="size-4" />
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="space-y-1 p-10 text-center text-sm text-muted-foreground">
              <p>{t("noFilesSelected")}</p>
              <p>{m("dropHint")}</p>
            </div>
          )}
        </section>
        {incompatible && (
          <p className="text-destructive text-sm">{m("incompatibleHint")}</p>
        )}

        <Link
          href="/sign/verify"
          className="inline-block text-sm underline underline-offset-4"
        >
          {m("verifySignatures")}
        </Link>

        {progress && (
          <section className="space-y-2 rounded-lg border p-4" role="status">
            <p className="text-sm">
              {m("progress", {
                current: progress.current,
                total: progress.total,
              })}{" "}
              {progressLabel()}
            </p>
            <Progress
              value={
                progress.total
                  ? Math.min(
                      100,
                      (Math.max(
                        0,
                        progress.current - (progress.phase === "done" ? 0 : 1),
                      ) /
                        progress.total) *
                        100,
                    )
                  : 0
              }
            />
            {(progress.phase === "signing" ||
              progress.phase === "awaiting-pin") && (
              <p className="text-muted-foreground text-xs">
                {t("pinInOwnWindow")}
              </p>
            )}
          </section>
        )}
        {errors.length > 0 && (
          <section
            className="space-y-2 rounded-lg border border-destructive/40 p-4 text-sm"
            data-sign-errors
          >
            {errors.map((error, index) => (
              <p
                key={index}
                role="alert"
                className="break-words text-destructive"
              >
                {error}
              </p>
            ))}
            {outputs.length > 0 && <p>{m("partial")}</p>}
          </section>
        )}
        {outputs.length > 0 && (
          <section
            className="space-y-3 rounded-lg border p-4"
            data-sign-outputs
          >
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="font-medium">{m("outputs")}</h2>
              {outputs.length > 1 && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => void downloadAll()}
                >
                  <Download className="size-4" />
                  {operation === "download" ? m("packing") : m("downloadAll")}
                </Button>
              )}
            </div>
            <ul className="space-y-2">
              {outputs.map((output) => (
                <li
                  key={output.name}
                  data-sign-output
                  className="flex items-center justify-between gap-3 text-sm"
                >
                  <div className="min-w-0">
                    <p className="break-all">{output.name}</p>
                    <p className="text-muted-foreground text-xs">
                      {t("fileCount", { count: output.covers.length })}
                    </p>
                    {output.timestamp?.status === "added" && (
                      <p
                        className="text-xs"
                        data-timestamp-status="added"
                        title={output.timestamp.tsa}
                      >
                        {t("timestamp.stamped", {
                          time: new Date(
                            output.timestamp.time,
                          ).toLocaleString(),
                        })}
                      </p>
                    )}
                    {output.timestamp?.status === "failed" && (
                      <p
                        className="text-warning text-xs"
                        data-timestamp-status="failed"
                        role="status"
                      >
                        {t("timestamp.failed", {
                          error: output.timestamp.error,
                        })}
                      </p>
                    )}
                  </div>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => downloadBytes(output.name, output.bytes)}
                  >
                    <Download className="size-4" />
                    {t("download")}
                  </Button>
                </li>
              ))}
            </ul>
            {embedded && <p className="text-sm">{e("valid")}</p>}
            {outputs.length > 1 && (
              <p className="text-muted-foreground text-xs">
                {m("archiveHint")}
              </p>
            )}
          </section>
        )}
      </div>
    </div>
  );
}
