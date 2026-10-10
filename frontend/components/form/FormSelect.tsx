import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { FormBase, FormControlProps } from "./FormBase";
import { useFieldContext } from "./hooks";
import { getEnumValues } from "@/lib/utils";
import { useFormSchema } from "@/app/provider";
import { SelectOption } from "@/types";
import Loading from "../Loading";

export function FormSelect(
  props: FormControlProps & {
    // Explicit labeled options. When omitted, options are derived from the
    // field's zod enum (value === label).
    options?: SelectOption[];
    placeholder?: string;
  },
) {
  const field = useFieldContext<string | null>();
  const fieldSchema = useFormSchema(field.name.split(".").pop() || "");
  const isInvalid = field.state.meta.isTouched && !field.state.meta.isValid;

  const options: { value: string; label: string }[] = props.options
    ? props.options.map((o) => ({ value: String(o.value), label: o.label }))
    : ((fieldSchema ? getEnumValues(fieldSchema) : []) ?? []).map(
        (o: string) => ({ value: o, label: o }),
      );

  // shadcn Select needs a string value; show the placeholder for empty/null.
  const value =
    field.state.value != null && field.state.value !== ""
      ? String(field.state.value)
      : undefined;

  return (
    <FormBase {...props}>
      {props.isLoading ? (
        <Loading className="h-[32px] w-full" />
      ) : (
        <Select
          onValueChange={(e) => field.handleChange(e)}
          value={value}
          disabled={props.readOnly}
        >
          <SelectTrigger
            aria-invalid={isInvalid}
            id={field.name}
            onBlur={field.handleBlur}
            className="w-full"
          >
            <SelectValue placeholder={props.placeholder} />
          </SelectTrigger>
          <SelectContent>
            {options.map((option) => (
              <SelectItem
                key={`${field.name}${option.value}`}
                value={option.value}
              >
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
    </FormBase>
  );
}
