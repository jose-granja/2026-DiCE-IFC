"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Input } from "../ui/input";
import { FormBase, FormControlProps } from "./FormBase";
import { useFieldContext } from "./hooks";
import { Eye, EyeOff } from "lucide-react";
import { Button } from "../ui/button";
import { cn } from "@/lib/utils";
import Loading from "../Loading";

export function FormInputPassword(
  props: FormControlProps & {
    minLength?: number;
    maxLength?: number;
    max?: number;
    min?: number;
    step?: number;
    pattern?: string;
    type?: React.HTMLInputTypeAttribute;
    placeholder?: string;
  }
) {
  const [showPassword, setShowPassword] = useState<boolean>(false);
  const t = useTranslations("formInputPassword");
  const field = useFieldContext<string>();
  const isInvalid = field.state.meta.isTouched && !field.state.meta.isValid;
  return (
    <FormBase {...props}>
      {props.isLoading ? (
        <Loading className="w-full" />
      ) : (
      <div className="relative group">
        <Input
          type={showPassword ? "text" : "password"}
          id={field.name}
          name={field.name}
          value={field.state.value}
          onBlur={field.handleBlur}
          onChange={(e) => field.handleChange(e.target.value)}
          aria-invalid={isInvalid}
          placeholder={props.placeholder}
          minLength={props.minLength}
          maxLength={props.maxLength}
          max={props.max}
          min={props.min}
          step={props.step}
          pattern={props.pattern}
        />
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={() => setShowPassword((prev) => !prev)}
          className={cn(
            "text-muted-foreground absolute right-2 top-1/2 -translate-y-1/2 flex h-8 w-8 p-0 opacity-70 transition-opacity hover:opacity-100 focus-visible:opacity-100"
          )}
          aria-label={showPassword ? t("hidePassword") : t("showPassword")}
        >
          {showPassword ? (
            <Eye className="h-4 w-4" />
          ) : (
            <EyeOff className="h-4 w-4" />
          )}
        </Button>
      </div>
    )}
    </FormBase>
  );
}
