"use client";

import Link from "next/link";
import { useState } from "react";
import { useRouter } from "next/navigation";
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
import { SignUpSchema } from "@/lib/validators/auth-validators";
import { signUp } from "@/lib/actions/auth";

export default function SignUpPage() {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const t = useTranslations("auth");
  const router = useRouter();

  const form = useAppForm({
    defaultValues: {
      first_name: "",
      last_name: "",
      email: "",
      password: "",
      re_password: "",
    },
    validators: { onSubmit: SignUpSchema },
    onSubmit: async ({ value }) => {
      setIsSubmitting(true);
      toast.loading(t("creatingAccount"), { id: "sign-up" });
      try {
        const result = await signUp(value);
        if (result.error) {
          toast.error(result.error, { id: "sign-up" });
          return;
        }
        toast.success(t("accountCreated"), {
          id: "sign-up",
        });
        router.push("/sign-in");
      } catch {
        toast.error(t("createFailed"), {
          id: "sign-up",
        });
      } finally {
        setIsSubmitting(false);
      }
    },
    onSubmitInvalid: () => {
      toast.error(t("fixErrors"), { id: "sign-up" });
    },
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("signUpTitle")}</CardTitle>
        <CardDescription>
          We store your name and email. We never store your models, issues or
          specifications.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <FormSchemaProvider schema={SignUpSchema}>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              form.handleSubmit();
            }}
          >
            <FieldGroup>
              <div className="grid gap-4 sm:grid-cols-2">
                <form.AppField name="first_name">
                  {(field) => <field.Input label={t("firstName")} />}
                </form.AppField>
                <form.AppField name="last_name">
                  {(field) => <field.Input label={t("lastName")} />}
                </form.AppField>
              </div>
              <form.AppField name="email">
                {(field) => (
                  <field.Input
                    label={t("email")}
                    type="email"
                    placeholder="you@example.com"
                  />
                )}
              </form.AppField>
              <form.AppField name="password">
                {(field) => (
                  <field.InputPassword
                    label={t("password")}
                    description={t("passwordHint")}
                  />
                )}
              </form.AppField>
              <form.AppField name="re_password">
                {(field) => <field.InputPassword label={t("confirmPassword")} />}
              </form.AppField>
              <Button type="submit" disabled={isSubmitting}>
                {isSubmitting ? t("creating") : t("createAccount")}
              </Button>
            </FieldGroup>
          </form>
        </FormSchemaProvider>
      </CardContent>
      <CardFooter>
        <Button variant="link" asChild className="px-0">
          <Link className="text-muted-foreground" href="/sign-in">
            Already have an account? Sign in
          </Link>
        </Button>
      </CardFooter>
    </Card>
  );
}
