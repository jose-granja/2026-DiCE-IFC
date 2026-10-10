import { FormBase, FormControlProps } from "./FormBase";
import { useFieldContext } from "./hooks";
import { FieldLabel, FieldSet } from "../ui/field";
import { RadioGroup, RadioGroupItem } from "../ui/radio-group";
import React from "react";
import { useFormSchema } from "@/app/provider";
import { cn, getEnumValues } from "@/lib/utils";
import Loading from "../Loading";
import z from "zod";

export function FormRadioSimpleGroup(
  props: FormControlProps & { labelVisible?: boolean; options?: string[] },
) {
  const field = useFieldContext<string | boolean>();
  const fieldSchema = useFormSchema(field.name.split(".").pop() || "");
  const isInvalid = field.state.meta.isTouched && !field.state.meta.isValid;

  const isBooleanField = fieldSchema instanceof z.ZodBoolean;

  const options = props.options
    ? props.options
    : fieldSchema
      ? isBooleanField
        ? ["Yes", "No"]
        : getEnumValues(fieldSchema)
      : [];

  const displayValue = isBooleanField 
    ? field.state.value === true ? "Yes" : field.state.value === false ? "No" : ""
    : String(field.state.value);

  const handleChange = (val: string) => {
    if (isBooleanField) {
      field.handleChange(val === "Yes" ? true : false);
    } else {
      field.handleChange(val);
    }
  };

  return (
    <FieldSet disabled={props.readOnly}>
      <RadioGroup
        onValueChange={handleChange}
        value={displayValue}
        aria-invalid={isInvalid}
      >
        <FormBase {...props} horizontal={false}>
          {(options || []).map((option) => (
            <div
              key={option as string}
              className="flex flex-row items-center gap-2"
            >
              {props.isLoading ? (
                <Loading className="h-[19.25px] w-full" />
              ) : (
                <>
                  <RadioGroupItem
                    value={option}
                    id={option}
                    aria-invalid={isInvalid}
                  />
                  <FieldLabel
                    htmlFor={option}
                    className={cn(
                      "font-normal",
                      props.labelVisible ? "" : "invisible h-0",
                    )}
                  >
                    {option}
                  </FieldLabel>
                </>
              )}
            </div>
          ))}
        </FormBase>
      </RadioGroup>
    </FieldSet>
  );
}
