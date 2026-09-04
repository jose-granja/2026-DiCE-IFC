"use client";

import { getMax, getMin, getStep } from "@/lib/utils";
import { Input } from "../ui/input";
import { FormBase, FormControlProps } from "./FormBase";
import { useFieldContext } from "./hooks";
import { useFormSchema } from "@/app/provider";
import Loading from "../Loading";


export function FormInputNumber(
  props: FormControlProps & {
    placeholder?: string;
  }
) {
  const field = useFieldContext<number>();
  const fieldSchema = useFormSchema(field.name);
  const isInvalid = field.state.meta.isTouched && !field.state.meta.isValid;

  const min = fieldSchema ? getMin(fieldSchema) : undefined;
  const max = fieldSchema ? getMax(fieldSchema) : undefined;
  const step = fieldSchema ? getStep(fieldSchema) : undefined;
  
  return (
    <FormBase {...props}>
      {props.isLoading ? (
        <Loading className="w-full" />
      ) : (
      <Input
        type={"number"}
        id={field.name}
        name={field.name}
        value={field.state.value ?? ""}
        onBlur={field.handleBlur}
        onChange={(e) => field.handleChange(e.target.valueAsNumber)}
        aria-invalid={isInvalid}
        placeholder={props.placeholder}
        max={max}
        min={min}
        step={step}
        disabled={props.readOnly}
      />
      )}
    </FormBase>
  );
}
