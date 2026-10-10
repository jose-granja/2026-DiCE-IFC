"use client";

import { Input } from "../ui/input";
import { FormBase, FormControlProps } from "./FormBase";
import { useFieldContext } from "./hooks";
import Loading from "../Loading";

/**
 * A single coordinate value, with its unit shown.
 *
 * Georeferencing goes wrong in units more often than in arithmetic: an easting
 * typed in millimetres into a metre field puts the model a thousand kilometres
 * away, and the number *looks* fine. So the unit is always visible next to the
 * field rather than implied by a column heading.
 *
 * The value is kept as a string while editing and only committed as a number
 * when it parses. Storing `NaN` mid-keystroke — which is what a naive
 * `Number(e.target.value)` does the moment someone types "-" or "1." — makes
 * the field fight the user.
 */
export function FormCoordinateInput(
  props: FormControlProps & {
    /** e.g. "m", "mm", "°". */
    unit?: string;
    step?: number;
    placeholder?: string;
    /** Decimal places to show when the field is not focused. */
    precision?: number;
  },
) {
  const field = useFieldContext<number | null>();
  const isInvalid = field.state.meta.isTouched && !field.state.meta.isValid;

  const value = field.state.value;
  const display = value === null || value === undefined ? "" : String(value);

  return (
    <FormBase {...props}>
      {props.isLoading ? (
        <Loading className="h-[36px] w-full" />
      ) : (
        <div className="relative w-full">
          <Input
            id={field.name}
            name={field.name}
            type="text"
            inputMode="decimal"
            value={display}
            onBlur={field.handleBlur}
            onChange={(event) => {
              const raw = event.target.value.trim();
              if (raw === "" || raw === "-") {
                field.handleChange(null);
                return;
              }
              const parsed = Number(raw);
              // Ignore input that is not yet a number ("1.", "-0.") rather than
              // committing NaN and blanking what the user is typing.
              if (Number.isFinite(parsed)) field.handleChange(parsed);
            }}
            aria-invalid={isInvalid}
            placeholder={props.placeholder}
            disabled={props.readOnly}
            className={props.unit ? "pr-12 font-mono tabular-nums" : "font-mono tabular-nums"}
          />
          {props.unit && (
            <span
              aria-hidden
              className="text-muted-foreground pointer-events-none absolute inset-y-0 right-3 flex items-center text-xs"
            >
              {props.unit}
            </span>
          )}
        </div>
      )}
    </FormBase>
  );
}

export default FormCoordinateInput;
