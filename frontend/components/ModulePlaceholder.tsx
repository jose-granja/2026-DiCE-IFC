import Link from "next/link";
import { ArrowLeft } from "lucide-react";

import MaxWidthWrapper from "@/components/MaxWidthWrapper";
import ModuleHeader from "@/components/ModuleHeader";
import { Button } from "@/components/ui/button";

/**
 * A module that is planned but not built yet.
 *
 * These exist so the navigation does not lead to a 404 and so prefetching a
 * module route is not a console error. They state which phase the module lands
 * in, rather than pretending the feature is nearly there.
 */
export function ModulePlaceholder({
  title,
  description,
  phase,
  planned,
}: {
  title: string;
  description: string;
  phase: number;
  planned: string[];
}) {
  return (
    <div className="flex flex-1 flex-col">
      <ModuleHeader title={title} description={description} />

      <MaxWidthWrapper className="py-10">
        <p className="text-muted-foreground text-sm">
          Not built yet — this module lands in <strong>Phase {phase}</strong>.
        </p>

        <h2 className="mt-6 text-sm font-medium">What it will do</h2>
        <ul className="text-muted-foreground mt-2 max-w-2xl list-disc space-y-1 pl-5 text-sm">
          {planned.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>

        <Button variant="secondary" size="sm" asChild className="mt-8">
          <Link href="/viewer">
            <ArrowLeft className="h-4 w-4" />
            Go to the viewer
          </Link>
        </Button>
      </MaxWidthWrapper>
    </div>
  );
}

export default ModulePlaceholder;
