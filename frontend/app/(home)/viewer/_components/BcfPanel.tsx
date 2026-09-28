"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import {
  ArrowLeft,
  Download,
  MessageSquarePlus,
  Save,
  ShieldCheck,
  Upload,
} from "lucide-react";
import { toast } from "sonner";

import SignatureBadge from "@/components/SignatureBadge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { BCF_FILE_EXTENSIONS } from "@/config";
import { bcfFileName, serializeBcf } from "@/lib/bcf/serialize";
import { useBcfStore, useSelectedTopic } from "@/lib/bcf/store";
import { createTopic, type BcfTopic } from "@/lib/bcf/types";
import { validateAgainstSchema } from "@/lib/bcf/validate";

import BulkEditBar from "@/app/(home)/bcf/_components/BulkEditBar";
import FilterBar from "@/app/(home)/bcf/_components/FilterBar";
import TopicDetail from "@/app/(home)/bcf/_components/TopicDetail";
import TopicList from "@/app/(home)/bcf/_components/TopicList";
import { useOpenViewpoint } from "@/app/(home)/bcf/_components/useOpenViewpoint";
import RelatedTopics from "./RelatedTopics";

/**
 * The BCF manager, in the viewer.
 *
 * Issues are about elements, and the two useful actions on a topic — open its
 * viewpoint, raise a new one from the current view — both need the viewport.
 * Having them a navigation apart was the same mistake as the IDS page.
 *
 * The panel is narrow, so editing is a list *or* a detail rather than both at
 * once. Clicking a topic restores its first viewpoint and keeps the list in
 * place; its pencil button explicitly enters the detail editor.
 */
export function BcfPanel() {
  const t = useTranslations("viewer.bcfPanel");
  const file = useBcfStore((s) => s.file);
  const dirty = useBcfStore((s) => s.dirty);
  const notes = useBcfStore((s) => s.notes);
  const conflicts = useBcfStore((s) => s.conflicts);
  const signatures = useBcfStore((s) => s.signatures);
  const importArchives = useBcfStore((s) => s.importArchives);
  const addTopic = useBcfStore((s) => s.addTopic);
  const saveDraft = useBcfStore((s) => s.saveDraft);
  const loadDraft = useBcfStore((s) => s.loadDraft);
  const author = useBcfStore((s) => s.author);
  const setAuthor = useBcfStore((s) => s.setAuthor);
  const select = useBcfStore((s) => s.select);
  const selected = useSelectedTopic();

  const fileInput = useRef<HTMLInputElement>(null);
  const [validating, setValidating] = useState(false);
  const [editingGuid, setEditingGuid] = useState<string | null>(null);
  const { openViewpoint, openingGuid } = useOpenViewpoint();

  const onOpenTopic = (topic: BcfTopic) => {
    setEditingGuid(null);
    select(topic.guid);
    const viewpoint = topic.viewpoints[0];
    if (!viewpoint) {
      toast.info(t("noViewpoint"));
      return;
    }
    void openViewpoint(topic, viewpoint);
  };

  const onEditTopic = (topic: BcfTopic) => {
    select(topic.guid);
    setEditingGuid(topic.guid);
  };

  /** Schema-check the archive we would export, with libxml2 in a worker. */
  const onValidate = async () => {
    setValidating(true);
    try {
      const result = await validateAgainstSchema(file);
      if (result.valid) {
        toast.success(t("schemaValid"));
      } else {
        const [first] = result.errors;
        toast.error(
          t("schemaErrors", {
            count: result.errors.length,
            file: first.file,
            message: first.message,
          }),
          { duration: 15_000 },
        );
      }
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : t("validationCouldNotRun"),
      );
    } finally {
      setValidating(false);
    }
  };

  const restored = useRef(false);
  useEffect(() => {
    if (restored.current) return;
    restored.current = true;
    loadDraft().catch(() => undefined);
  }, [loadDraft]);

  // Report import notes and merge conflicts once each, as they arrive.
  const reported = useRef<{ notes: unknown; conflicts: unknown }>({
    notes: null,
    conflicts: null,
  });
  useEffect(() => {
    if (reported.current.notes === notes) return;
    reported.current.notes = notes;
    for (const note of notes.slice(0, 5)) {
      toast.warning(`${note.path}: ${note.message}`, { duration: 10_000 });
    }
  }, [notes]);
  useEffect(() => {
    if (reported.current.conflicts === conflicts) return;
    reported.current.conflicts = conflicts;
    for (const conflict of conflicts.slice(0, 5)) {
      toast.warning(
        conflict.resolution === "kept-both"
          ? t("conflictBothKept", {
              title: conflict.title,
              source1: conflict.sources[0],
              source2: conflict.sources[1],
            })
          : t("conflictMostRecentKept", { title: conflict.title }),
        { duration: 12_000 },
      );
    }
  }, [conflicts, t]);

  const signed = useMemo(() => Object.entries(signatures), [signatures]);

  const onImport = async (files: File[]) => {
    try {
      const archives = await Promise.all(
        files.map(async (item) => ({
          name: item.name,
          bytes: new Uint8Array(await item.arrayBuffer()),
        })),
      );
      importArchives(archives);
      setEditingGuid(null);
      toast.success(t("imported", { count: files.length }));
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : t("fileCouldNotBeRead"),
      );
    }
  };

  const onExport = () => {
    const { bytes, notes: writeNotes } = serializeBcf(file);
    const name = bcfFileName(file);
    const url = URL.createObjectURL(
      new Blob([bytes as BlobPart], { type: "application/octet-stream" }),
    );
    const link = window.document.createElement("a");
    link.href = url;
    link.download = name;
    link.click();
    URL.revokeObjectURL(url);

    toast.success(t("exported", { name }));
    for (const note of writeNotes.slice(0, 3)) toast.warning(note.message);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/*
        The header stays put in both views. Import, export, validate and the
        author field are not properties of the list, and having them disappear
        the moment you open a topic made the panel feel like two screens.
      */}
      <div className="space-y-2 border-b p-2">
        <div className="flex felx-row justify-between items-center gap-1.5 w-full">
          <h2 className="flex-1 text-sm">{t("title")}</h2>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 w-7 p-0"
                aria-label={t("import")}
                onClick={() => fileInput.current?.click()}
              >
                <Upload className="h-3.5 w-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t("import")}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-xs"
                aria-label={t("validate")}
                onClick={onValidate}
                disabled={validating || file.topics.length === 0}
              >
                <ShieldCheck className="h-3.5 w-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t("validate")}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs"
            aria-label={t("saveDraft")}
            disabled={!dirty}
            onClick={async () => {
              await saveDraft();
              toast.success(t("draftSaved"));
            }}
          >
            <Save className="h-3.5 w-3.5" />
          </Button>
          </TooltipTrigger>
          <TooltipContent>{t("saveDraft")}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs"
            aria-label={t("exportBcf")}
            onClick={onExport}
            disabled={file.topics.length === 0}
          >
            <Download className="h-3.5 w-3.5" />
          </Button>
          </TooltipTrigger>
          <TooltipContent>{t("exportBcf")}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs"
            aria-label={t("newTopic")}
            onClick={() => {
              const topic = createTopic({
                  title: t("defaultTopicTitle"),
                  author: author || t("unknownAuthor"),
                  topicType: file.extensions.topicTypes[0] ?? "Issue",
                  topicStatus: file.extensions.topicStatuses[0] ?? "Open",
                });
              addTopic(topic);
              setEditingGuid(topic.guid);
            }}
          >
            <MessageSquarePlus className="h-3.5 w-3.5" />
          </Button>
          </TooltipTrigger>
          <TooltipContent>{t("newTopic")}</TooltipContent>
          </Tooltip>
        </div>

        <div className="space-y-1">
          {/* Comments and new topics are attributed to this. */}
          <Label htmlFor="bcf-author" className="text-xs font-medium">
            {t("authorLabel")}
          </Label>
          <Input
            id="bcf-author"
            type="email"
            value={author}
            onChange={(event) => setAuthor(event.target.value)}
            placeholder={t("authorPlaceholder")}
            className="h-7 text-xs"
          />
        </div>

        {signed.map(([name, signature]) => (
          <div key={name} className="rounded-md border p-1.5">
            <p className="truncate text-[11px] font-medium" title={name}>
              {name}
            </p>
            <SignatureBadge signature={signature} />
          </div>
        ))}
      </div>

      {selected && editingGuid === selected.guid ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="border-b p-2">
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs"
              onClick={() => {
                setEditingGuid(null);
                select(null);
              }}
            >
              <ArrowLeft className="h-3.5 w-3.5" />
              {t("allTopics")}
            </Button>
          </div>
          <div className="min-h-0 flex-1 overflow-auto">
            <TopicDetail topic={selected} />
          </div>
        </div>
      ) : (
        <>
          {/*
            Capped and scrollable. The bulk bar lays its five fields out in a
            row on a wide page; in a 19rem panel they stack into a block tall
            enough to squeeze the topic list to zero height — checking a topic
            made the list disappear.
          */}
          <div className="max-w-full shrink-0 overflow-auto">
            <BulkEditBar />
          </div>
          <FilterBar />
          <RelatedTopics
            onOpenTopic={onOpenTopic}
            onEditTopic={onEditTopic}
          />
          <TopicList
            onOpenTopic={onOpenTopic}
            onEditTopic={onEditTopic}
            openingGuid={openingGuid}
          />
        </>
      )}

      <input
        ref={fileInput}
        type="file"
        multiple
        accept={BCF_FILE_EXTENSIONS.join(",")}
        className="hidden"
        onChange={async (event) => {
          const files = Array.from(event.target.files ?? []);
          event.target.value = "";
          if (files.length > 0) await onImport(files);
        }}
      />
    </div>
  );
}

export default BcfPanel;
