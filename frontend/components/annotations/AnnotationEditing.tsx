"use client";

/**
 * Drawing arrows, lines, boxes, ellipses, revision clouds, freehand and text —
 * the editing half of `lib/bcf/annotations.ts`, shared by the two places that
 * draw: the BCF snapshot editor (over a saved image) and the viewer's sketch
 * layer (over the live 3D view).
 *
 * - `useAnnotationEditor` holds the shapes, the undo history, the current tool
 *   and style, the selection and the text being typed.
 * - `AnnotationToolbar` is the row of tools, colours and widths. The eraser is
 *   a tool: it removes the marks it is clicked or dragged over, and nothing
 *   else; "Remove all" is its own button.
 * - `AnnotationSurface` is the canvas that takes the pointer and draws, with
 *   or without an image under the shapes.
 *
 * Shapes are fractions of the surface and widths per 1000 px of its height
 * (see annotations.ts), so what is drawn here at screen size lands in the same
 * place on an image of any other size. The surface draws with the same
 * `drawAnnotations` that bakes them into a PNG, so the preview is the result.
 */

import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
} from "react";
import { useTranslations } from "next-intl";
import {
  BrushCleaning,
  Circle,
  Cloud,
  Eraser,
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

export type AnnotationTool = "select" | "erase" | AnnotationKind;

const TOOLS: Array<{ tool: AnnotationTool; icon: typeof Circle }> = [
  { tool: "select", icon: MousePointer2 },
  { tool: "erase", icon: Eraser },
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

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export function useAnnotationEditor(initial: Annotation[] = [], initialTool: AnnotationTool = "arrow") {
  const [shapes, setShapes] = useState<Annotation[]>(initial);
  const [past, setPast] = useState<Annotation[][]>([]);
  const [future, setFuture] = useState<Annotation[][]>([]);
  const [tool, setTool] = useState<AnnotationTool>(initialTool);
  const [colour, setColour] = useState(ANNOTATION_COLOURS[0]);
  const [stroke, setStroke] = useState(ANNOTATION_STROKES[1]);
  const [textSize, setTextSize] = useState(ANNOTATION_TEXT_SIZES[1]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Annotation | null>(null);
  const [textEdit, setTextEdit] = useState<TextEdit | null>(null);

  /** A step that can be undone: `before` is what undo goes back to. */
  const recordStep = (before: Annotation[]) => {
    setPast((list) => [...list.slice(-99), before]);
    setFuture([]);
  };
  const commit = (next: Annotation[], before: Annotation[] = shapes) => {
    recordStep(before);
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
  const clear = () => {
    if (shapes.length === 0) return;
    commit([]);
    setSelectedId(null);
  };
  /** Start again from `next`, with no history — a discarded sketch brought back. */
  const reset = (next: Annotation[]) => {
    typing.current = null;
    setTextEdit(null);
    setDraft(null);
    setSelectedId(null);
    setPast([]);
    setFuture([]);
    setShapes(next);
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

  // The text being typed, read through a ref: a click elsewhere both blurs the
  // box and lands on the canvas or a button, and the text must go in once.
  const typing = useRef<TextEdit | null>(null);
  const startText = (edit: TextEdit) => {
    typing.current = edit;
    setTextEdit(edit);
  };
  const cancelText = () => {
    typing.current = null;
    setTextEdit(null);
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

  const chooseTool = (value: AnnotationTool) => {
    commitText();
    setTool(value);
    if (value !== "select") setSelectedId(null);
  };

  /** Ctrl+Z, Ctrl+Shift+Z / Ctrl+Y and Delete. Returns whether it handled the key. */
  const handleKey = (event: KeyboardEvent<HTMLElement> | globalThis.KeyboardEvent): boolean => {
    if (typing.current) return false;
    const mod = event.metaKey || event.ctrlKey;
    if (mod && event.key.toLowerCase() === "z") {
      event.preventDefault();
      if (event.shiftKey) redo();
      else undo();
      return true;
    }
    if (mod && event.key.toLowerCase() === "y") {
      event.preventDefault();
      redo();
      return true;
    }
    if ((event.key === "Delete" || event.key === "Backspace") && selectedId) {
      event.preventDefault();
      removeSelected();
      return true;
    }
    return false;
  };

  return {
    shapes,
    setShapes,
    canUndo: past.length > 0,
    canRedo: future.length > 0,
    tool,
    colour,
    setColour,
    stroke,
    setStroke,
    textSize,
    setTextSize,
    selectedId,
    setSelectedId,
    draft,
    setDraft,
    textEdit,
    typing,
    recordStep,
    commit,
    undo,
    redo,
    removeSelected,
    clear,
    reset,
    restyle,
    startText,
    cancelText,
    commitText,
    chooseTool,
    handleKey,
    newId,
  };
}

export type AnnotationEditorState = ReturnType<typeof useAnnotationEditor>;

// ---------------------------------------------------------------------------
// Toolbar
// ---------------------------------------------------------------------------

export function AnnotationToolbar({
  editor,
  className,
  children,
}: {
  editor: AnnotationEditorState;
  className?: string;
  /** Extra controls at the end of the row. */
  children?: ReactNode;
}) {
  const t = useTranslations("bcf.annotations");
  const { tool, colour, stroke, textSize, shapes, selectedId } = editor;
  const textStyle = tool === "text" || (tool === "select" && shapes.find((s) => s.id === selectedId)?.kind === "text");

  return (
    <div className={cn("flex flex-wrap items-center gap-1", className)} role="toolbar" aria-label={t("toolbar")}>
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
          onClick={() => editor.chooseTool(value)}
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
          // Data, not theme: the colour drawn into the image.
          style={{ backgroundColor: value }}
          aria-label={t("colour", { colour: value })}
          aria-pressed={colour === value}
          onClick={() => {
            editor.setColour(value);
            editor.restyle({ colour: value });
          }}
        />
      ))}
      <span className="bg-border mx-1 h-6 w-px" aria-hidden />
      {textStyle
        ? ANNOTATION_TEXT_SIZES.map((value, index) => (
            <Button
              key={value}
              type="button"
              variant={textSize === value ? "secondary" : "ghost"}
              size="sm"
              className="h-8 px-2 text-xs"
              aria-pressed={textSize === value}
              onClick={() => {
                editor.setTextSize(value);
                editor.restyle({ size: value });
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
                editor.setStroke(value);
                editor.restyle({ stroke: value });
              }}
            >
              <span className="bg-foreground block w-5 rounded-full" style={{ height: 1 + index * 2 }} />
            </Button>
          ))}
      <span className="bg-border mx-1 h-6 w-px" aria-hidden />
      <Button type="button" variant="ghost" size="icon" className="h-8 w-8" onClick={editor.undo}
        disabled={!editor.canUndo} aria-label={t("undo")} title={t("undo")}>
        <Undo2 className="h-4 w-4" />
      </Button>
      <Button type="button" variant="ghost" size="icon" className="h-8 w-8" onClick={editor.redo}
        disabled={!editor.canRedo} aria-label={t("redo")} title={t("redo")}>
        <Redo2 className="h-4 w-4" />
      </Button>
      <Button type="button" variant="ghost" size="icon" className="h-8 w-8" onClick={editor.removeSelected}
        disabled={!selectedId || tool !== "select"} aria-label={t("deleteSelected")} title={t("deleteSelected")}>
        <Trash2 className="h-4 w-4" />
      </Button>
      <Button type="button" variant="ghost" size="icon" className="h-8 w-8" onClick={editor.clear}
        disabled={shapes.length === 0} aria-label={t("clear")} title={t("clear")}>
        <BrushCleaning className="h-4 w-4" />
      </Button>
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Surface
// ---------------------------------------------------------------------------

export function AnnotationSurface({
  editor,
  width,
  height,
  background,
  label,
  className,
  canvasClassName,
}: {
  editor: AnnotationEditorState;
  /** CSS px. */
  width: number;
  height: number;
  /** Drawn under the shapes; without one the surface is transparent. */
  background?: CanvasImageSource | null;
  /** The canvas's accessible name. */
  label: string;
  className?: string;
  canvasClassName?: string;
}) {
  const t = useTranslations("bcf.annotations");
  const { shapes, draft, selectedId, tool, textEdit, colour, stroke, textSize } = editor;
  const canvas = useRef<HTMLCanvasElement>(null);
  const drag = useRef<{ id: string; start: AnnotationPoint; original: Annotation; before: Annotation[] } | null>(null);
  const swallowClick = useRef(false);
  /** An eraser stroke: the shapes before it, for one undo step. */
  const erasing = useRef<Annotation[] | null>(null);
  /** The mark the eraser would remove, outlined so it is clear before the click. */
  const [hoverId, setHoverId] = useState<string | null>(null);

  // Redraw: the image, the shapes, the one being drawn, and the selection.
  useEffect(() => {
    const element = canvas.current;
    if (!element || width === 0 || height === 0) return;
    const ratio = window.devicePixelRatio || 1;
    element.width = Math.round(width * ratio);
    element.height = Math.round(height * ratio);
    const context = element.getContext("2d");
    if (!context) return;
    context.clearRect(0, 0, element.width, element.height);
    if (background) context.drawImage(background, 0, 0, element.width, element.height);
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
    const doomed = tool === "erase" ? shapes.find((shape) => shape.id === hoverId) : undefined;
    if (doomed) {
      const box = annotationBounds(doomed, element.width, element.height);
      const pad = 6 * ratio;
      context.save();
      context.setLineDash([5 * ratio, 4 * ratio]);
      context.lineWidth = 1.5 * ratio;
      context.strokeStyle = "#e5484d";
      context.strokeRect(box.x - pad, box.y - pad, box.width + pad * 2, box.height + pad * 2);
      context.restore();
    }
  }, [background, width, height, shapes, draft, selectedId, tool, textEdit, hoverId]);

  const hitAt = (list: Annotation[], point: AnnotationPoint) =>
    hitTest(list, { x: point.x * width, y: point.y * height }, width, height);

  /** Remove the mark under `point`, if any. */
  const eraseAt = (point: AnnotationPoint) => {
    editor.setShapes((list) => {
      const hit = hitAt(list, point);
      return hit ? list.filter((shape) => shape.id !== hit.id) : list;
    });
  };

  const pointOf = (event: PointerEvent<HTMLCanvasElement> | MouseEvent<HTMLCanvasElement>): AnnotationPoint => {
    const rect = event.currentTarget.getBoundingClientRect();
    return { x: (event.clientX - rect.left) / rect.width, y: (event.clientY - rect.top) / rect.height };
  };

  const onPointerDown = (event: PointerEvent<HTMLCanvasElement>) => {
    if (event.button !== 0) return;
    if (editor.typing.current) {
      // This click finishes the text being typed; it does not start another.
      editor.commitText();
      swallowClick.current = true;
      return;
    }
    const point = pointOf(event);
    // Text opens on the click, not here: the browser moves focus on mouse-down,
    // after this handler, and would blur a box opened now straight away.
    if (tool === "text") return;
    event.currentTarget.setPointerCapture(event.pointerId);
    if (tool === "erase") {
      erasing.current = shapes;
      eraseAt(point);
      setHoverId(null);
      return;
    }
    if (tool === "select") {
      const hit = hitTest(shapes, { x: point.x * width, y: point.y * height }, width, height);
      editor.setSelectedId(hit?.id ?? null);
      drag.current = hit ? { id: hit.id, start: point, original: hit, before: shapes } : null;
      return;
    }
    const style = { id: editor.newId(), colour, stroke };
    editor.setDraft(tool === "pen" ? { ...style, kind: "pen", points: [point] } : { ...style, kind: tool, from: point, to: point });
  };

  const onPointerMove = (event: PointerEvent<HTMLCanvasElement>) => {
    const point = pointOf(event);
    if (tool === "erase") {
      if (erasing.current) eraseAt(point);
      else setHoverId(hitAt(shapes, point)?.id ?? null);
      return;
    }
    if (drag.current) {
      const { id, start, original } = drag.current;
      const moved = moveAnnotation(original, point.x - start.x, point.y - start.y);
      editor.setShapes((list) => list.map((shape) => (shape.id === id ? moved : shape)));
      return;
    }
    if (!draft) return;
    editor.setDraft(draft.kind === "pen" ? { ...draft, points: [...draft.points, point] } : draft.kind === "text"
      ? draft : { ...draft, to: point });
  };

  const onPointerUp = () => {
    if (erasing.current) {
      const before = erasing.current;
      erasing.current = null;
      // One undo step for the whole stroke, and none for a click on nothing.
      if (shapes.length !== before.length) editor.recordStep(before);
      return;
    }
    if (drag.current) {
      const { before, id, original } = drag.current;
      drag.current = null;
      const now = shapes.find((shape) => shape.id === id);
      // Only a real move is a step to undo.
      if (now && JSON.stringify(now) !== JSON.stringify(original)) editor.recordStep(before);
      return;
    }
    if (!draft) return;
    if (!isDegenerate(draft, width, height)) editor.commit([...shapes, draft]);
    editor.setDraft(null);
  };

  const onClick = (event: MouseEvent<HTMLCanvasElement>) => {
    if (swallowClick.current) {
      swallowClick.current = false;
      return;
    }
    if (tool !== "text") return;
    editor.startText({ id: null, at: pointOf(event), value: "" });
  };

  const onDoubleClick = (event: MouseEvent<HTMLCanvasElement>) => {
    if (tool !== "select") return;
    const rect = event.currentTarget.getBoundingClientRect();
    const hit = hitTest(shapes, { x: event.clientX - rect.left, y: event.clientY - rect.top }, width, height);
    if (hit?.kind === "text") editor.startText({ id: hit.id, at: hit.at, value: hit.text });
  };

  const editedText = textEdit?.id ? shapes.find((shape) => shape.id === textEdit.id) : null;
  const textFontPx = (editedText?.kind === "text" ? editedText.size : textSize) * (height / 1000);

  return (
    <div className={cn("relative", className)} style={{ width, height }}>
      <canvas
        ref={canvas}
        className={cn("block touch-none", tool === "select" ? "cursor-default" : "cursor-crosshair", canvasClassName)}
        style={{ width, height }}
        aria-label={label}
        data-annotation-canvas
        data-annotation-count={shapes.length}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onPointerLeave={() => setHoverId(null)}
        onClick={onClick}
        onDoubleClick={onDoubleClick}
        onContextMenu={(event) => event.preventDefault()}
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
            left: textEdit.at.x * width,
            top: textEdit.at.y * height,
            fontSize: Math.max(10, textFontPx),
            color: editedText?.colour ?? colour,
            minWidth: "8rem",
          }}
          onChange={(event) => editor.startText({ ...textEdit, value: event.target.value })}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              editor.commitText();
            } else if (event.key === "Escape") {
              // Leave the text, not the whole editor.
              event.preventDefault();
              event.stopPropagation();
              editor.cancelText();
            }
          }}
          onBlur={editor.commitText}
        />
      )}
    </div>
  );
}
