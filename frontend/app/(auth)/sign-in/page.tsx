"use client";

import Link from "next/link";
import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { ArrowRight } from "lucide-react";

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
import { SignInSchema } from "@/lib/validators/auth-validators";
import { signIn } from "@/lib/actions/auth";

function SignInForm() {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const searchParams = useSearchParams();
  const origin = searchParams.get("origin");
  const t = useTranslations("auth");

  const form = useAppForm({
    defaultValues: { email: "", password: "" },
    validators: { onSubmit: SignInSchema },
    onSubmit: async ({ value }) => {
      setIsSubmitting(true);
      toast.loading(t("signingIn"), { id: "sign-in" });
      try {
        const result = await signIn(value);
        if (result.error) {
          toast.error(result.error, { id: "sign-in" });
          return;
        }
        toast.success(t("signedIn"), { id: "sign-in" });

        // Only internal paths are accepted as a redirect target — a single
        // leading slash — so ?origin=https://evil.com or //evil cannot be used
        // as an open redirect.
        const destination =
          origin && origin.startsWith("/") && !origin.startsWith("//")
            ? origin
            : "/";

        // A hard navigation, not router.push: the auth cookie was just set by
        // the Server Action, and a soft navigation can be served from an RSC
        // prefetch made while still unauthenticated, which bounces back here.
        window.location.assign(destination);
      } catch {
        toast.error(t("signInFailed"), { id: "sign-in" });
      } finally {
        setIsSubmitting(false);
      }
    },
    onSubmitInvalid: () => {
      toast.error(t("fixErrors"), { id: "sign-in" });
    },
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("signInTitle")}</CardTitle>
        <CardDescription>{t("signInDescription")}</CardDescription>
      </CardHeader>
      <CardContent>
        <FormSchemaProvider schema={SignInSchema}>
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
                    placeholder={t("emailPlaceholder")}
                  />
                )}
              </form.AppField>
              <form.AppField name="password">
                {(field) => <field.InputPassword label={t("password")} />}
              </form.AppField>
              <Button type="submit" disabled={isSubmitting}>
                {isSubmitting ? t("signingIn") : t("signInAction")}
              </Button>
            </FieldGroup>
          </form>
        </FormSchemaProvider>
      </CardContent>
      <CardFooter className="flex flex-col items-start gap-1 sm:flex-row sm:justify-between">
        <Button variant="link" asChild className="px-0">
          <Link className="text-muted-foreground gap-1.5" href="/sign-up">
            {t("createAccount")}
            <ArrowRight className="h-4 w-4" />
          </Link>
        </Button>
        <Button variant="link" asChild className="px-0">
          <Link className="text-muted-foreground" href="/forgot-password">
            {t("forgotPassword")}
          </Link>
        </Button>
      </CardFooter>
    </Card>
  );
}

export default function SignInPage() {
  // useSearchParams needs a Suspense boundary to keep the route prerenderable.
  return (
    <Suspense fallback={null}>
      <SignInForm />
    </Suspense>
  );
}
