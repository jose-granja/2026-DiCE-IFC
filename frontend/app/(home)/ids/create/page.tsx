"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { useQuery } from "@tanstack/react-query";
import { Download, FileDown, FilePlus2, FileText, Save, Upload } from "lucide-react";
import { toast } from "sonner";

import ModuleHeader from "@/components/ModuleHeader";
import { ResizeHandle, useResizableWidth } from "@/components/PanelResizeHandle";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { IDS_FILE_EXTENSIONS } from "@/config";
import { useIdsStore, useSelectedSpecification } from "@/lib/ids/store";
import { parseIds } from "@/lib/ids/parse";
import { idsFileName, serializeIds } from "@/lib/ids/serialize";
import { useIdsPdfReport } from "@/lib/ids/pdf-report";
import { getModelHandle } from "@/lib/viewer/loader";
import { useViewerStore } from "@/lib/viewer/store";

import SpecificationList from "./_components/SpecificationList";
import SpecificationEditor from "./_components/SpecificationEditor";
import FileMetadataEditor from "./_components/FileMetadataEditor";
import PreviewPanel from "./_components/PreviewPanel";
import DictionaryPicker from "./_components/DictionaryPicker";

/**
 * IDS authoring.
 *
 * A Client Component: the specification is user content and never leaves the
 * browser — it is written, validated and downloaded here.
 *
 * The one thing this does that the reference web app cannot is autocomplete
 * facet values from a **loaded IFC**: real class names, real property sets,
 * real classification systems. A specification written against a mistyped Pset
 * name reports every element as failing, and that mistake is invisible until
 * someone runs the validation.
 */
export default function IdsCreatePage() {
  const t = useTranslations("idsCreate");
  const document_ = useIdsStore((s) => s.document);
  const dirty = useIdsStore((s) => s.dirty);
  const selectedId = useIdsStore((s) => s.selectedId);
  const select = useIdsStore((s) => s.select);
  const setDocument = useIdsStore((s) => s.setDocument);
  const saveDraft = useIdsStore((s) => s.saveDraft);
  const loadDraft = useIdsStore((s) => s.loadDraft);
  const startNew = useIdsStore((s) => s.startNew);
  const selected = useSelectedSpecification();

  // Select the array, then derive. Filtering *inside* the selector builds a
  // new array on every store read, which zustand compares by reference — so it
  // never settles and React bails with "maximum update depth exceeded".
  const allModels = useViewerStore((s) => s.models);
  const models = useMemo(
    () => allModels.filter((m) => m.load.status === "ready"),
    [allModels],
  );
  const [vocabularyModelId, setVocabularyModelId] = useState<string | null>(null);
  const [pdfDownloading, setPdfDownloading] = useState(false);
  const [newDialogOpen, setNewDialogOpen] = useState(false);
  const [startingNew, setStartingNew] = useState(false);
  const buildPdfReport = useIdsPdfReport();
  const [leftWidth, setLeftWidth] = useResizableWidth("left", 304, 240, 560, "ids");
  const [rightWidth, setRightWidth] = useResizableWidth("right", 384, 280, 640, "ids");
  const fileInput = useRef<HTMLInputElement>(null);

  // Restore the draft once on mount. Losing an afternoon's authoring to a
  // closed tab would be its own bug.
  const restored = useRef(false);
  useEffect(() => {
    if (restored.current) return;
    restored.current = true;
    loadDraft().catch(() => undefined);
  }, [loadDraft]);

  // Derived, not synced: defaulting to the first model is a fallback, and
  // writing it into state from an effect would cascade a render for a value
  // that can simply be computed.
  const activeModelId = vocabularyModelId ?? models[0]?.summary.id ?? null;

  const { data: vocabulary } = useQuery({
    queryKey: ["ids-vocabulary", activeModelId],
    enabled: Boolean(activeModelId),
    staleTime: Infinity,
    queryFn: async () => {
      const handle = getModelHandle(activeModelId!);
      return handle ? handle.getVocabulary() : null;
    },
  });

  const onDownload = () => {
    const xml = serializeIds(document_, { generator: "DiCE-IFC" });
    const blob = new Blob([xml], { type: "application/xml" });
    const url = URL.createObjectURL(blob);
    const link = window.document.createElement("a");
    link.href = url;
    link.download = idsFileName(document_);
    link.click();
    URL.revokeObjectURL(url);
    toast.success(t("downloaded", { name: idsFileName(document_) }));
  };

  const onDownloadPdf = async () => {
    setPdfDownloading(true);
    try {
      // Load the PDF engine and embedded fonts only when the user downloads.
      // No IDS content is sent to a server or a font CDN.
      const [pdfMakeModule, fontsModule] = await Promise.all([
        import("pdfmake/build/pdfmake"),
        import("pdfmake/build/vfs_fonts"),
      ]);
      const pdfMake = pdfMakeModule.default;
      pdfMake.addVirtualFileSystem(fontsModule.default);
      const name = idsFileName(document_).replace(/\.ids$/i, ".pdf");
      await pdfMake.createPdf(buildPdfReport(document_)).download(name);
      toast.success(t("pdfDownloaded", { name }));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("pdfFailed"));
    } finally {
      setPdfDownloading(false);
    }
  };

  const onImport = async (file: File) => {
    try {
      const { document: imported, notes } = parseIds(await file.text());
      setDocument(imported);

      toast.success(t("imported", { count: imported.specifications.length }));
      // Never silently "fix" a file: anything changed on the way in is
      // reported, because the author is about to write it back out.
      for (const note of notes) {
        toast.warning(`${note.path}: ${note.message}`, { duration: 10_000 });
      }
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : t("fileCouldNotBeRead"),
      );
    }
  };

  return (
    <div className="flex h-[calc(100vh-3.25rem)] flex-col">
      <ModuleHeader
        title={t("header.title")}
        description={t("header.description")}
        actions={
          <>
            {models.length > 0 && (
              <Select
                value={activeModelId ?? undefined}
                onValueChange={setVocabularyModelId}
              >
                <SelectTrigger className="w-56" aria-label={t("modelForAutocomplete")}>
                  <SelectValue placeholder={t("autocompleteFromPlaceholder")} />
                </SelectTrigger>
                <SelectContent>
                  {models.map((model) => (
                    <SelectItem key={model.summary.id} value={model.summary.id}>
                      {model.summary.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}

            <DictionaryPicker />

            <Button variant="ghost" size="sm" onClick={() => setNewDialogOpen(true)}>
              <FilePlus2 className="h-4 w-4" />
              {t("newIds")}
            </Button>

            <Button
              variant="ghost"
              size="sm"
              onClick={() => fileInput.current?.click()}
            >
              <Upload className="h-4 w-4" />
              {t("import")}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={!dirty}
              onClick={async () => {
                await saveDraft();
                toast.success(t("draftSaved"));
              }}
            >
              <Save className="h-4 w-4" />
              {t("saveDraft")}
            </Button>
            <Button size="sm" onClick={onDownload}>
              <Download className="h-4 w-4" />
              {t("downloadIds")}
            </Button>
            <Button variant="secondary" size="sm" disabled={pdfDownloading} onClick={onDownloadPdf}>
              <FileDown className="h-4 w-4" />
              {t("downloadPdf")}
            </Button>

            <input
              ref={fileInput}
              type="file"
              accept={IDS_FILE_EXTENSIONS.join(",")}
              className="hidden"
              onChange={async (event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                if (file) await onImport(file);
              }}
            />
          </>
        }
      />

      <Dialog open={newDialogOpen} onOpenChange={setNewDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("newIdsDialog.title")}</DialogTitle>
            <DialogDescription>{t("newIdsDialog.description")}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline" disabled={startingNew}>
                {t("newIdsDialog.cancel")}
              </Button>
            </DialogClose>
            <Button
              disabled={startingNew}
              onClick={async () => {
                setStartingNew(true);
                try {
                  await startNew();
                  setNewDialogOpen(false);
                  toast.success(t("newIdsStarted"));
                } catch (error) {
                  toast.error(
                    error instanceof Error ? error.message : t("newIdsFailed"),
                  );
                } finally {
                  setStartingNew(false);
                }
              }}
            >
              {t("newIdsDialog.confirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <div className="grid min-h-0 flex-1 grid-cols-1 lg:flex">
        <aside
          style={{ width: `min(${leftWidth}px, calc((100% - 22rem) / 2))` }}
          className="flex min-h-0 shrink-0 flex-col overflow-hidden border-r max-lg:!w-full lg:border-r-0"
        >
          <div className="border-b p-2">
            <button
              type="button"
              onClick={() => select(null)}
              aria-current={selectedId === null ? "true" : undefined}
              className={`flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm font-medium hover:bg-accent ${selectedId === null ? "bg-accent" : ""}`}
            >
              <FileText className="h-4 w-4" />
              {t("fileMetadata")}
            </button>
          </div>
          <SpecificationList />
        </aside>

        <div className="hidden lg:flex">
          <ResizeHandle
            label={t("resize.specificationList")}
            onDrag={(deltaX) => setLeftWidth((width) => width + deltaX)}
          />
        </div>

        <main className="min-h-0 min-w-0 flex-1 overflow-auto">
          {selected ? (
            <SpecificationEditor
              key={selected.id}
              specification={selected}
              vocabulary={vocabulary ?? null}
            />
          ) : (
            <FileMetadataEditor />
          )}
        </main>

        <div className="hidden lg:flex">
          <ResizeHandle
            label={t("resize.previewPanel")}
            onDrag={(deltaX) => setRightWidth((width) => width - deltaX)}
          />
        </div>

        <aside
          style={{ width: `min(${rightWidth}px, calc((100% - 22rem) / 2))` }}
          className="min-h-0 shrink-0 overflow-hidden border-l max-lg:!w-full lg:border-l-0"
        >
          <PreviewPanel document={document_} />
        </aside>
      </div>
    </div>
  );
}
