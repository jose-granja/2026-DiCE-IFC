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

import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type PointerEvent } from "react";
import { useTranslations } from "next-intl";
import {
  Circle,
  Cloud,
  Eraser,
  Loader2,
  Minus,
  MousePointer2,
  MoveUpRight,
  Pencil,
  Redo2,
  Square,
  Trash2,
  Type,
  Undo2,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  ANNOTATION_COLOURS,
  ANNOTATION_STROKES,
  ANNOTATION_TEXT_SIZES,
  annotationBounds,
  drawAnnotations,
  hitTest,
  isDegenerate,
  moveAnnotation,
  type Annotation,
  type AnnotationKind,
  type AnnotationPoint,
} from "@/lib/bcf/annotations";
import { cn } from "@/lib/utils";

type Tool = "select" | AnnotationKind;

const TOOLS: Array<{ tool: Tool; icon: typeof Circle }> = [
  { tool: "select", icon: MousePointer2 },
  { tool: "arrow", icon: MoveUpRight },
  { tool: "line", icon: Minus },
  { tool: "rect", icon: Square },
  { tool: "ellipse", icon: Circle },
  { tool: "cloud", icon: Cloud },
  { tool: "pen", icon: Pencil },
  { tool: "text", icon: Type },
];

let sequence = 0;
const newId = () => `annotation-${Date.now().toString(36)}-${++sequence}`;

type TextEdit = { id: string | null; at: AnnotationPoint; value: string };

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
  const [shapes, setShapes] = useState<Annotation[]>(initial);
  const [past, setPast] = useState<Annotation[][]>([]);
  const [future, setFuture] = useState<Annotation[][]>([]);
  const [tool, setTool] = useState<Tool>("arrow");
  const [colour, setColour] = useState(ANNOTATION_COLOURS[0]);
  const [stroke, setStroke] = useState(ANNOTATION_STROKES[1]);
  const [textSize, setTextSize] = useState(ANNOTATION_TEXT_SIZES[1]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Annotation | null>(null);
  const [textEdit, setTextEdit] = useState<TextEdit | null>(null);
  const [saving, setSaving] = useState(false);
  const [bitmap, setBitmap] = useState<ImageBitmap | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });

  const wrapper = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const drag = useRef<{ id: string; start: AnnotationPoint; original: Annotation; before: Annotation[] } | null>(null);

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

  // Redraw: the image, the shapes, the one being drawn, and the selection.
  useEffect(() => {
    const element = canvas.current;
    if (!element || !bitmap || size.width === 0) return;
    const ratio = window.devicePixelRatio || 1;
    element.width = Math.round(size.width * ratio);
    element.height = Math.round(size.height * ratio);
    const context = element.getContext("2d");
    if (!context) return;
    context.drawImage(bitmap, 0, 0, element.width, element.height);
    const shown = shapes.filter((shape) => shape.id !== textEdit?.id);
    drawAnnotations(context, draft ? [...shown, draft] : shown, element.width, element.height);
    const selected = shapes.find((shape) => shape.id === selectedId);
    if (selected && tool === "select") {
      const box = annotationBounds(selected, element.width, element.height);
      const pad = 6 * ratio;
      context.save();
      context.setLineDash([5 * ratio, 4 * ratio]);
      context.lineWidth = 1.5 * ratio;
      context.strokeStyle = "#0090ff";
      context.strokeRect(box.x - pad, box.y - pad, box.width + pad * 2, box.height + pad * 2);
      context.restore();
    }
  }, [bitmap, size, shapes, draft, selectedId, tool, textEdit]);

  const commit = (next: Annotation[], before: Annotation[] = shapes) => {
    setPast((list) => [...list.slice(-99), before]);
    setFuture([]);
    setShapes(next);
  };
  const undo = () => {
    const previous = past.at(-1);
    if (!previous) return;
    setPast((list) => list.slice(0, -1));
    setFuture((list) => [shapes, ...list]);
    setShapes(previous);
    setSelectedId(null);
  };
  const redo = () => {
    const [next, ...rest] = future;
    if (!next) return;
    setFuture(rest);
    setPast((list) => [...list, shapes]);
    setShapes(next);
    setSelectedId(null);
  };
  const removeSelected = () => {
    if (!selectedId) return;
    commit(shapes.filter((shape) => shape.id !== selectedId));
    setSelectedId(null);
  };

  // A change of colour or width also restyles the selected shape.
  const restyle = (patch: Partial<Pick<Annotation, "colour" | "stroke">> & { size?: number }) => {
    if (tool !== "select" || !selectedId) return;
    commit(
      shapes.map((shape) => {
        if (shape.id !== selectedId) return shape;
        if (shape.kind === "text") {
          return { ...shape, colour: patch.colour ?? shape.colour, size: patch.size ?? shape.size };
        }
        return { ...shape, colour: patch.colour ?? shape.colour, stroke: patch.stroke ?? shape.stroke };
      }),
    );
  };

  const pointOf = (event: PointerEvent<HTMLCanvasElement>): AnnotationPoint => {
    const rect = event.currentTarget.getBoundingClientRect();
    return { x: (event.clientX - rect.left) / rect.width, y: (event.clientY - rect.top) / rect.height };
  };

  // The text being typed, read through a ref: a click elsewhere both blurs the
  // box and lands on the canvas or a button, and the text must go in once.
  const typing = useRef<TextEdit | null>(null);
  const startText = (edit: TextEdit) => {
    typing.current = edit;
    setTextEdit(edit);
  };
  /** Put the typed text in; returns the shapes as they now are. */
  const commitText = (): Annotation[] => {
    const edit = typing.current;
    if (!edit) return shapes;
    typing.current = null;
    setTextEdit(null);
    const value = edit.value.replace(/\s+$/, "");
    let next = shapes;
    if (edit.id) {
      next = value
        ? shapes.map((shape) => (shape.id === edit.id && shape.kind === "text" ? { ...shape, text: value } : shape))
        : shapes.filter((shape) => shape.id !== edit.id);
    } else if (value) {
      next = [...shapes, { id: newId(), kind: "text", colour, stroke, at: edit.at, text: value, size: textSize }];
    }
    if (next !== shapes) commit(next);
    return next;
  };

  const onPointerDown = (event: PointerEvent<HTMLCanvasElement>) => {
    if (event.button !== 0) return;
    if (typing.current) {
      // This click finishes the text being typed; it does not start another.
      commitText();
      swallowClick.current = true;
      return;
    }
    const point = pointOf(event);
    // Text opens on the click, not here: the browser moves focus on mouse-down,
    // after this handler, and would blur a box opened now straight away.
    if (tool === "text") return;
    event.currentTarget.setPointerCapture(event.pointerId);
    if (tool === "select") {
      const hit = hitTest(shapes, { x: point.x * size.width, y: point.y * size.height }, size.width, size.height);
      setSelectedId(hit?.id ?? null);
      drag.current = hit ? { id: hit.id, start: point, original: hit, before: shapes } : null;
      return;
    }
    const style = { id: newId(), colour, stroke };
    setDraft(tool === "pen" ? { ...style, kind: "pen", points: [point] } : { ...style, kind: tool, from: point, to: point });
  };

  const onPointerMove = (event: PointerEvent<HTMLCanvasElement>) => {
    const point = pointOf(event);
    if (drag.current) {
      const { id, start, original } = drag.current;
      const moved = moveAnnotation(original, point.x - start.x, point.y - start.y);
      setShapes((list) => list.map((shape) => (shape.id === id ? moved : shape)));
      return;
    }
    if (!draft) return;
    setDraft(draft.kind === "pen" ? { ...draft, points: [...draft.points, point] } : draft.kind === "text"
      ? draft : { ...draft, to: point });
  };

  const onPointerUp = () => {
    if (drag.current) {
      const { before, id, original } = drag.current;
      drag.current = null;
      const now = shapes.find((shape) => shape.id === id);
      // Only a real move is a step to undo.
      if (now && JSON.stringify(now) !== JSON.stringify(original)) {
        setPast((list) => [...list.slice(-99), before]);
        setFuture([]);
      }
      return;
    }
    if (!draft) return;
    if (!isDegenerate(draft, size.width, size.height)) commit([...shapes, draft]);
    setDraft(null);
  };

  const swallowClick = useRef(false);
  const onClick = (event: MouseEvent<HTMLCanvasElement>) => {
    if (swallowClick.current) {
      swallowClick.current = false;
      return;
    }
    if (tool !== "text") return;
    const rect = event.currentTarget.getBoundingClientRect();
    startText({
      id: null,
      at: { x: (event.clientX - rect.left) / rect.width, y: (event.clientY - rect.top) / rect.height },
      value: "",
    });
  };

  const onDoubleClick = (event: MouseEvent<HTMLCanvasElement>) => {
    if (tool !== "select") return;
    const rect = event.currentTarget.getBoundingClientRect();
    const hit = hitTest(shapes, { x: event.clientX - rect.left, y: event.clientY - rect.top }, size.width, size.height);
    if (hit?.kind === "text") startText({ id: hit.id, at: hit.at, value: hit.text });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (textEdit) return;
    const mod = event.metaKey || event.ctrlKey;
    if (mod && event.key.toLowerCase() === "z") {
      event.preventDefault();
      if (event.shiftKey) redo();
      else undo();
    } else if (mod && event.key.toLowerCase() === "y") {
      event.preventDefault();
      redo();
    } else if ((event.key === "Delete" || event.key === "Backspace") && selectedId) {
      event.preventDefault();
      removeSelected();
    }
  };

  const save = async () => {
    const final = commitText();
    setSaving(true);
    try {
      await onSave(final);
    } finally {
      setSaving(false);
    }
  };

  const editedText = textEdit?.id ? shapes.find((shape) => shape.id === textEdit.id) : null;
  const textFontPx =
    (editedText?.kind === "text" ? editedText.size : textSize) * (size.height / 1000);

  return (
    <div className="flex min-h-0 flex-col gap-3" onKeyDown={onKeyDown} data-annotation-editor>
      <div className="flex flex-wrap items-center gap-1" role="toolbar" aria-label={t("toolbar")}>
        {TOOLS.map(({ tool: value, icon: Icon }) => (
          <Button
            key={value}
            type="button"
            variant={tool === value ? "default" : "outline"}
            size="icon"
            className="h-8 w-8"
            aria-label={t(`tools.${value}`)}
            title={t(`tools.${value}`)}
            aria-pressed={tool === value}
            data-annotation-tool={value}
            onClick={() => {
              commitText();
              setTool(value);
              if (value !== "select") setSelectedId(null);
            }}
          >
            <Icon className="h-4 w-4" />
          </Button>
        ))}
        <span className="bg-border mx-1 h-6 w-px" aria-hidden />
        {ANNOTATION_COLOURS.map((value) => (
          <button
            key={value}
            type="button"
            className={cn(
              "h-6 w-6 rounded-full border-2 transition-transform",
              colour === value ? "border-primary scale-110" : "border-border",
            )}
            style={{ backgroundColor: value }}
            aria-label={t("colour", { colour: value })}
            aria-pressed={colour === value}
            onClick={() => {
              setColour(value);
              restyle({ colour: value });
            }}
          />
        ))}
        <span className="bg-border mx-1 h-6 w-px" aria-hidden />
        {tool === "text" || (tool === "select" && shapes.find((s) => s.id === selectedId)?.kind === "text")
          ? ANNOTATION_TEXT_SIZES.map((value, index) => (
              <Button
                key={value}
                type="button"
                variant={textSize === value ? "secondary" : "ghost"}
                size="sm"
                className="h-8 px-2 text-xs"
                aria-pressed={textSize === value}
                onClick={() => {
                  setTextSize(value);
                  restyle({ size: value });
                }}
              >
                {t(`textSizes.${index}`)}
              </Button>
            ))
          : ANNOTATION_STROKES.map((value, index) => (
              <Button
                key={value}
                type="button"
                variant={stroke === value ? "secondary" : "ghost"}
                size="sm"
                className="h-8 w-9 px-0"
                aria-label={t(`strokes.${index}`)}
                title={t(`strokes.${index}`)}
                aria-pressed={stroke === value}
                onClick={() => {
                  setStroke(value);
                  restyle({ stroke: value });
                }}
              >
                <span className="bg-foreground block w-5 rounded-full" style={{ height: 1 + index * 2 }} />
              </Button>
            ))}
        <span className="bg-border mx-1 h-6 w-px" aria-hidden />
        <Button type="button" variant="ghost" size="icon" className="h-8 w-8" onClick={undo} disabled={past.length === 0}
          aria-label={t("undo")} title={t("undo")}>
          <Undo2 className="h-4 w-4" />
        </Button>
        <Button type="button" variant="ghost" size="icon" className="h-8 w-8" onClick={redo}
          disabled={future.length === 0} aria-label={t("redo")} title={t("redo")}>
          <Redo2 className="h-4 w-4" />
        </Button>
        <Button type="button" variant="ghost" size="icon" className="h-8 w-8" onClick={removeSelected}
          disabled={!selectedId || tool !== "select"} aria-label={t("deleteSelected")} title={t("deleteSelected")}>
          <Trash2 className="h-4 w-4" />
        </Button>
        <Button type="button" variant="ghost" size="icon" className="h-8 w-8"
          onClick={() => {
            commit([]);
            setSelectedId(null);
          }}
          disabled={shapes.length === 0} aria-label={t("clear")} title={t("clear")}>
          <Eraser className="h-4 w-4" />
        </Button>
      </div>

      <div ref={wrapper} className="flex min-h-0 w-full justify-center">
        <div className="relative" style={{ width: size.width, height: size.height }}>
          {!bitmap && <Loader2 className="text-muted-foreground m-8 h-5 w-5 animate-spin" />}
          <canvas
            ref={canvas}
            className={cn("block touch-none rounded-md border", tool === "select" ? "cursor-default" : "cursor-crosshair")}
            style={{ width: size.width, height: size.height }}
            aria-label={t("canvas")}
            data-annotation-canvas
            data-annotation-count={shapes.length}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            onClick={onClick}
            onDoubleClick={onDoubleClick}
          />
          {textEdit && (
            <textarea
              autoFocus
              value={textEdit.value}
              aria-label={t("textInput")}
              placeholder={t("textPlaceholder")}
              rows={Math.max(1, textEdit.value.split("\n").length)}
              className="bg-background/80 absolute resize-none rounded-sm border border-dashed p-0 leading-[1.2] font-semibold outline-none"
              style={{
                left: textEdit.at.x * size.width,
                top: textEdit.at.y * size.height,
                fontSize: Math.max(10, textFontPx),
                color: editedText?.colour ?? colour,
                minWidth: "8rem",
              }}
              onChange={(event) => startText({ ...textEdit, value: event.target.value })}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  commitText();
                } else if (event.key === "Escape") {
                  // Leave the text, not the whole editor.
                  event.preventDefault();
                  event.stopPropagation();
                  typing.current = null;
                  setTextEdit(null);
                }
              }}
              onBlur={commitText}
            />
          )}
        </div>
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
