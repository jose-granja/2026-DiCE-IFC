import { useFormSchema } from "@/app/provider";
import { Textarea } from "../ui/textarea";
import { FormBase, FormControlProps } from "./FormBase";
import { useFieldContext } from "./hooks";
import { getMaxLength, getMinLength } from "@/lib/utils";
import Loading from "../Loading";

export function FormTextarea(
  props: FormControlProps & { placeholder?: string; rows?: number },
) {
  const field = useFieldContext<string>();
  const fieldSchema = useFormSchema(field.name);
  const isInvalid = field.state.meta.isTouched && !field.state.meta.isValid;

  const minLength = fieldSchema ? getMinLength(fieldSchema) : undefined;
  const maxLength = fieldSchema ? getMaxLength(fieldSchema) : undefined;

  return (
    <FormBase {...props}>
      {props.isLoading ? <Loading className="h-[120px] w-full" /> : (
        <Textarea
          id={field.name}
          name={field.name}
          value={field.state.value ?? ""}
          onBlur={field.handleBlur}
          onChange={(e) => field.handleChange(e.target.value)}
          aria-invalid={isInvalid}
          maxLength={maxLength}
          minLength={minLength}
          placeholder={props.placeholder}
          rows={props.rows}
          disabled={props.readOnly}
        />
      )}
      <div className="text-right text-[8pt] text-muted-foreground mt-1">
        {field.state.value ? field.state.value.length : 0}
        {maxLength ? ` / ${maxLength}` : ""} characters
      </div>
    </FormBase>
  );
}
