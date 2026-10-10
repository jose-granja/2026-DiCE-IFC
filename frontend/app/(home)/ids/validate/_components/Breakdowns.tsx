"use client";

import { useMemo } from "react";
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";

import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { byClass, byModel, bySpecification, type ValidationRun } from "@/lib/ids/report";

/**
 * Breakdowns by specification, by IFC class and by model.
 *
 * Three views of the same failures, because the three questions a coordinator
 * asks are different: *which requirement is being missed*, *what kind of
 * element misses it*, and *whose model is it in*. The last one is the one that
 * decides who gets the issue.
 */
const CONFIG = {
  passed: { label: "Passed", color: "var(--chart-2)" },
  failed: { label: "Failed", color: "var(--chart-1)" },
} satisfies ChartConfig;

export function Breakdowns({ run }: { run: ValidationRun }) {
  const specifications = useMemo(() => bySpecification(run), [run]);
  const classes = useMemo(() => byClass(run), [run]);
  const models = useMemo(() => byModel(run), [run]);

  return (
    <Tabs defaultValue="specification">
      <TabsList>
        <TabsTrigger value="specification">By specification</TabsTrigger>
        <TabsTrigger value="class">By class</TabsTrigger>
        <TabsTrigger value="model">By model</TabsTrigger>
      </TabsList>

      <TabsContent value="specification">
        <Chart data={specifications} stacked />
      </TabsContent>
      <TabsContent value="class">
        {classes.length === 0 ? (
          <Empty>Nothing failed, so there is nothing to break down by class.</Empty>
        ) : (
          // Failures only: the engine does not return passing entities, so a
          // "passed" bar here would always be zero and read as a total failure.
          <Chart data={classes} stacked={false} />
        )}
      </TabsContent>
      <TabsContent value="model">
        <Chart data={models} stacked />
      </TabsContent>
    </Tabs>
  );
}

function Chart({
  data,
  stacked,
}: {
  data: Array<{ label: string; passed: number; failed: number }>;
  stacked: boolean;
}) {
  if (data.length === 0) {
    return <Empty>No results to chart.</Empty>;
  }

  return (
    <ChartContainer config={CONFIG} className="mt-2 h-64 w-full">
      <BarChart data={data} layout="vertical" margin={{ left: 8, right: 16 }}>
        <CartesianGrid horizontal={false} />
        <XAxis type="number" allowDecimals={false} tickLine={false} axisLine={false} />
        <YAxis
          type="category"
          dataKey="label"
          width={150}
          tickLine={false}
          axisLine={false}
          // Long specification names are the norm and would otherwise push the
          // plot area down to nothing.
          tickFormatter={(value: string) =>
            value.length > 22 ? `${value.slice(0, 21)}…` : value
          }
        />
        <ChartTooltip content={<ChartTooltipContent />} />
        {stacked && <ChartLegend content={<ChartLegendContent />} />}
        {stacked && (
          <Bar dataKey="passed" stackId="a" fill="var(--color-passed)" radius={[0, 0, 0, 0]} />
        )}
        <Bar dataKey="failed" stackId="a" fill="var(--color-failed)" radius={[0, 3, 3, 0]} />
      </BarChart>
    </ChartContainer>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="text-muted-foreground p-6 text-center text-xs">{children}</p>;
}

export default Breakdowns;
