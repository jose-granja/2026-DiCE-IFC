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
import { OPERATOR, contactHref } from "@/config/legal";

/**
 * Credits, licences and the things this application should not be taken to
 * promise.
 *
 * Words live in `messages/*.json`, as on the privacy page: a notice a visitor
 * cannot read in their own language is not much of a notice. What does not
 * translate — component names, licence identifiers, URLs — lives here.
 *
 * Keep this honest and current. It is where the attribution each provider's
 * terms ask for is made, so adding a data source to the app means adding it
 * here in the same change.
 */

type Disclaimer = { title: string; text: string };

/** The components a reader would recognise; the full list is the text file. */
const COMPONENTS: Array<{ key: string; name: string; licence: string; href: string }> = [
  { key: "ifclite", name: "IFC-Lite (@ifc-lite/*)", licence: "MPL-2.0", href: "https://github.com/LTplus-AG/ifc-lite" },
  { key: "three", name: "three.js", licence: "MIT", href: "https://threejs.org" },
  { key: "cesium", name: "CesiumJS", licence: "Apache-2.0", href: "https://cesium.com/platform/cesiumjs/" },
  { key: "proj4", name: "proj4js", licence: "MIT", href: "https://proj4js.org" },
  { key: "laz", name: "laz-perf", licence: "Apache-2.0", href: "https://github.com/hobuinc/laz-perf" },
  { key: "sqlite", name: "SQLite Wasm", licence: "Apache-2.0", href: "https://sqlite.org/wasm" },
  { key: "libxml2", name: "libxml2 (xmllint-wasm)", licence: "MIT", href: "https://gitlab.gnome.org/GNOME/libxml2" },
  { key: "next", name: "Next.js", licence: "MIT", href: "https://nextjs.org" },
  { key: "react", name: "React", licence: "MIT", href: "https://react.dev" },
  { key: "radix", name: "Radix UI", licence: "MIT", href: "https://www.radix-ui.com" },
  { key: "lucide", name: "Lucide", licence: "ISC", href: "https://lucide.dev" },
  { key: "geist", name: "Geist", licence: "OFL-1.1", href: "https://github.com/vercel/geist-font" },
];

/** Where each provider explains its own terms — the link a credit should lead to. */
const DATA: Array<{ key: string; href: string }> = [
  { key: "osm", href: "https://www.openstreetmap.org/copyright" },
  { key: "openfreemap", href: "https://openfreemap.org" },
  { key: "maptiler", href: "https://www.maptiler.com/copyright/" },
  { key: "cesium", href: "https://cesium.com/legal/terms-of-service/" },
  { key: "google", href: "https://cloud.google.com/maps-platform/terms" },
  { key: "egm96", href: "https://earth-info.nga.mil/" },
  { key: "epsg", href: "https://epsg.org" },
  { key: "buildingsmart", href: "https://www.buildingsmart.org" },
];

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("about");
  return { title: t("title"), description: t("metaDescription") };
}

function External({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="underline underline-offset-2 hover:text-foreground"
    >
      {children}
    </a>
  );
}

export default function AboutPage() {
  const t = useTranslations("about");
  const disclaimers = t.raw("disclaimers.items") as Disclaimer[];
  const contact = OPERATOR.contact ? contactHref(OPERATOR.contact) : null;
  const contactLine = OPERATOR.contact ? (
    contact ? <External href={contact}>{OPERATOR.contact}</External> : OPERATOR.contact
  ) : null;

  return (
    <MaxWidthWrapper className="py-12">
      <div className="flex flex-col gap-3">
        <LocalOnlyBadge className="self-start" />
        <h1 className="text-3xl font-semibold tracking-tight">{t("title")}</h1>
        <p className="text-muted-foreground max-w-3xl text-sm">{t("intro")}</p>
      </div>

      {(OPERATOR.name || OPERATOR.contact) && (
        <section className="mt-10 max-w-3xl" data-about-operator>
          <h2 className="text-xl font-semibold tracking-tight">{t("operator.title")}</h2>
          <div className="text-muted-foreground mt-3 space-y-1 text-sm">
            {OPERATOR.name && <p>{t("operator.name", { name: OPERATOR.name })}</p>}
            {contactLine && (
              <p>
                {t("operator.contact")} {contactLine}
              </p>
            )}
          </div>
        </section>
      )}

      <section className="mt-10 max-w-3xl">
        <h2 className="text-xl font-semibold tracking-tight">{t("licence.title")}</h2>
        <p className="text-muted-foreground mt-3 text-sm">{t("licence.body")}</p>
        {OPERATOR.sourceUrl && (
          <p className="mt-2 text-sm">
            <External href={OPERATOR.sourceUrl}>{t("licence.source")}</External>
          </p>
        )}
      </section>

      <section className="mt-10">
        <h2 className="text-xl font-semibold tracking-tight">{t("thirdParty.title")}</h2>
        <p className="text-muted-foreground mt-3 max-w-3xl text-sm">{t("thirdParty.intro")}</p>
        <div className="mt-4 overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-[28%]">{t("thirdParty.columns.component")}</TableHead>
                <TableHead className="w-[14%]">{t("thirdParty.columns.licence")}</TableHead>
                <TableHead>{t("thirdParty.columns.role")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {COMPONENTS.map((component) => (
                <TableRow key={component.key}>
                  <TableCell className="align-top font-medium">
                    <External href={component.href}>{component.name}</External>
                  </TableCell>
                  <TableCell className="text-muted-foreground align-top">{component.licence}</TableCell>
                  <TableCell className="text-muted-foreground align-top">
                    {t(`thirdParty.roles.${component.key}`)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
        <p className="text-muted-foreground mt-3 max-w-3xl text-sm">{t("thirdParty.mpl")}</p>
        <p className="mt-2 text-sm">
          <a
            href="/third-party-licenses.txt"
            className="underline underline-offset-2"
            data-third-party-licences
          >
            {t("thirdParty.fullList")}
          </a>
        </p>
      </section>

      <section className="mt-10">
        <h2 className="text-xl font-semibold tracking-tight">{t("data.title")}</h2>
        <p className="text-muted-foreground mt-3 max-w-3xl text-sm">{t("data.intro")}</p>
        <ul className="mt-4 max-w-3xl space-y-3 text-sm">
          {DATA.map((entry) => (
            <li key={entry.key} className="rounded-md border p-3" data-data-credit={entry.key}>
              <p className="font-medium">
                <External href={entry.href}>{t(`data.rows.${entry.key}.name`)}</External>
              </p>
              <p className="text-muted-foreground mt-1">{t(`data.rows.${entry.key}.text`)}</p>
            </li>
          ))}
        </ul>
      </section>

      <section className="mt-10">
        <h2 className="text-xl font-semibold tracking-tight">{t("disclaimers.title")}</h2>
        <ul className="mt-4 max-w-3xl space-y-3 text-sm">
          {disclaimers.map((item) => (
            <li key={item.title} className="rounded-md border p-3">
              <p className="font-medium">{item.title}</p>
              <p className="text-muted-foreground mt-1">{item.text}</p>
            </li>
          ))}
        </ul>
      </section>

      <section className="mt-10 max-w-3xl">
        <h2 className="text-xl font-semibold tracking-tight">{t("accessibility.title")}</h2>
        <p className="text-muted-foreground mt-3 text-sm">{t("accessibility.text")}</p>
        {contactLine && (
          <p className="text-muted-foreground mt-2 text-sm">
            {t("accessibility.contact")} {contactLine}
          </p>
        )}
      </section>
    </MaxWidthWrapper>
  );
}
