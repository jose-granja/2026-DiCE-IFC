"use client";

import { useTranslations } from "next-intl";

import SignModule from "../_components/SignModule";
import { BCF_FILE_EXTENSIONS } from "@/config";

export default function SignBcfPage() {
  const t = useTranslations("signPages.bcf");
  return (
    <SignModule
      kind="bcf"
      title={t("title")}
      description={t("description")}
      accept={[...BCF_FILE_EXTENSIONS]}
    />
  );
}
