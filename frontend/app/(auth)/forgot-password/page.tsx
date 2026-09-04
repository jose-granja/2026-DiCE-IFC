"use client";

import Link from "next/link";
import { useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { FieldGroup } from "@/components/ui/field";
import { useAppForm } from "@/components/form/hooks";
import { FormSchemaProvider } from "@/app/provider";
import { ForgotPasswordSchema } from "@/lib/validators/auth-validators";
import { requestPasswordReset } from "@/lib/actions/auth";

export default function ForgotPasswordPage() {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const t = useTranslations("auth");
  const [sent, setSent] = useState(false);

  const form = useAppForm({
    defaultValues: { email: "" },
    validators: { onSubmit: ForgotPasswordSchema },
    onSubmit: async ({ value }) => {
      setIsSubmitting(true);
      try {
        const result = await requestPasswordReset(value.email);
        if (result.error) {
          toast.error(result.error, { id: "forgot" });
          return;
        }
        setSent(true);
      } catch {
        toast.error(t("sendFailed"), { id: "forgot" });
      } finally {
        setIsSubmitting(false);
      }
    },
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("resetTitle")}</CardTitle>
        <CardDescription>
          {sent
            ? t("resetSent")
            : t("resetDescription")}
        </CardDescription>
      </CardHeader>
      {!sent && (
        <CardContent>
          <FormSchemaProvider schema={ForgotPasswordSchema}>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                form.handleSubmit();
              }}
            >
              <FieldGroup>
                <form.AppField name="email">
                  {(field) => (
                    <field.Input
                      label={t("email")}
                      type="email"
                      placeholder="you@example.com"
                    />
                  )}
                </form.AppField>
                <Button type="submit" disabled={isSubmitting}>
                  {isSubmitting ? t("sending") : t("sendResetLink")}
                </Button>
              </FieldGroup>
            </form>
          </FormSchemaProvider>
        </CardContent>
      )}
      <CardFooter>
        <Button variant="link" asChild className="px-0">
          <Link className="text-muted-foreground" href="/sign-in">
            Back to sign in
          </Link>
        </Button>
      </CardFooter>
    </Card>
  );
}
