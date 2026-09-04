import { FormBase, FormControlProps } from "./FormBase";
import { useFieldContext } from "./hooks";
import { FieldLabel } from "../ui/field";
import { RadioGroupItem } from "../ui/radio-group";

export function FormRadio(
  props: FormControlProps) {
  const field = useFieldContext<string>();
  const isInvalid = field.state.meta.isTouched && !field.state.meta.isValid;
  return (
    <FormBase {...props} controlFirst={true} horizontal={true}>
        <RadioGroupItem value={field.state.value} id={field.state.value} aria-invalid={isInvalid}/>
        <FieldLabel htmlFor={field.state.value} className="font-normal">
          {props.label}
        </FieldLabel>
      </FormBase>
  );
}
