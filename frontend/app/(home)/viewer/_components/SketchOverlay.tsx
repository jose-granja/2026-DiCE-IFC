"use client";

/**
 * Sketch on the live 3D view: arrows, clouds, freehand and text drawn straight
 * over the viewport, as a coordinator marks up what they are looking at.
 *
 * The marks belong to the view they were drawn on, so while sketching the
 * layer takes every pointer event and the camera stays where it is. Anything
 * that moves it from elsewhere (the tree, a BCF viewpoint) is noticed and
 * said, since the marks would no longer point at what they meant.
 *
 * Two ways out with the drawing:
 * - **New BCF topic**: the current view captured as a viewpoint, exactly as
 *   the BCF panel's Capture does, with the marks baked into its snapshot and
 *   kept editable inside it (`composeAnnotatedSnapshot`, the dcAn chunk), so
 *   the topic's annotation editor opens them again.
 * - **Download PNG**: the view with the marks drawn in, a plain image.
 *
 * Shapes are fractions of the layer, which covers the canvas exactly, so they
 * land in the same place on the renderer's snapshot whatever its pixel size.
 * Nothing leaves the browser: the PNG is made here and saved by the browser.
 */

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Download, Loader2, MessageSquarePlus, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { AnnotationSurface, AnnotationToolbar, useAnnotationEditor } from "@/components/annotations/AnnotationEditing";
import { captureViewpoint } from "@/lib/bcf/actions";
import { composeAnnotatedSnapshot, renderAnnotatedPng, type Annotation } from "@/lib/bcf/annotations";
import { useBcfStore } from "@/lib/bcf/store";
import { createTopic } from "@/lib/bcf/types";
import { getActiveRenderer } from "@/lib/viewer/active-renderer";
import { useViewerPanelStore } from "@/lib/viewer/panel-store";

/** The bytes of a `data:` URL, as `renderer.snapshot()` returns. */
function dataUrlBytes(dataUrl: string): Uint8Array | null {
  const base64 = dataUrl.split(",")[1];
  if (!base64) return null;
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function saveFile(bytes: Uint8Array, name: string) {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: "image/png" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  // After the click has handed the file to the browser.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** `sketch-2026-11-25-1432.png`, local time. */
function fileName(now = new Date()) {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `sketch-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}.png`;
}

/** Typing in a field elsewhere on the page is not a sketch shortcut. */
function isEditable(target: EventTarget | null) {
  return target instanceof HTMLElement &&
    (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));
}

const cameraKey = () => {
  const renderer = getActiveRenderer();
  return renderer ? JSON.stringify(renderer.getCameraState()) : "";
};

export default function SketchOverlay({
  initial,
  onClose,
}: {
  initial: Annotation[];
  /** Leave sketching; `discarded` is what was drawn and not kept anywhere. */
  onClose: (discarded: Annotation[]) => void;
}) {
  const t = useTranslations("viewer.sketch");
  const tBcf = useTranslations("viewer.bcfPanel");
  const editor = useAnnotationEditor(initial, "pen");
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [busy, setBusy] = useState<"issue" | "download" | null>(null);
  const [moved, setMoved] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const camera = useRef("");

  // The layer is the canvas's size, and follows a panel being dragged wider.
  useEffect(() => {
    const element = box.current;
    if (!element) return;
    const fit = () => setSize({ width: element.clientWidth, height: element.clientHeight });
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // The view the marks were drawn on; say so when it changes under them.
  useEffect(() => {
    const renderer = getActiveRenderer();
    if (!renderer) return;
    camera.current = cameraKey();
    return renderer.onCameraSettled(() => setMoved(cameraKey() !== camera.current), 150);
  }, []);

  const close = () => onClose(editor.commitText());

  // Esc leaves; undo, redo and delete work wherever focus is in the viewer.
  const keys = useRef({ close, handleKey: editor.handleKey, typing: editor.typing });
  useEffect(() => {
    keys.current = { close, handleKey: editor.handleKey, typing: editor.typing };
  });
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || isEditable(event.target)) return;
      if (event.key === "Escape" && !keys.current.typing.current) {
        event.preventDefault();
        keys.current.close();
        return;
      }
      keys.current.handleKey(event);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const restart = () => {
    editor.clear();
    camera.current = cameraKey();
    setMoved(false);
  };

  const download = async () => {
    const shapes = editor.commitText();
    const renderer = getActiveRenderer();
    const base = renderer ? dataUrlBytes(renderer.snapshot()) : null;
    if (!base) {
      toast.error(t("noView"));
      return;
    }
    setBusy("download");
    try {
      const name = fileName();
      saveFile(await renderAnnotatedPng(base, shapes), name);
      toast.success(t("downloaded", { name }));
    } catch (error) {
      toast.error(t("failed", { message: error instanceof Error ? error.message : String(error) }));
    } finally {
      setBusy(null);
    }
  };

  const createIssue = async () => {
    const shapes = editor.commitText();
    setBusy("issue");
    try {
      // The BCF panel loads the saved draft the first time it opens, unless
      // there are topics already. Load it now, or this topic would be the
      // only one and the draft's would never come back.
      const before = useBcfStore.getState();
      if (before.file.topics.length === 0 && !before.dirty) await before.loadDraft().catch(() => false);

      const viewpoint = await captureViewpoint();
      if (!viewpoint) {
        toast.error(t("noView"));
        return;
      }
      if (viewpoint.snapshot) {
        viewpoint.snapshot = {
          ...viewpoint.snapshot,
          bytes: await composeAnnotatedSnapshot(viewpoint.snapshot.bytes, shapes),
        };
      }

      const bcf = useBcfStore.getState();
      const topic = createTopic({
        title: tBcf("defaultTopicTitle"),
        author: bcf.author || tBcf("unknownAuthor"),
        topicType: bcf.file.extensions.topicTypes[0] ?? "Issue",
        topicStatus: bcf.file.extensions.topicStatuses[0] ?? "Open",
      });
      bcf.addTopic(topic);
      bcf.addViewpoint(topic.guid, viewpoint);
      bcf.select(topic.guid);
      bcf.setEditingGuid(topic.guid);
      useViewerPanelStore.getState().open("bcf");
      toast.success(t("issueCreated", { count: shapes.length }));
      onClose([]);
    } catch (error) {
      toast.error(t("failed", { message: error instanceof Error ? error.message : String(error) }));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div
      className="ring-primary/70 absolute inset-0 z-30 rounded-sm ring-2 ring-inset"
      data-viewer-sketch
      data-sketch-moved={moved || undefined}
    >
      <div ref={box} className="absolute inset-0">
        <AnnotationSurface editor={editor} width={size.width} height={size.height} label={t("canvas")} />
      </div>

      <div className="pointer-events-none absolute inset-x-2 top-2 flex flex-col items-center gap-2">
        <div className="glass bg-card pointer-events-auto max-w-full rounded-xl border p-1 shadow-md">
          <AnnotationToolbar editor={editor} className="justify-center" />
        </div>
        {moved && (
          <div
            role="status"
            className="glass bg-card pointer-events-auto flex items-center gap-2 rounded-lg border px-3 py-1 text-xs shadow-md"
          >
            <span>{t("viewMoved")}</span>
            <Button type="button" variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={restart}>
              {t("restart")}
            </Button>
          </div>
        )}
      </div>

      <div className="glass bg-card absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-1 rounded-xl border p-1 shadow-md">
        <Button type="button" variant="ghost" size="sm" onClick={close} disabled={busy !== null} data-sketch-close>
          <X className="h-4 w-4" />
          {t("close")}
        </Button>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={() => void download()}
          disabled={busy !== null}
          data-sketch-download
        >
          {busy === "download" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
          {t("download")}
        </Button>
        <Button
          type="button"
          size="sm"
          onClick={() => void createIssue()}
          disabled={busy !== null}
          data-sketch-create-topic
        >
          {busy === "issue" ? <Loader2 className="h-4 w-4 animate-spin" /> : <MessageSquarePlus className="h-4 w-4" />}
          {t("createIssue")}
        </Button>
      </div>
    </div>
  );
}
