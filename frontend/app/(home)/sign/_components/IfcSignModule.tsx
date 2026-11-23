"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { Download, FileSignature, Upload, X } from "lucide-react";
import { zip } from "fflate";
import { InfoTip } from "@/components/InfoTip";
import ModuleHeader from "@/components/ModuleHeader";
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
  cosignFormat,
  signIfcFiles,
  type BatchOutput,
} from "@/lib/signing/bulk";
import { CosignError } from "@/lib/signing/cosign";
import { EmbeddedIfcError } from "@/lib/signing/embedded";
import {
  commonName,
  summariseIfcSignature,
  type SignatureSummary,
} from "@/lib/signing/summary";
import type { SignMode } from "@/lib/signing/sign";
import { SignatureDetailsFields, type DetailsDraft } from "./SignatureDetailsFields";
import { TimestampOption, useTimestamping } from "./TimestampOption";

type Format = "ifczip" | "embedded";
/**
 * What a queued file carries, read when it is added. Nobody says which is which:
 * an unsigned file is signed in the chosen format, a signed one gets this
 * card's signature added in its own (`signIfcFiles`).
 */
type FileState = "checking" | "unsigned" | "signed" | "invalid";
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
  // Where a time-stamp can come from: the Cartão de Cidadão service through the
  // companion, this deployment's authority, both, or neither.
  const stamping = useTimestamping();
  const [details, setDetails] = useState<DetailsDraft>({ reason: "", location: "" });
  // Who has signed each queued file already, read as it is added. A file not
  // in the map is still being checked; `undefined` means it carries no signature.
  const [signers, setSigners] = useState<ReadonlyMap<File, SignatureSummary | undefined>>(new Map());
  const inspected = useRef(new WeakSet<File>());
  const busy = operation !== null;
  const embedded = format === "embedded";
  const stateOf = (file: File): FileState => {
    if (!cosignFormat(file.name)) return "unsigned";
    if (!signers.has(file)) return "checking";
    const summary = signers.get(file);
    if (!summary) return "unsigned";
    return summary.valid && summary.signers.length > 0 ? "signed" : "invalid";
  };
  const isSigned = (file: File) => signers.get(file) !== undefined;
  const checking = files.some((file) => stateOf(file) === "checking");
  const unsigned = files.filter((file) => stateOf(file) === "unsigned");
  const anySigned = files.some(isSigned);
  // The format is for files with no signature; a signed file keeps its own.
  const fitsFormat = (file: File) =>
    (embedded ? [".ifc"] : IFC_FILE_EXTENSIONS).some((extension) =>
      file.name.toLowerCase().endsWith(extension),
    );
  const incompatible = unsigned.some((file) => !fitsFormat(file));
  // Only when something in the queue may still need it.
  const showFormat = !files.length || files.some((file) => stateOf(file) !== "signed" && stateOf(file) !== "invalid");
  useEffect(() => {
    for (const file of files) {
      if (inspected.current.has(file)) continue;
      // An .ifcxml carries no signature this application can read or join.
      if (!cosignFormat(file.name)) continue;
      inspected.current.add(file);
      void summariseIfcSignature(file).then(
        (summary) => setSigners((current) => new Map(current).set(file, summary)),
        () => setSigners((current) => new Map(current).set(file, undefined)),
      );
    }
  }, [files]);
  // How many signatures this run would stamp, against the Cartão de Cidadão
  // budget: one per file, except one IFCZIP signature over all unsigned files.
  const stampable = !embedded && mode === "combined" && unsigned.length
    ? 1 + files.length - unsigned.length
    : files.length;

  const resetResults = () => {
    setOutputs([]);
    setErrors([]);
  };
  const errorMessage = (error: unknown): string => {
    if (error instanceof BulkSigningError) return m(`errors.${error.code}`);
    if (error instanceof CosignError) return m(`cosign.errors.${error.code}`);
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
        !IFC_FILE_EXTENSIONS.some((extension) => file.name.toLowerCase().endsWith(extension))
      ) {
        rejected.push(
          t("unsupportedFiles", {
            names: file.name,
            extensions: IFC_FILE_EXTENSIONS.join(", "),
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
    if (locked.current || !files.length || incompatible || checking) return;
    locked.current = true;
    setOperation("sign");
    resetResults();
    try {
      registerSigningProviders();
      // XAdES-T in an IFCZIP, CAdES-T inside an IFC: both formats take one.
      const timestamper = stamping.timestamper;
      const onOutput = (output: BatchOutput) =>
        setOutputs((current) => [...current, output]);
      const result = await signIfcFiles(files, await getSigningProvider(), {
        format,
        mode: embedded ? "per-file" : mode,
        isSigned,
        timestamper,
        details,
        onProgress: setProgress,
        onOutput,
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
      // Stamps were spent: show what is left of the budget.
      stamping.refresh();
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
    <div className="flex h-[calc(100dvh-3.25rem-env(safe-area-inset-top))] flex-col overflow-auto">
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
              disabled={busy || !files.length || incompatible || checking}
              onClick={() => void sign()}
            >
              <FileSignature className="size-4" />
              {operation === "sign" ? t("signing") : t("sign")}
            </Button>
            <input
              ref={input}
              type="file"
              multiple
              accept={IFC_FILE_EXTENSIONS.join(",")}
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
            {showFormat && (
            <div className="space-y-2">
              <div className="flex items-center gap-1">
                <Label htmlFor="ifc-sign-format">{m("format")}</Label>
                {/* Inside the IFC there is one kind of signature, so this is
                    help, not a guarantee to choose between: behind the "i". */}
                {embedded && <InfoTip>{m("embeddedHint")}</InfoTip>}
              </div>
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
            )}
            {showFormat && !embedded && (
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
          {anySigned && (
            <p className="text-muted-foreground text-sm" data-cosign-hint>
              {m("cosign.hint")}
            </p>
          )}
          {/* IFCZIP's two modes give different guarantees, and the page says
              which one is being made (sign.ts): in view, not behind an "i". */}
          {showFormat && !embedded && <p className="text-muted-foreground text-sm">
            {t.rich(
                  mode === "combined" ? "combinedModeHint" : "perFileModeHint",
                  {
                    count: files.length || t("theFilesWord"),
                    strong: (chunks) => <strong>{chunks}</strong>,
                  },
                )}
          </p>}
          <SignatureDetailsFields idPrefix="ifc-sign" value={details} onChange={setDetails} disabled={busy} />
          <TimestampOption
            stamping={stamping}
            idPrefix="ifc-sign"
            disabled={busy}
            signatures={stampable}
          />
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
                        <ExistingSigners state={stateOf(file)} summary={signers.get(file)} />
                        {stateOf(file) === "unsigned" && !fitsFormat(file) && (
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
          <p className="text-destructive text-sm">
            {m("incompatibleHint")}
          </p>
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
              <h2 className="font-medium">
                {m("outputs")}
              </h2>
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
                        {output.timestamp.reason === "rate-limited"
                          ? t("timestamp.limitReached")
                          : t("timestamp.failed", { error: output.timestamp.error })}
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
            {outputs.some((output) => output.format === "embedded") && <p className="text-sm">{e("valid")}</p>}
            {anySigned && <p className="text-sm">{m("cosign.verified")}</p>}
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

/** What a queued file carries, and so what signing it will do. */
function ExistingSigners({
  state,
  summary,
}: {
  state: FileState;
  summary: SignatureSummary | undefined;
}) {
  const m = useTranslations("ifcSign.cosign");
  if (state === "checking") {
    return <p className="text-muted-foreground text-xs" data-existing-signers="checking">{m("checking")}</p>;
  }
  if (state === "unsigned") {
    return <p className="text-muted-foreground text-xs" data-existing-signers="none">{m("notSigned")}</p>;
  }
  if (state === "invalid" || !summary) {
    return <p className="text-destructive text-xs" data-existing-signers="invalid">{m("invalid")}</p>;
  }
  return (
    <p className="text-muted-foreground text-xs" data-existing-signers="valid">
      {m("signedBy", {
        count: summary.signers.length,
        names: summary.signers.map((signer) => commonName(signer.subject)).join(" · "),
      })}
    </p>
  );
}
