"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { AlertTriangle, CheckCircle2, FileWarning, Loader2, Upload, X, XCircle } from "lucide-react";
import ModuleHeader from "@/components/ModuleHeader";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { EmbeddedIfcError, verifyEmbeddedIfc, type EmbeddedVerification } from "@/lib/signing/embedded";
import { verifyContainer, type ContainerVerification } from "@/lib/signing/verify";

const EXTENSIONS = [".ifc", ".ifczip", ".bcf", ".bcfzip", ".asice", ".zip", ".scs"];
type Verification = { kind: "embedded"; value: EmbeddedVerification } | { kind: "container"; value: ContainerVerification };
type QueuedFile = { id: number; file: File; result?: Verification; error?: string };

function isValid(result: Verification) {
  return result.value.signatures.length > 0 && result.value.signatures.every((signature) => signature.valid);
}

/** All checks run locally; card access and remote trust validation are unnecessary. */
export default function SignVerifyPage() {
  const t = useTranslations("signVerify");
  const m = useTranslations("ifcVerify");
  const e = useTranslations("embeddedSign");
  const s = useTranslations("signModule");
  const input = useRef<HTMLInputElement>(null);
  const locked = useRef(false);
  const nextId = useRef(0);
  const dragDepth = useRef(0);
  const [files, setFiles] = useState<QueuedFile[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [current, setCurrent] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);

  const addFiles = async (picked: File[]) => {
    if (locked.current || !picked.length) return;
    const accepted: QueuedFile[] = [];
    const rejected: string[] = [];
    const names = new Set(files.map(({ file }) => file.name.toLowerCase()));
    for (const file of picked) {
      if (!EXTENSIONS.some((extension) => file.name.toLowerCase().endsWith(extension))) {
        rejected.push(t("unsupportedFile", { names: file.name, extensions: EXTENSIONS.join(", ") }));
      } else if (names.has(file.name.toLowerCase())) {
        rejected.push(m("duplicate", { name: file.name }));
      } else {
        names.add(file.name.toLowerCase());
        accepted.push({ id: nextId.current++, file });
      }
    }
    setErrors(rejected);
    if (!accepted.length) return;
    locked.current = true;
    setBusy(true);
    setFiles((previous) => [...previous, ...accepted]);
    try {
      // One file at a time bounds peak memory for a batch of large models.
      for (const entry of accepted) {
        setCurrent(entry.file.name);
        try {
          const result: Verification = entry.file.name.toLowerCase().endsWith(".ifc")
            ? { kind: "embedded", value: await verifyEmbeddedIfc(entry.file) }
            : { kind: "container", value: await verifyContainer(new Uint8Array(await entry.file.arrayBuffer())) };
          setFiles((previous) => previous.map((row) => row.id === entry.id ? { ...row, result } : row));
        } catch (error) {
          const message = error instanceof EmbeddedIfcError ? e(`errors.${error.code}`) : t("fileCouldNotBeRead");
          setFiles((previous) => previous.map((row) => row.id === entry.id ? { ...row, error: message } : row));
        }
      }
    } finally {
      setCurrent(null);
      setBusy(false);
      locked.current = false;
    }
  };

  return (
    <div className="flex h-[calc(100vh-3.25rem)] flex-col overflow-auto">
      <ModuleHeader title={t("title")} description={m("description")} actions={
        <>
          <Button variant="outline" size="sm" disabled={busy} onClick={() => input.current?.click()}>
            <Upload className="size-4" />{busy ? t("checking") : s("addFiles")}
          </Button>
          <input ref={input} type="file" multiple accept={EXTENSIONS.join(",")} className="hidden" disabled={busy}
            onChange={(event) => { void addFiles(Array.from(event.target.files ?? [])); event.target.value = ""; }} />
        </>
      } />
      <div className="mx-auto w-full max-w-5xl space-y-4 p-4 sm:p-6" data-verify-drop-zone data-dragging={dragging}
        onDragEnter={(event) => {
          if (!event.dataTransfer.types.includes("Files")) return;
          event.preventDefault();
          if (!busy) { dragDepth.current++; setDragging(true); }
        }}
        onDragOver={(event) => { if (event.dataTransfer.types.includes("Files")) event.preventDefault(); }}
        onDragLeave={() => { dragDepth.current = Math.max(0, dragDepth.current - 1); if (!dragDepth.current) setDragging(false); }}
        onDrop={(event) => { event.preventDefault(); dragDepth.current = 0; setDragging(false); void addFiles(Array.from(event.dataTransfer.files)); }}>
        <Link href="/sign/ifc" className="text-sm underline underline-offset-4">{m("signFiles")}</Link>
        <section className="space-y-2 rounded-lg border p-4 text-sm">
          <h2 className="font-medium">{m("formatsTitle")}</h2>
          <p className="text-muted-foreground">{m("formatsHint")}</p>
          <p className="text-muted-foreground">{m("localHint")}</p>
        </section>
        <section className={cn("rounded-lg border", dragging && "border-primary bg-primary/5")}>
          <div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3">
            <h2 className="text-sm font-medium">{m("queue", { count: files.length })}</h2>
            <Button size="sm" variant="ghost" disabled={busy || !files.length}
              onClick={() => { setFiles([]); setErrors([]); }}>{m("clear")}</Button>
          </div>
          {files.length ? <div className="max-h-72 overflow-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/50"><tr>
                <th scope="col" className="p-3 text-left font-medium">{s("fileColumn")}</th>
                <th scope="col" className="p-3 text-left font-medium">{m("status")}</th>
                <th scope="col" className="p-3 text-right font-medium">{s("sizeColumn")}</th><th scope="col" className="w-10" />
              </tr></thead>
              <tbody>{files.map(({ id, file, result, error }) => <tr key={id} className="border-t">
                <td className="break-all p-3">{file.name}</td>
                <td className="p-3">
                  {/* The one result worth seeing at a glance: colour and an icon as well as the word, so it does not rest on colour alone. */}
                  {result || error ? (
                    <Badge variant={result && isValid(result) ? "success" : "destructive"} data-verify-status={result && isValid(result) ? "verified" : "not-verified"}>
                      {result && isValid(result) ? <CheckCircle2 aria-hidden /> : <XCircle aria-hidden />}
                      {m(result && isValid(result) ? "verified" : "notVerified")}
                    </Badge>
                  ) : (
                    <Badge variant="outline" data-verify-status="checking"><Loader2 className="animate-spin" aria-hidden />{t("checking")}</Badge>
                  )}
                </td>
                <td className="whitespace-nowrap p-3 text-right tabular-nums">{file.size < 1024 ? `${file.size} B` : `${(file.size / 1024).toFixed(0)} kB`}</td>
                <td className="pr-2"><Button variant="ghost" size="icon" className="size-7" disabled={busy}
                  aria-label={s("removeFile", { name: file.name })} onClick={() => setFiles((previous) => previous.filter((row) => row.id !== id))}><X className="size-4" /></Button></td>
              </tr>)}</tbody>
            </table>
          </div> : <div className="space-y-1 p-10 text-center text-sm text-muted-foreground">
            <p>{s("noFilesSelected")}</p><p>{m("dropHint")}</p>
          </div>}
        </section>
        {busy && <p role="status" className="rounded-lg border p-4 text-sm">{m("checkingFile", { name: current ?? "" })}</p>}
        {errors.length > 0 && <section className="space-y-2 rounded-lg border border-destructive/40 p-4 text-sm" data-verify-errors>
          {errors.map((error, index) => <p key={index} role="alert" className="text-destructive">{error}</p>)}
        </section>}

        {files.some((file) => file.result || file.error) && <section className="space-y-4" data-verify-results
          data-embedded-verification={files.some((file) => file.result?.kind === "embedded") ? "true" : undefined} aria-live="polite">
          <h2 className="font-medium">{m("results")}</h2>
          {files.map(({ id, file, result, error }) => (result || error) && <section key={id} className="space-y-3 rounded-lg border p-4" data-verify-file>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="min-w-0 break-all text-sm font-medium">{file.name}</h3>
              <Badge variant="outline">{m(file.name.toLowerCase().endsWith(".ifc") ? "embedded" : "container")}</Badge>
            </div>
            {error ? <p className="text-destructive text-sm" role="alert">{error}</p> : result && <>
              <div role="status" className={cn("flex items-start gap-2 rounded-md border px-3 py-2 text-sm font-medium",
                isValid(result) ? "border-emerald-600/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400" : "border-destructive/40 bg-destructive/10 text-destructive")}>
                {isValid(result) ? <CheckCircle2 className="mt-0.5 size-4 shrink-0" aria-hidden /> : <XCircle className="mt-0.5 size-4 shrink-0" aria-hidden />}
                {result.kind === "embedded" ? e(isValid(result) ? "valid" : "invalid") : t(isValid(result) ? "signatureValid" : "signatureNotValid")}
              </div>
              {result.kind === "embedded" ? <EmbeddedDetails result={result.value} /> : <ContainerDetails result={result.value} />}
            </>}
          </section>)}
        </section>}
      </div>
    </div>
  );
}

function EmbeddedDetails({ result }: { result: EmbeddedVerification }) {
  const t = useTranslations("signVerify");
  const m = useTranslations("ifcVerify");
  const e = useTranslations("embeddedSign");
  return <div className="space-y-3">
    {/* <p className="text-xs text-muted-foreground">{e("normalization")}</p> */}
    {result.signatures.map((signature, index) => <section key={index} className="space-y-2 rounded-md border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <h4 className="text-xs font-medium">{m("signatureNumber", { count: index + 1 })}</h4>
        <Badge variant={signature.valid ? "success" : "destructive"}>{m(signature.valid ? "verified" : "notVerified")}</Badge>
      </div>
      {signature.valid ? <dl className="grid gap-x-4 gap-y-1 text-xs sm:grid-cols-2">
        <Row label={t("signedBy")} value={signature.subject ?? "—"} />
        <Row label={t("issuedBy")} value={signature.issuer ?? "—"} />
        <Row label={t("signingTime")} value={signature.signingTime ?? "—"} />
      </dl> : <p className="text-destructive text-xs">{e("invalid")}</p>}
    </section>)}
  </div>;
}

function ContainerDetails({ result }: { result: ContainerVerification }) {
  const t = useTranslations("signVerify");
  const m = useTranslations("ifcVerify");
  return <div className="space-y-3">
    {result.problems.length > 0 && <ul className="space-y-1">
      {result.problems.map((problem, index) => <li key={index} className="flex items-start gap-2 rounded-md border p-2.5 text-xs">
        <FileWarning className="mt-0.5 size-3.5 shrink-0" aria-hidden />{problem}
      </li>)}
    </ul>}
    {result.payload.length > 0 && <section className="space-y-1">
      <h4 className="text-xs font-semibold">{t("contents")}</h4>
      <ul className="space-y-0.5 break-all text-xs text-muted-foreground">{result.payload.map((name) => <li key={name}>{name}</li>)}</ul>
    </section>}
    {result.signatures.map((signature, index) => <section key={`${signature.file}-${index}`} className="space-y-2 rounded-md border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <h4 className="break-all text-xs font-semibold">{signature.file}</h4>
        <Badge variant={signature.valid ? "default" : "destructive"}>{t(signature.valid ? "valid" : "invalid")}</Badge>
        {signature.algorithm && <Badge variant="outline">{signature.algorithm}</Badge>}
      </div>
      <dl className="grid gap-x-4 gap-y-1 text-xs sm:grid-cols-2">
        <Row label={t("signedBy")} value={signature.subject} />
        <Row label={t("issuedBy")} value={signature.issuer} />
        <Row label={t("serial")} value={signature.serial} />
        <Row label={t("signingTime")} value={signature.signingTime ?? "—"} />
        <Row label={m("certificateDates")} value={t("certificateValidRange", { from: signature.notBefore.slice(0, 10), to: signature.notAfter.slice(0, 10) })} />
        <Row label={t("signatureMaths")} value={t(signature.signatureValid ? "verified" : "failed")} />
        <Row label={t("timestamp.label")} value={!signature.timestamp ? t("timestamp.none") : signature.timestamp.matches
          ? t("timestamp.present", { time: signature.timestamp.time ?? "—", tsa: signature.timestamp.tsa ?? "—" })
          : t("timestamp.mismatch", { problem: signature.timestamp.problems.join("; ") })} />
      </dl>
      <div className="space-y-1">
        <h5 className="text-xs font-medium">{t("whatItCovers")}</h5>
        <ul className="space-y-0.5">{signature.references.map((reference, at) => <li key={`${reference.uri}-${at}`} className="flex items-start gap-1.5 text-xs">
          {reference.present && reference.digestMatches ? <CheckCircle2 className="mt-0.5 size-3 shrink-0 text-emerald-600" aria-hidden /> : <AlertTriangle className="mt-0.5 size-3 shrink-0 text-destructive" aria-hidden />}
          <span className="break-all">{reference.uri.startsWith("#") ? t("signedProperties") : reference.uri}</span>
          {!reference.present && <span className="text-destructive">{t("notInContainer")}</span>}
          {reference.present && !reference.digestMatches && <span className="text-destructive">{t("contentChanged")}</span>}
        </li>)}</ul>
      </div>
      {signature.problems.length > 0 && <ul className="space-y-0.5 text-xs text-destructive">
        {signature.problems.map((problem, at) => <li key={at}>{problem}</li>)}
      </ul>}
    </section>)}
  </div>;
}

function Row({ label, value }: { label: string; value: string }) {
  return <div className="flex flex-wrap gap-1.5">
    <dt className="shrink-0 text-muted-foreground">{label}:</dt><dd className="min-w-0 break-words">{value}</dd>
  </div>;
}
