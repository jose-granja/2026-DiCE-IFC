"use client";

/**
 * Draw on a viewpoint's snapshot: arrows, lines, boxes, ellipses, revision
 * clouds, freehand and text, as a coordinator marks up a screenshot.
 *
 * The editor works on the clean image and a list of shapes; saving hands the
 * shapes back, and the caller bakes them into the snapshot
 * (`composeAnnotatedSnapshot`), which also keeps them for the next edit. The
 * preview is drawn by the same `drawAnnotations` as the saved image, so what
 * is on screen is what goes in the file.
 */

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { AnnotationSurface, AnnotationToolbar, useAnnotationEditor } from "@/components/annotations/AnnotationEditing";
import type { Annotation } from "@/lib/bcf/annotations";

export function AnnotationEditor({
  open,
  onOpenChange,
  base,
  initial,
  onSave,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The snapshot without annotations. */
  base: Uint8Array | null;
  initial: Annotation[];
  onSave: (shapes: Annotation[]) => Promise<void>;
}) {
  const t = useTranslations("bcf.annotations");
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[calc(100vh-2rem)] flex-col gap-3 p-4 sm:max-w-5xl">
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("hint")}</DialogDescription>
        </DialogHeader>
        {open && base && (
          <Editor base={base} initial={initial} onSave={onSave} onCancel={() => onOpenChange(false)} />
        )}
      </DialogContent>
    </Dialog>
  );
}

function Editor({
  base,
  initial,
  onSave,
  onCancel,
}: {
  base: Uint8Array;
  initial: Annotation[];
  onSave: (shapes: Annotation[]) => Promise<void>;
  onCancel: () => void;
}) {
  const t = useTranslations("bcf.annotations");
  const editor = useAnnotationEditor(initial);
  const [saving, setSaving] = useState(false);
  const [bitmap, setBitmap] = useState<ImageBitmap | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });

  const wrapper = useRef<HTMLDivElement>(null);

  // The clean snapshot, decoded once. A bitmap is a resource with a lifetime,
  // so it is created and released in one effect (see use-snapshot-url.ts).
  useEffect(() => {
    let alive = true;
    let created: ImageBitmap | null = null;
    void createImageBitmap(new Blob([base as BlobPart], { type: "image/png" })).then((decoded) => {
      if (!alive) {
        decoded.close();
        return;
      }
      created = decoded;
      setBitmap(decoded);
    });
    return () => {
      alive = false;
      created?.close();
    };
  }, [base]);

  // As large as the dialog allows, at the snapshot's own proportions.
  useEffect(() => {
    const element = wrapper.current;
    if (!element || !bitmap) return;
    const fit = () => {
      const maxWidth = element.clientWidth;
      const maxHeight = Math.max(200, window.innerHeight * 0.62);
      const aspect = bitmap.width / bitmap.height;
      const width = Math.min(maxWidth, maxHeight * aspect);
      setSize({ width: Math.floor(width), height: Math.floor(width / aspect) });
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(element);
    return () => observer.disconnect();
  }, [bitmap]);

  const save = async () => {
    const final = editor.commitText();
    setSaving(true);
    try {
      await onSave(final);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex min-h-0 flex-col gap-3" onKeyDown={editor.handleKey} data-annotation-editor>
      <AnnotationToolbar editor={editor} />

      <div ref={wrapper} className="flex min-h-0 w-full justify-center">
        {bitmap ? (
          <AnnotationSurface
            editor={editor}
            width={size.width}
            height={size.height}
            background={bitmap}
            label={t("canvas")}
            canvasClassName="rounded-md border"
          />
        ) : (
          <Loader2 className="text-muted-foreground m-8 h-5 w-5 animate-spin" />
        )}
      </div>

      <div className="flex items-center justify-between gap-2">
        <p className="text-muted-foreground text-xs">{t("shortcuts")}</p>
        <div className="flex gap-2">
          <Button type="button" variant="outline" onClick={onCancel} disabled={saving}>
            {t("cancel")}
          </Button>
          <Button
            type="button"
            onClick={() => void save()}
            disabled={saving}
            data-annotation-save
          >
            {saving && <Loader2 className="h-4 w-4 animate-spin" />}
            {t("save")}
          </Button>
        </div>
      </div>
    </div>
  );
}
