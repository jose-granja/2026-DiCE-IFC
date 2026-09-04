import { ReactNode } from "react";
import { useFieldContext } from "./hooks";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldLabel,
} from "../ui/field";
import { useFormSchema } from "@/app/provider";

export type FormControlProps = {
  label: ReactNode;
  description?: ReactNode;
  readOnly?: boolean;
  applicationId?: string;
  section?: string;
  isLoading?: boolean;
  required?: boolean;
};

type FormBaseProps = FormControlProps & {
  children: ReactNode;
  controlFirst?: boolean;
  horizontal?: boolean;
  showLabel?: boolean;
};

export function FormBase({
  children,
  label,
  description,
  controlFirst,
  horizontal,
  required: requiredProp,
  showLabel = true,
}: FormBaseProps) {
  const field = useFieldContext();
  const fieldSchema = useFormSchema(field.name);
  const isInvalid = !field.state.meta.isValid;
  // const isInvalid = field.state.meta.isTouched && !field.state.meta.isValid;

  const requiredFromSchema = fieldSchema?.isOptional() === false;
  const required = requiredProp ?? requiredFromSchema; // <- override if provided

  const labelElement = (
    <>
      <FieldLabel htmlFor={field.name}>
        {label} {required && "*"}
      </FieldLabel>
    </>
  );

  const descriptionElement = (
    <>
      {description && <FieldDescription>{description}</FieldDescription>}
    </>
  )
  const errorElem = isInvalid && (
    <FieldError errors={field.state.meta.errors} />
  );
  return (
    <Field
      data-invalid={isInvalid}
      orientation={horizontal ? "horizontal" : undefined}
      className="items-start"
    >
      {controlFirst ? (
        <>
          {children}
          <FieldContent>
            {showLabel && labelElement}
            {descriptionElement}
            {errorElem}
          </FieldContent>
        </>
      ) : (
        <>
          {showLabel && <FieldContent>{labelElement}</FieldContent>}
          {children}
          {descriptionElement}
          {errorElem}
        </>
      )}
    </Field>
  );
}
