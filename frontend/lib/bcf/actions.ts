"use client";

/**
 * Capturing and restoring viewpoints against the live viewer.
 *
 * The only place BCF touches the renderer. `viewpoint.ts` holds the pure
 * conversions and knows nothing about React, zustand or three.js; this file
 * wires those conversions to `getActiveRenderer()` and the two stores.
 *
 * ## Which frame
 *
 * BCF has no concept of a federation — a viewpoint is written against one
 * model's IFC world coordinates. So one loaded model has to serve as the
 * reference frame, and the choice is: the model whose name matches the topic's
 * header `<Filename>` if one does, otherwise the first ready model.
 *
 * For the single-model case, which is most of them, that is exactly right. For
 * a georeferenced federation every model already shares the map frame, so the
 * camera lands correctly regardless of which one was picked. The case that
 * genuinely cannot be represented is a federation of *ungeoreferenced* models,
 * where there is no shared frame to write down — `restoreViewpoint` reports
 * how many components it could not find, which is the visible symptom.
 */

import { getActiveRenderer } from "@/lib/viewer/active-renderer";
import { useViewerStore, type EntityRef } from "@/lib/viewer/store";
import { resolveGlobalIds, globalIdsOf } from "./resolver";
import {
  bcfColour,
  cameraFromViewer,
  cameraToViewer,
  clippingPlanesToSections,
  componentPlan,
  cssColour,
  sectionsToClippingPlanes,
  IDENTITY_FRAME,
  type ViewpointFrame,
} from "./viewpoint";
import { newGuid, type BcfComponent, type BcfTopic, type BcfViewpoint } from "./types";
import { layoutTopicMarkers, locateTopicMarker, markerComponentIds, type MarkerBounds, type TopicMarker } from "./markers";

/** Resolve once per model/topic change; camera movement only reprojects pins. */
export async function locateTopicMarkers(topics: BcfTopic[]): Promise<TopicMarker[]> {
  const renderer = getActiveRenderer();
  const { modelIds } = referenceFrame();
  if (!renderer || modelIds.length === 0) return [];

  const ids = new Set(topics.flatMap((topic) => topic.viewpoints.flatMap(markerComponentIds)));
  const bounds = new Map<string, MarkerBounds | null>();
  await Promise.all([...ids].map(async (id) => {
    const { refs } = await resolveGlobalIds([id], modelIds);
    bounds.set(id, renderer.boundsOfRefs(refs));
  }));
  const distance = targetDistance(useViewerStore.getState().federationBounds());
  return topics.flatMap((topic) => {
    const { frame } = referenceFrame(topic.headerFiles[0]?.filename);
    const marker = locateTopicMarker(topic, (id) => bounds.get(id) ?? null, frame, distance);
    return marker ? [marker] : [];
  });
}

export function projectTopicMarkers(markers: TopicMarker[]) {
  const renderer = getActiveRenderer();
  return renderer ? layoutTopicMarkers(markers, (point) => renderer.projectPoint(point)) : [];
}

/**
 * The reference frame, and the models a viewpoint may resolve against.
 *
 * `fileName` is the topic header's `<Filename>`, matched against the loaded
 * model names. Best-effort by nature — plenty of files omit the header
 * entirely, and the first ready model is the fallback.
 */
function referenceFrame(fileName?: string): {
  frame: ViewpointFrame;
  modelIds: string[];
} {
  const { models, placements } = useViewerStore.getState();
  const ready = models.filter((model) => model.load.status === "ready");

  if (ready.length === 0) return { frame: IDENTITY_FRAME, modelIds: [] };

  const named = fileName
    ? ready.find(
        (model) =>
          model.summary.name.toLowerCase() === fileName.toLowerCase(),
      )
    : undefined;
  const reference = named ?? ready[0];

  return {
    frame: {
      originShift: reference.coordinates?.originShift ?? [0, 0, 0],
      placementOffset: placements[reference.summary.id]?.offset ?? [0, 0, 0],
    },
    modelIds: ready.map((model) => model.summary.id),
  };
}

export type RestoreOutcome = {
  /** GlobalIds the viewpoint named that no loaded model contains. */
  missing: number;
  /** Tilted clipping planes vertical-axis rotation cannot represent. */
  skippedPlanes: number;
  /** False when no model is loaded, so there was nothing to restore into. */
  applied: boolean;
};

/**
 * Put the viewer into the state a viewpoint describes.
 *
 * Order matters: visibility is reset first, so a viewpoint that isolates two
 * walls does not inherit whatever the previous one hid. Anything the viewpoint
 * does not mention is left alone rather than cleared — a viewpoint with only a
 * camera should move the camera and nothing else.
 */
export async function restoreViewpoint(
  viewpoint: BcfViewpoint,
  fileName?: string,
): Promise<RestoreOutcome> {
  const { frame, modelIds } = referenceFrame(fileName);
  if (modelIds.length === 0) {
    return { missing: 0, skippedPlanes: 0, applied: false };
  }

  const store = useViewerStore.getState();
  const plan = componentPlan(viewpoint.components);
  let missing = 0;

  const resolve = async (globalIds: string[]): Promise<EntityRef[]> => {
    const result = await resolveGlobalIds(globalIds, modelIds);
    missing += result.missing.length;
    return result.refs;
  };

  if (viewpoint.components) {
    store.resetVisibility();

    if (plan.isolate) {
      const refs = await resolve(plan.isolate);
      // An isolation that resolved to nothing would black out the model and
      // look like a crash. Leaving everything visible is the safer failure.
      if (refs.length > 0) store.isolate(refs);
    } else if (plan.hide.length > 0) {
      store.hide(await resolve(plan.hide));
    }

    store.clearColouring();
    if (plan.colouring.length > 0) {
      const entries = await Promise.all(
        plan.colouring.map(async ({ ifcGuid, colour }) => ({
          refs: await resolve([ifcGuid]),
          colour,
        })),
      );
      store.setColouring(
        entries.flatMap(({ refs, colour }) => refs.map((ref) => ({ ref, colour }))),
      );
    }

    store.select(plan.select.length > 0 ? await resolve(plan.select) : []);
  }

  const { planes, skipped } = clippingPlanesToSections(
    viewpoint.clippingPlanes,
    frame,
  );
  store.clearSectionPlanes();
  for (const plane of planes) store.addSectionPlane(plane.axis);
  // `addSectionPlane` centres each new plane on the model, so the imported
  // positions are applied afterwards, against the ids the store just minted.
  const created = useViewerStore.getState().sectionPlanes;
  planes.forEach((plane, index) => {
    const target = created[index];
    if (target) {
      store.updateSectionPlane(target.id, {
        position: plane.position,
        rotation: plane.rotation,
        flipped: plane.flipped,
      });
    }
  });

  if (viewpoint.camera) {
    const renderer = getActiveRenderer();
    if (renderer) {
      const bounds = store.federationBounds();
      renderer.setCameraState(
        cameraToViewer(viewpoint.camera, frame, targetDistance(bounds)),
      );
    }
  }

  return { missing, skippedPlanes: skipped, applied: true };
}

/**
 * A pivot distance that suits the model being looked at.
 *
 * A fixed value orbits awkwardly: 10 m is a pirouette inside a bridge deck and
 * a crawl around a door handle.
 */
function targetDistance(bounds: { min: number[]; max: number[] } | null): number {
  if (!bounds) return 10;

  const diagonal = Math.hypot(
    bounds.max[0] - bounds.min[0],
    bounds.max[1] - bounds.min[1],
    bounds.max[2] - bounds.min[2],
  );
  return Math.max(1, diagonal / 4);
}

/**
 * Capture the viewer's current state as a viewpoint.
 *
 * The snapshot is the canvas as a PNG — the same image the author is looking
 * at, which is the whole point of a viewpoint for anyone whose tool cannot
 * restore it.
 */
export async function captureViewpoint(
  fileName?: string,
): Promise<BcfViewpoint | null> {
  const renderer = getActiveRenderer();
  if (!renderer) return null;

  const { frame } = referenceFrame(fileName);
  const store = useViewerStore.getState();
  const guid = newGuid();

  const selection = await globalIdsOf(store.selection);
  const hidden = await hiddenGlobalIds();
  const isolated = await isolatedGlobalIds();

  const camera = cameraFromViewer(
    renderer.getCameraState(),
    frame,
    renderer.aspectRatio,
  );

  const colouring = await colouringComponents();

  return {
    guid,
    fileName: `viewpoint-${guid}.bcfv`,
    camera,
    components: {
      selection: selection.map(toComponent),
      // An isolation is `DefaultVisibility=false` plus the visible elements as
      // exceptions — the inversion BCF uses and the one everybody misreads.
      defaultVisibility: isolated === null,
      exceptions: (isolated ?? hidden).map(toComponent),
      coloring: colouring,
    },
    clippingPlanes: sectionsToClippingPlanes(store.sectionPlanes, frame),
    lines: [],
    bitmaps: [],
    snapshot: snapshotOf(renderer),
  };
}

function toComponent(ifcGuid: string): BcfComponent {
  return { ifcGuid, originatingSystem: "DiCE-IFC" };
}

async function hiddenGlobalIds(): Promise<string[]> {
  const { hidden } = useViewerStore.getState();
  return globalIdsOf([...hidden].map(refFromKey));
}

async function isolatedGlobalIds(): Promise<string[] | null> {
  const { isolated } = useViewerStore.getState();
  if (!isolated) return null;
  return globalIdsOf([...isolated].map(refFromKey));
}

async function colouringComponents() {
  const { colouring } = useViewerStore.getState();

  // BCF groups components under a colour; the viewer stores a colour per
  // component. Regrouping keeps the written file small and idiomatic.
  const byColour = new Map<string, string[]>();
  for (const [key, colour] of colouring) {
    const globalId = await globalIdsOf([refFromKey(key)]);
    if (globalId.length === 0) continue;

    const bucket = byColour.get(colour) ?? [];
    bucket.push(...globalId);
    byColour.set(colour, bucket);
  }

  return [...byColour].map(([colour, ids]) => ({
    colour: bcfColour(colour),
    components: ids.map(toComponent),
  }));
}

/** `refKey` in lib/viewer/store.ts is `${modelId}#${expressId}`. */
function refFromKey(key: string): EntityRef {
  const index = key.lastIndexOf("#");
  return {
    modelId: key.slice(0, index),
    expressId: Number(key.slice(index + 1)),
  };
}

function snapshotOf(
  renderer: NonNullable<ReturnType<typeof getActiveRenderer>>,
): BcfViewpoint["snapshot"] {
  const dataUrl = renderer.snapshot();
  const base64 = dataUrl.split(",")[1];
  if (!base64) return undefined;

  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return { fileName: `snapshot-${newGuid()}.png`, bytes };
}

export { cssColour };
