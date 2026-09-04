"use client";

import Link from "next/link";
import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
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
import { ResetPasswordSchema } from "@/lib/validators/auth-validators";
import { confirmPasswordReset } from "@/lib/actions/auth";

function ResetPasswordForm() {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const t = useTranslations("auth");
  const router = useRouter();
  const searchParams = useSearchParams();

  // djoser's reset email links to /reset-password?uid=...&token=...
  const uid = searchParams.get("uid") ?? "";
  const token = searchParams.get("token") ?? "";

  const form = useAppForm({
    defaultValues: { new_password: "", re_new_password: "" },
    validators: { onSubmit: ResetPasswordSchema },
    onSubmit: async ({ value }) => {
      setIsSubmitting(true);
      toast.loading(t("settingPassword"), { id: "reset" });
      try {
        const result = await confirmPasswordReset({ uid, token, ...value });
        if (result.error) {
          toast.error(result.error, { id: "reset" });
          return;
        }
        toast.success(t("passwordUpdated"), { id: "reset" });
        router.push("/sign-in");
      } catch {
        toast.error(t("resetFailed"), {
          id: "reset",
        });
      } finally {
        setIsSubmitting(false);
      }
    },
    onSubmitInvalid: () => {
      toast.error(t("fixErrors"), { id: "reset" });
    },
  });

  if (!uid || !token) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>{t("linkIncomplete")}</CardTitle>
          <CardDescription>
            This reset link is missing its identifier or token. Request a new one.
          </CardDescription>
        </CardHeader>
        <CardFooter>
          <Button asChild>
            <Link href="/forgot-password">Request a new link</Link>
          </Button>
        </CardFooter>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("chooseNewPassword")}</CardTitle>
      </CardHeader>
      <CardContent>
        <FormSchemaProvider schema={ResetPasswordSchema}>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              form.handleSubmit();
            }}
          >
            <FieldGroup>
              <form.AppField name="new_password">
                {(field) => (
                  <field.InputPassword
                    label={t("newPassword")}
                    description={t("passwordHint")}
                  />
                )}
              </form.AppField>
              <form.AppField name="re_new_password">
                {(field) => <field.InputPassword label={t("confirmNewPassword")} />}
              </form.AppField>
              <Button type="submit" disabled={isSubmitting}>
                {isSubmitting ? t("saving") : t("setPassword")}
              </Button>
            </FieldGroup>
          </form>
        </FormSchemaProvider>
      </CardContent>
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

export default function ResetPasswordPage() {
  return (
    <Suspense fallback={null}>
      <ResetPasswordForm />
    </Suspense>
  );
}
