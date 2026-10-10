"use client";

import { Input } from "../ui/input";
import { FormBase, FormControlProps } from "./FormBase";
import { useFieldContext } from "./hooks";
import Loading from "../Loading";

// The backend stores/enforces these datetimes in UTC (settings TIME_ZONE="UTC",
// deadlines compared against timezone.now()), and the calls list renders them in
// UTC. So this field edits in UTC too — the "YYYY-MM-DDTHH:MM" the datetime-local
// input shows is UTC wall time, not the admin's local time — keeping the editor,
// the list, and the backend consistent.

// ISO string (or Date) -> value for the datetime-local input (UTC wall time).
function toInputValue(value: Date | string | undefined): string {
  if (!value) return "";
  const date = value instanceof Date ? value : new Date(value);
  if (isNaN(date.getTime())) return "";
  // toISOString() is already UTC; keep the "YYYY-MM-DDTHH:MM" part.
  return date.toISOString().slice(0, 16);
}

// datetime-local input value (interpreted as UTC) -> ISO string for the backend.
function toISOStringValue(input: string): string {
  if (!input) return "";
  const date = new Date(`${input}:00Z`); // treat the wall time as UTC
  if (isNaN(date.getTime())) return "";
  return date.toISOString();
}

export function FormInputDateTime(props: FormControlProps) {
  const field = useFieldContext<Date | string>();
  const isInvalid = field.state.meta.isTouched && !field.state.meta.isValid;

  return (
    <FormBase {...props}>
      {props.isLoading ? (
        <Loading className="h-9 w-full" />
      ) : (
        <Input
          type="datetime-local"
          id={field.name}
          name={field.name}
          value={toInputValue(field.state.value)}
          onBlur={field.handleBlur}
          onChange={(e) => field.handleChange(toISOStringValue(e.target.value))}
          aria-invalid={isInvalid}
          disabled={props.readOnly}
        />
      )}
    </FormBase>
  );
}
