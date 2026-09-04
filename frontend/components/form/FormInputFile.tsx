"use client";

import React, { useRef } from "react";
import { cn } from "@/lib/utils";
import { FormBase, FormControlProps } from "./FormBase";
import { useFieldContext } from "./hooks";
import { Label } from "../ui/label";
import { Input } from "../ui/input";
import { FileText, Trash2 } from "lucide-react";
import { Button } from "../ui/button";
import Loading from "../Loading";

/**
 * Local-only file field.
 *
 * The reference project's version uploaded to, downloaded from and deleted on
 * the server. This one deliberately does none of that: the selected `File`
 * objects stay in the field state and are handed to a Web Worker. Nothing here
 * may ever grow a network call — see AGENTS.md §1.
 */
export function FormInputFile(
  props: FormControlProps & {
    /** e.g. ".ifc,.ifczip" — also used for the drop hint. */
    accept?: string;
    multiple?: boolean;
    hint?: React.ReactNode;
  },
) {
  const field = useFieldContext<FileList | null>();
  const inputRef = useRef<HTMLInputElement>(null);

  // Derived, not stored: the FileList *is* the state. Mirroring it into
  // useState would add a render and a way for the two to disagree.
  const value = field.state.value;
  const files = value ? Array.from(value) : [];

  const handleDrop = (e: React.DragEvent<HTMLLabelElement>) => {
    e.preventDefault();
    const dropped = e.dataTransfer.files?.length ? e.dataTransfer.files : null;
    field.handleChange(dropped);
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    field.handleChange(e.target.files ?? null);
  };

  const clear = () => {
    field.setValue(null);
    if (inputRef.current) inputRef.current.value = "";
  };

  const isInvalid = field.state.meta.isTouched && !field.state.meta.isValid;

  return (
    <FormBase {...props}>
      {props.isLoading ? (
        <Loading className="h-[62px] w-full" />
      ) : files.length === 0 ? (
        <Label
          htmlFor={field.name}
          onDrop={handleDrop}
          onDragOver={(e) => e.preventDefault()}
          className={cn(
            "bg-background border-accent hover:bg-accent/40 flex cursor-pointer flex-col items-center justify-center rounded-lg border border-dashed p-6 transition-colors",
            { "border-destructive": isInvalid },
          )}
        >
          <Input
            ref={inputRef}
            id={field.name}
            name={field.name}
            type="file"
            accept={props.accept}
            multiple={props.multiple}
            style={{ display: "none" }}
            onBlur={field.handleBlur}
            onChange={handleChange}
          />
          <div
            className="flex h-20 w-full flex-col items-center justify-center gap-2"
            tabIndex={0}
          >
            <FileText className="text-accent-foreground h-8 w-8" />
            <span className="text-accent-foreground text-sm">
              Drag &amp; drop{props.multiple ? " files" : " a file"}, or{" "}
              <span className="underline">click to select</span>
            </span>
            {props.hint && (
              <span className="text-muted-foreground text-xs">{props.hint}</span>
            )}
          </div>
        </Label>
      ) : (
        <div className="bg-background w-full rounded-lg border">
          <ul className="divide-y">
            {files.map((f) => (
              <li
                key={`${f.name}-${f.size}-${f.lastModified}`}
                className="flex items-center justify-between gap-3 px-4 py-2"
              >
                <div className="flex min-w-0 items-center gap-3">
                  <FileText className="h-5 w-5 shrink-0" />
                  <span className="truncate text-xs">{f.name}</span>
                </div>
                <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
                  {formatBytes(f.size)}
                </span>
              </li>
            ))}
          </ul>
          <div className="flex justify-end border-t px-2 py-1">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={clear}
              aria-label="Remove selected files"
            >
              <Trash2 className="text-destructive h-4 w-4" />
              Clear
            </Button>
          </div>
        </div>
      )}
    </FormBase>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`;
}
