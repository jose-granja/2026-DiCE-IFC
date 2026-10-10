"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Camera, FileText, Link2, Plus, Send, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import { captureViewpoint } from "@/lib/bcf/actions";
import { useBcfStore } from "@/lib/bcf/store";
import type { BcfTopic } from "@/lib/bcf/types";
import { ViewpointCard } from "./ViewpointCard";
import { VocabularyInput } from "./VocabularyInput";

/**
 * The topic detail pane.
 *
 * Everything is edited in place: a BCF topic is a small record and a modal for
 * each field would make triaging fifty of them unbearable. Every change stamps
 * `ModifiedDate` and `ModifiedAuthor`, which is what other tools use to decide
 * whose version wins on merge.
 */
export function TopicDetail({ topic }: { topic: BcfTopic }) {
  const t = useTranslations("bcf.topicDetail");
  const updateTopic = useBcfStore((s) => s.updateTopic);
  const removeTopic = useBcfStore((s) => s.removeTopic);
  const addViewpoint = useBcfStore((s) => s.addViewpoint);
  const extensions = useBcfStore((s) => s.file.extensions);
  const topics = useBcfStore((s) => s.file.topics);
  const select = useBcfStore((s) => s.select);

  const [capturing, setCapturing] = useState(false);

  const onCapture = async () => {
    setCapturing(true);
    try {
      const viewpoint = await captureViewpoint(topic.headerFiles[0]?.filename);
      if (!viewpoint) {
        toast.warning(t("loadModelFirst"));
        return;
      }
      addViewpoint(topic.guid, viewpoint);
      toast.success(t("viewpointCaptured"));
    } finally {
      setCapturing(false);
    }
  };

  return (
    <div className="space-y-5 p-4">
      <div className="flex items-start justify-between gap-3">
        <Input
          value={topic.title}
          onChange={(event) => updateTopic(topic.guid, { title: event.target.value })}
          className="h-9 text-sm font-medium"
          aria-label={t("topicTitle")}
        />
        <Button
          variant="ghost"
          size="sm"
          className="h-9 shrink-0"
          onClick={() => removeTopic(topic.guid)}
        >
          <Trash2 className="h-4 w-4" />
          {t("delete")}
        </Button>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
        <VocabularyInput
          label={t("status")}
          value={topic.topicStatus}
          options={extensions.topicStatuses}
          onChange={(value) => updateTopic(topic.guid, { topicStatus: value })}
        />
        <VocabularyInput
          label={t("priority")}
          value={topic.priority}
          options={extensions.priorities}
          onChange={(value) => updateTopic(topic.guid, { priority: value })}
        />
        <VocabularyInput
          label={t("type")}
          value={topic.topicType}
          options={extensions.topicTypes}
          onChange={(value) => updateTopic(topic.guid, { topicType: value })}
        />
        <VocabularyInput
          label={t("assignedTo")}
          value={topic.assignedTo}
          options={extensions.users}
          onChange={(value) => updateTopic(topic.guid, { assignedTo: value })}
        />
        <VocabularyInput
          label={t("stage")}
          value={topic.stage}
          options={extensions.stages}
          onChange={(value) => updateTopic(topic.guid, { stage: value })}
        />

        <div className="space-y-1.5">
          <Label htmlFor="topic-due" className="text-xs font-medium">
            {t("dueDate")}
          </Label>
          <Input
            id="topic-due"
            type="date"
            value={topic.dueDate ? topic.dueDate.slice(0, 10) : ""}
            onChange={(event) =>
              updateTopic(topic.guid, {
                // BCF wants an xs:dateTime; a date input gives a plain date.
                dueDate: event.target.value
                  ? new Date(`${event.target.value}T00:00:00Z`).toISOString()
                  : undefined,
              })
            }
            className="h-8 text-xs"
          />
        </div>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="topic-description" className="text-xs font-medium">
          {t("description")}
        </Label>
        <Textarea
          id="topic-description"
          value={topic.description ?? ""}
          onChange={(event) =>
            updateTopic(topic.guid, { description: event.target.value || undefined })
          }
          rows={4}
          className="text-xs"
          placeholder={t("descriptionPlaceholder")}
        />
      </div>

      <LabelsEditor topic={topic} />

      <Separator />

      <section className="space-y-2">
        <div className="flex items-center justify-between">
          <h2 className="flex items-center gap-1.5 text-xs font-semibold">
            <Camera className="h-3.5 w-3.5" aria-hidden />
            {t("viewpoints")}
            <Badge variant="secondary" className="h-4 px-1.5 text-[10px]">
              {topic.viewpoints.length}
            </Badge>
          </h2>
          <Button
            variant="secondary"
            size="sm"
            className="h-7 px-2 text-xs"
            onClick={onCapture}
            disabled={capturing}
          >
            <Plus className="h-3.5 w-3.5" />
            {t("captureCurrentView")}
          </Button>
        </div>

        {topic.viewpoints.length === 0 ? (
          <p className="text-muted-foreground text-xs">
            {t("noViewpoints")}
          </p>
        ) : (
          <div className="grid gap-2 sm:grid-cols-2">
            {topic.viewpoints.map((viewpoint) => (
              <ViewpointCard
                key={viewpoint.guid}
                topic={topic}
                viewpoint={viewpoint}
              />
            ))}
          </div>
        )}
      </section>

      <Separator />

      <CommentThread topic={topic} />

      {topic.documentReferences.length > 0 && (
        <>
          <Separator />
          <section className="space-y-2">
            <h2 className="flex items-center gap-1.5 text-xs font-semibold">
              <FileText className="h-3.5 w-3.5" aria-hidden />
              {t("documents")}
            </h2>
            <ul className="space-y-1">
              {topic.documentReferences.map((reference) => (
                <li key={reference.guid} className="text-xs">
                  {reference.url ? (
                    <a
                      href={reference.url}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="text-primary underline underline-offset-2"
                    >
                      {reference.description || reference.url}
                    </a>
                  ) : (
                    <DocumentName
                      guid={reference.documentGuid}
                      fallback={reference.description}
                    />
                  )}
                </li>
              ))}
            </ul>
          </section>
        </>
      )}

      {topic.relatedTopics.length > 0 && (
        <>
          <Separator />
          <section className="space-y-2">
            <h2 className="flex items-center gap-1.5 text-xs font-semibold">
              <Link2 className="h-3.5 w-3.5" aria-hidden />
              {t("relatedTopics")}
            </h2>
            <ul className="space-y-1">
              {topic.relatedTopics.map((guid) => {
                const related = topics.find((candidate) => candidate.guid === guid);
                return (
                  <li key={guid} className="text-xs">
                    {related ? (
                      <button
                        type="button"
                        onClick={() => select(guid)}
                        className="text-primary underline underline-offset-2"
                      >
                        {related.title}
                      </button>
                    ) : (
                      <span className="text-muted-foreground">
                        {t("notInThisFile", { guid: guid.slice(0, 8) })}
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        </>
      )}

      <p className="text-muted-foreground text-[11px]">
        {t("createdBy", {
          date: formatDate(topic.creationDate, t("unknownDate")),
          author: topic.creationAuthor || t("unknownAuthor"),
        })}
        {topic.modifiedDate && ` · ${t("modified", { date: formatDate(topic.modifiedDate, t("unknownDate")) })}`}
      </p>
    </div>
  );
}

function DocumentName({
  guid,
  fallback,
}: {
  guid?: string;
  fallback?: string;
}) {
  const t = useTranslations("bcf.topicDetail");
  const documents = useBcfStore((s) => s.file.documents);
  const document_ = documents.find((entry) => entry.guid === guid);

  return (
    <span className="text-muted-foreground">
      {document_?.filename ?? fallback ?? t("attachedDocument")}
    </span>
  );
}

function LabelsEditor({ topic }: { topic: BcfTopic }) {
  const t = useTranslations("bcf.topicDetail");
  const updateTopic = useBcfStore((s) => s.updateTopic);
  const [draft, setDraft] = useState("");

  const add = () => {
    const value = draft.trim();
    if (!value || topic.labels.includes(value)) {
      setDraft("");
      return;
    }
    updateTopic(topic.guid, { labels: [...topic.labels, value] });
    setDraft("");
  };

  return (
    <div className="space-y-1.5">
      <Label htmlFor="topic-label" className="text-xs font-medium">
        {t("labels")}
      </Label>
      <div className="flex flex-wrap items-center gap-1.5">
        {topic.labels.map((label) => (
          <Badge key={label} variant="secondary" className="gap-1 text-[10px]">
            {label}
            <button
              type="button"
              onClick={() =>
                updateTopic(topic.guid, {
                  labels: topic.labels.filter((item) => item !== label),
                })
              }
              aria-label={t("removeLabel", { label })}
              className="hover:text-destructive"
            >
              ×
            </button>
          </Badge>
        ))}
        <Input
          id="topic-label"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              add();
            }
          }}
          onBlur={add}
          placeholder={t("addLabelPlaceholder")}
          className="h-7 w-32 text-xs"
        />
      </div>
    </div>
  );
}

function CommentThread({ topic }: { topic: BcfTopic }) {
  const t = useTranslations("bcf.topicDetail");
  const addComment = useBcfStore((s) => s.addComment);
  const removeComment = useBcfStore((s) => s.removeComment);
  const [draft, setDraft] = useState("");

  const submit = () => {
    const text = draft.trim();
    if (!text) return;
    addComment(topic.guid, text);
    setDraft("");
  };

  return (
    <section className="space-y-2">
      <h2 className="text-xs font-semibold">
        {t("comments")}{" "}
        <Badge variant="secondary" className="h-4 px-1.5 text-[10px]">
          {topic.comments.length}
        </Badge>
      </h2>

      <ul className="space-y-2">
        {topic.comments.map((comment) => (
          <li key={comment.guid} className="rounded-md border p-2">
            <div className="flex items-start justify-between gap-2">
              <p className="min-w-0 flex-1 text-xs whitespace-pre-wrap">
                {comment.comment}
              </p>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 w-6 shrink-0 p-0"
                onClick={() => removeComment(topic.guid, comment.guid)}
                aria-label={t("deleteComment")}
              >
                <Trash2 className="h-3 w-3" />
              </Button>
            </div>
            <p className="text-muted-foreground mt-1 text-[10px]">
              {comment.author || t("unknownAuthor")} · {formatDate(comment.date, t("unknownDate"))}
            </p>
          </li>
        ))}
      </ul>

      <div className="flex items-start gap-2">
        <Textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          rows={2}
          placeholder={t("addCommentPlaceholder")}
          className="text-xs"
          aria-label={t("newComment")}
        />
        <Button size="sm" className="h-8" onClick={submit} disabled={!draft.trim()}>
          <Send className="h-3.5 w-3.5" />
          <span className="sr-only">{t("addComment")}</span>
        </Button>
      </div>
    </section>
  );
}

/**
 * Fixed locale and time zone.
 *
 * `toLocaleString()` with the visitor's locale renders differently on the
 * server and the client, and React reports that as a hydration mismatch.
 */
function formatDate(value: string | undefined, unknown = "unknown"): string {
  if (!value) return unknown;
  const at = Date.parse(value);
  if (!Number.isFinite(at)) return value;

  return new Date(at).toISOString().slice(0, 16).replace("T", " ");
}

export default TopicDetail;
