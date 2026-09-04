import { FormBase, FormControlProps } from "./FormBase";
import { useFieldContext } from "./hooks";
import { FieldLabel, FieldSet } from "../ui/field";
import { RadioGroup, RadioGroupItem } from "../ui/radio-group";
import { cn } from "@/lib/utils";
import Loading from "../Loading";

const OPTIONS = ["Yes", "No"];

/**
 * Yes/No radio bound to a boolean field. Unlike FormRadioSimpleGroup it does
 * not depend on a FormSchemaProvider to detect the boolean type, so it works
 * for deeply-nested field paths.
 */
export function FormRadioBoolean(
  props: FormControlProps & { labelVisible?: boolean },
) {
  const field = useFieldContext<boolean | null | undefined>();
  const isInvalid = field.state.meta.isTouched && !field.state.meta.isValid;

  const displayValue =
    field.state.value === true
      ? "Yes"
      : field.state.value === false
        ? "No"
        : "";

  return (
    <FieldSet disabled={props.readOnly}>
      <RadioGroup
        onValueChange={(val) => field.handleChange(val === "Yes")}
        value={displayValue}
        aria-invalid={isInvalid}
      >
        <FormBase {...props} horizontal={false}>
          {OPTIONS.map((option) => (
            <div key={option} className="flex flex-row items-center gap-2">
              {props.isLoading ? (
                <Loading className="h-[19.25px] w-full" />
              ) : (
                <>
                  <RadioGroupItem
                    value={option}
                    id={`${field.name}-${option}`}
                    aria-invalid={isInvalid}
                  />
                  <FieldLabel
                    htmlFor={`${field.name}-${option}`}
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
