"use client";

import * as React from "react";
import { CalendarIcon } from "lucide-react";
import { Calendar } from "@/components/ui/calendar";
import { InputGroup, InputGroupInput } from "@/components/ui/input-group";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { FormBase, FormControlProps } from "./FormBase";
import { useFieldContext } from "./hooks";
import { useFormSchema } from "@/app/provider";
import { getMaxDate, getMinDate } from "@/lib/utils";
import Loading from "../Loading";
import { Button } from "../ui/button";

function formatDate(date: Date | undefined): string {
  if (!date) return "";
  return date.toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}

function isValidDate(date: Date | undefined): boolean {
  if (!date) return false;
  return !isNaN(date.getTime());
}

export function FormInputDate(props: FormControlProps) {
  const field = useFieldContext<Date | string>();
  const fieldSchema = useFormSchema(field.name);

  const minDate = fieldSchema ? getMinDate(fieldSchema) : undefined;
  const maxDate = fieldSchema ? getMaxDate(fieldSchema) : undefined;

  // Resolve the initial Date from the field value (Date object or ISO string)
  const resolvedInitial: Date | undefined =
    field.state.value instanceof Date
      ? field.state.value
      : field.state.value
        ? new Date(field.state.value as string)
        : undefined;

  const [open, setOpen] = React.useState(false);
  const [date, setDate] = React.useState<Date | undefined>(resolvedInitial);
  const [month, setMonth] = React.useState<Date | undefined>(resolvedInitial);
  const [inputValue, setInputValue] = React.useState(
    formatDate(resolvedInitial),
  );

  // Build disabled matcher for Calendar from schema min/max
  const disabledDates = React.useMemo(() => {
    const matchers: ((d: Date) => boolean)[] = [];
    if (minDate) matchers.push((d) => d < minDate);
    if (maxDate) matchers.push((d) => d > maxDate);
    return matchers.length > 0 ? matchers : undefined;
  }, [minDate, maxDate]);

  // react-day-picker caps the dropdown's navigable range at the current year by
  // default, so future years can't be picked. Widen it to the schema bounds
  // (with generous fallbacks when the field is unbounded).
  const { startMonth, endMonth } = React.useMemo(() => {
    const currentYear = new Date().getFullYear();
    return {
      startMonth: minDate ?? new Date(currentYear - 100, 0, 1),
      endMonth: maxDate ?? new Date(currentYear + 100, 11, 31),
    };
  }, [minDate, maxDate]);

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const raw = e.target.value;
    setInputValue(raw);
    const parsed = new Date(raw);
    if (isValidDate(parsed)) {
      setDate(parsed);
      setMonth(parsed);
      field.handleChange(parsed); // sync to TanStack form
    }
  };

  const handleCalendarSelect = (selected: Date | undefined) => {
    setDate(selected);
    setInputValue(formatDate(selected));
    setOpen(false);
    if (selected) {
      field.handleChange(selected); // sync to TanStack form
    }
  };

  return (
    <FormBase {...props}>
      {props.isLoading ? (
        <Loading className="h-[36px] w-full" />
      ) : (
        <InputGroup>
          <InputGroupInput
            id={field.name}
            name={field.name}
            value={inputValue}
            placeholder="June 01, 2025"
            onBlur={field.handleBlur}
            aria-invalid={
              field.state.meta.isTouched && !field.state.meta.isValid
            }
            disabled={props.readOnly}
            onChange={handleInputChange}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setOpen(true);
              }
            }}
          />
          <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger asChild>
              <Button
                id={`${field.name}-picker`}
                variant="ghost"
                size="icon-xs"
                aria-label="Select date"
                disabled={props.readOnly}
              >
                <CalendarIcon />
                <span className="sr-only">
                  {date ? formatDate(date) : "Select date"}
                </span>
              </Button>
            </PopoverTrigger>
            <PopoverContent
              className="w-auto overflow-hidden p-0"
              align="end"
              alignOffset={-8}
              sideOffset={10}
            >
              <Calendar
                mode="single"
                selected={date}
                month={month}
                onMonthChange={setMonth}
                onSelect={handleCalendarSelect}
                disabled={disabledDates}
                startMonth={startMonth}
                endMonth={endMonth}
                captionLayout="dropdown"
              />
            </PopoverContent>
          </Popover>
        </InputGroup>
      )}
    </FormBase>
  );
}
