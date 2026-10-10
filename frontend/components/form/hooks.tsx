import { createFormHook, createFormHookContexts } from "@tanstack/react-form";
import { FormInput } from "./FormInput";
import { FormInputPassword } from "./FormInputPassword";
import { FormSelect } from "./FormSelect";
import { FormRadio } from "./FormRadio";
import { FormTextarea } from "./FormTextarea";
import { FormCheckbox } from "./FormCheckbox";
import { FormRadioGroup } from "./FormRadioGroup";
import { FormInputNumber } from "./FormInputNumber";
import { FormInputDate } from "./FormInputDate";
import { FormInputDateTime } from "./FormInputDateTime";
import { FormInputFile } from "./FormInputFile";
import { FormRadioSimpleGroup } from "./FormRadioSimpleGroup";
import { FormRadioBoolean } from "./FormRadioBoolean";
import { FormSelectEPSG } from "./FormSelectEPSG";
import { FormCoordinateInput } from "./FormCoordinateInput";

const { fieldContext, formContext, useFieldContext, useFormContext } =
  createFormHookContexts();

// The registry. Every control added here becomes available as
// `<form.AppField>{(field) => <field.Input ... />}</form.AppField>`.
// App-specific controls get registered here as their phases land: SelectEPSG
// and Coordinate arrived with Phase 4; FormRestriction, FormCardinality,
// FormSelectIfcEntity and FormSelectPropertySet come with Phase 5.
const { useAppForm } = createFormHook({
  fieldComponents: {
    Input: FormInput,
    InputNumber: FormInputNumber,
    InputPassword: FormInputPassword,
    InputDate: FormInputDate,
    InputDateTime: FormInputDateTime,
    InputFile: FormInputFile,
    Select: FormSelect,
    SelectEPSG: FormSelectEPSG,
    Coordinate: FormCoordinateInput,
    Radio: FormRadio,
    RadioSimpleGroup: FormRadioSimpleGroup,
    RadioBoolean: FormRadioBoolean,
    RadioGroup: FormRadioGroup,
    Textarea: FormTextarea,
    Checkbox: FormCheckbox,
  },
  formComponents: {},
  fieldContext,
  formContext,
});

export { useAppForm, useFieldContext, useFormContext };
