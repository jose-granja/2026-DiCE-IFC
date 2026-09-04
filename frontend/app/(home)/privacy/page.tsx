import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { useTranslations } from "next-intl";

import MaxWidthWrapper from "@/components/MaxWidthWrapper";
import LocalOnlyBadge from "@/components/LocalOnlyBadge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

/**
 * What leaves the device.
 *
 * The content lives in `messages/*.json` rather than here. That is not a style
 * choice: this page is the promise the "processed locally" badge on every
 * module links to, and a promise a Portuguese user cannot read is not a promise
 * they can hold us to.
 *
 * Rows are read with `t.raw()` because they are structured data, not sentences
 * with placeholders — `t()` would return a string where an array is wanted.
 */

type Row = { what: string; when: string; where: string; why: string };
type LocalRow = { what: string; where: string; why: string };

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("privacy");
  return { title: t("pageTitle"), description: t("metaDescription") };
}

export default function PrivacyPage() {
  const t = useTranslations("privacy");
  const leaves = t.raw("leaves") as Row[];
  const localOnly = t.raw("localOnly") as LocalRow[];
  const never = t.raw("never") as string[];

  return (
    <MaxWidthWrapper className="py-12">
      <div className="flex flex-col gap-3">
        <LocalOnlyBadge className="self-start" />
        <h1 className="text-3xl font-semibold tracking-tight">
          {t("pageTitle")}
        </h1>
        <p className="text-muted-foreground max-w-3xl text-sm">{t("intro")}</p>
      </div>

      <section className="mt-10">
        <h2 className="text-xl font-semibold tracking-tight">{t("sent")}</h2>
        <div className="mt-4 overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-[26%]">{t("columns.what")}</TableHead>
                <TableHead className="w-[20%]">{t("columns.when")}</TableHead>
                <TableHead className="w-[24%]">{t("columns.where")}</TableHead>
                <TableHead>{t("columns.why")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {leaves.map((row) => (
                <TableRow key={row.what}>
                  <TableCell className="align-top font-medium">
                    {row.what}
                  </TableCell>
                  <TableCell className="text-muted-foreground align-top">
                    {row.when}
                  </TableCell>
                  <TableCell className="text-muted-foreground align-top">
                    {row.where}
                  </TableCell>
                  <TableCell className="text-muted-foreground align-top">
                    {row.why}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </section>

      <section className="mt-10">
        <h2 className="text-xl font-semibold tracking-tight">
          {t("localTitle")}
        </h2>
        <p className="text-muted-foreground mt-2 max-w-3xl text-sm">
          {t("localIntro")}
        </p>
        <ul className="mt-4 max-w-3xl space-y-3 text-sm">
          {localOnly.map((row) => (
            <li key={row.what} className="rounded-md border p-3">
              <p className="font-medium">{row.what}</p>
              <p className="text-muted-foreground mt-0.5 text-xs">{row.where}</p>
              <p className="text-muted-foreground mt-1.5 text-sm">{row.why}</p>
            </li>
          ))}
        </ul>
      </section>

      <section className="mt-10">
        <h2 className="text-xl font-semibold tracking-tight">{t("notSent")}</h2>
        <ul className="text-muted-foreground mt-4 max-w-3xl list-disc space-y-1.5 pl-5 text-sm">
          {never.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      </section>

      <section className="mt-10 max-w-3xl">
        <h2 className="text-xl font-semibold tracking-tight">{t("enforcement")}</h2>
        <div className="text-muted-foreground mt-4 space-y-3 text-sm">
          <p>{t("enforce1")}</p>
          <p>{t("enforce2")}</p>
          <p>{t("enforce3")}</p>
          <p>{t("enforce4")}</p>
        </div>
      </section>
    </MaxWidthWrapper>
  );
}
