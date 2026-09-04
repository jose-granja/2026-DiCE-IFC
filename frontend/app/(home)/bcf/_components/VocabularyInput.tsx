"use client";

import { useId } from "react";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/**
 * A field backed by one of the project's vocabularies.
 *
 * An `<input>` with a `<datalist>` rather than a `<Select>`, deliberately. BCF
 * vocabularies are **per project, not fixed by the standard** — a file can
 * legitimately use a status of "Aguarda aprovação" that appears in no list we
 * have. A select would make that value unreachable and, worse, would silently
 * drop it the moment someone edited any other field on the topic. The datalist
 * offers the known values and still accepts anything.
 */
export function VocabularyInput({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string | undefined;
  options: string[];
  onChange: (value: string | undefined) => void;
}) {
  const id = useId();
  const listId = `${id}-options`;

  return (
    <div className="space-y-1.5">
      <Label htmlFor={id} className="text-xs font-medium">
        {label}
      </Label>
      <Input
        id={id}
        list={listId}
        value={value ?? ""}
        onChange={(event) => onChange(event.target.value || undefined)}
        className="h-8 text-xs"
      />
      <datalist id={listId}>
        {options.map((option) => (
          <option key={option} value={option} />
        ))}
      </datalist>
    </div>
  );
}

export default VocabularyInput;
