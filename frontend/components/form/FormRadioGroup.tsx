import { FormBase, FormControlProps } from "./FormBase";
import { useFieldContext } from "./hooks";
import { FieldLabel, FieldSet } from "../ui/field";
import { RadioGroup, RadioGroupItem } from "../ui/radio-group";
import React from "react";
import { useFormSchema } from "@/app/provider";
import { cn, getEnumValues } from "@/lib/utils";

export function FormRadioGroup(props: FormControlProps & { labelVisible?: boolean }) {
  const field = useFieldContext<string>();
  const fieldSchema = useFormSchema(field.name);
    const isInvalid = field.state.meta.isTouched && !field.state.meta.isValid;
  
    const options = fieldSchema ? getEnumValues(fieldSchema) : [];
  return (
    <FieldSet disabled={props.readOnly}>
      <RadioGroup
        onValueChange={(val) => field.handleChange(val)}
        value={field.state.value}
        aria-invalid={isInvalid}
      >
        <FormBase
          {...props}
          horizontal={true}
        >
          {(options || []).map((option) => (
            <div key={option as string} className="flex flex-col flex-wrap-reverse gap-2 items-center">
              <FieldLabel
                htmlFor={option}
                className={cn("font-normal", props.labelVisible ? "" : "invisible h-0")}
              >
                {option}
              </FieldLabel>
              <RadioGroupItem
                value={option}
                id={option}
                aria-invalid={isInvalid}
              />
            </div>
          ))}
        </FormBase>
      </RadioGroup>
    </FieldSet>
  );
}
