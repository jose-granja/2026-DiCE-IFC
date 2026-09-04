"use client";

import { getMaxLength, getMinLength } from "@/lib/utils";
import { Input } from "../ui/input";
import { FormBase, FormControlProps } from "./FormBase";
import { useFieldContext } from "./hooks";
import { useFormSchema } from "@/app/provider";
import Loading from "../Loading";

export function FormInput(
  props: FormControlProps & {
    pattern?: string;
    type?: React.HTMLInputTypeAttribute;
    placeholder?: string;
  },
) {
  const field = useFieldContext<string>();
  const fieldSchema = useFormSchema(field.name);
  const isInvalid = field.state.meta.isTouched && !field.state.meta.isValid;

  const minLength = fieldSchema ? getMinLength(fieldSchema) : undefined;
  const maxLength = fieldSchema ? getMaxLength(fieldSchema) : undefined;

  return (
    <FormBase {...props}>
      {props.isLoading ? (
        <Loading className="h-[36px] w-full" />
      ) : (
        <Input
          type={props.type || "text"}
          id={field.name}
          name={field.name}
          value={field.state.value ?? ""}
          onBlur={field.handleBlur}
          onChange={(e) => field.handleChange(e.target.value)}
          aria-invalid={isInvalid}
          placeholder={props.placeholder}
          minLength={minLength}
          maxLength={maxLength}
          pattern={props.pattern}
          disabled={props.readOnly}
        />
      )}
    </FormBase>
  );
}
