/**
 * Synthetic IFC4 generator for the engine spike.
 *
 * We need a 200 MB IFC to answer "does this engine survive a real federation
 * model", and we cannot commit one. This writes a structurally realistic file —
 * spatial hierarchy, elements with placements and extruded geometry, property
 * sets, and a georeferencing block — at whatever size is asked for, so the
 * measurement is reproducible on any machine without a licensed sample model.
 *
 *   npx tsx scripts/generate-large-ifc.mts <targetMB> <outfile>
 *
 * It is NOT a substitute for testing against a real vendor export: real files
 * have far messier geometry and deeper type hierarchies. It is a load test.
 */

import { createWriteStream } from "node:fs";
import { once } from "node:events";

const GUID_CHARS =
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_$";

/** Deterministic 22-character IFC GlobalId, so two runs produce the same file. */
function guid(seed: number): string {
  let out = "";
  let value = seed >>> 0;
  for (let i = 0; i < 22; i += 1) {
    value = (value * 1_664_525 + 1_013_904_223) >>> 0;
    out += GUID_CHARS[(value >>> 8) % 64];
  }
  return out;
}

export async function generate(targetBytes: number, outPath: string) {
  const stream = createWriteStream(outPath);
  let written = 0;

  const write = async (chunk: string) => {
    written += Buffer.byteLength(chunk);
    if (!stream.write(chunk)) await once(stream, "drain");
  };

  await write(`ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('ViewDefinition [DesignTransferView_V1.0]'),'2;1');
FILE_NAME('synthetic.ifc','2026-01-01T00:00:00',('DiCE-IFC'),('UMinho'),'DiCE-IFC spike','DiCE-IFC','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1= IFCPERSON($,'Spike','Generator',$,$,$,$,$);
#2= IFCORGANIZATION($,'DiCE-IFC',$,$,$);
#3= IFCPERSONANDORGANIZATION(#1,#2,$);
#4= IFCAPPLICATION(#2,'1.0','DiCE-IFC spike','DICE');
#5= IFCOWNERHISTORY(#3,#4,$,.ADDED.,$,$,$,0);
#10= IFCCARTESIANPOINT((0.,0.,0.));
#11= IFCDIRECTION((0.,0.,1.));
#12= IFCDIRECTION((1.,0.,0.));
#13= IFCAXIS2PLACEMENT3D(#10,#11,#12);
#14= IFCDIRECTION((0.,1.));
#15= IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,#13,#14);
#16= IFCGEOMETRICREPRESENTATIONSUBCONTEXT('Body','Model',*,*,*,*,#15,$,.MODEL_VIEW.,$);
#20= IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#21= IFCSIUNIT(*,.AREAUNIT.,$,.SQUARE_METRE.);
#22= IFCSIUNIT(*,.VOLUMEUNIT.,$,.CUBIC_METRE.);
#23= IFCSIUNIT(*,.PLANEANGLEUNIT.,$,.RADIAN.);
#24= IFCUNITASSIGNMENT((#20,#21,#22,#23));
#30= IFCPROJECT('${guid(1)}',#5,'Synthetic spike project',$,$,$,$,(#15),#24);
#40= IFCAXIS2PLACEMENT3D(#10,$,$);
#41= IFCLOCALPLACEMENT($,#40);
#50= IFCSITE('${guid(2)}',#5,'Site',$,$,#41,$,$,.ELEMENT.,(41,33,4,500000),(-8,-25,-17,-200000),190.,$,$);
#51= IFCLOCALPLACEMENT(#41,#40);
#52= IFCBUILDING('${guid(3)}',#5,'Building',$,$,#51,$,$,.ELEMENT.,$,$,$);
#60= IFCRELAGGREGATES('${guid(4)}',#5,$,$,#30,(#50));
#61= IFCRELAGGREGATES('${guid(5)}',#5,$,$,#50,(#52));
#90= IFCPROJECTEDCRS('EPSG:3763','ETRS89 / Portugal TM06','ETRS89','EVRF2007','Transverse Mercator','PT-TM06',#20);
#91= IFCMAPCONVERSION(#15,#90,-40000.,180000.,190.,1.,0.,1.);
`);

  // Elements per storey. Kept small enough that a storey's containment
  // relationship line stays a sane length, large enough that we are not
  // dominated by storey overhead.
  const ELEMENTS_PER_STOREY = 200;
  const CLASSES = ["IFCWALL", "IFCSLAB", "IFCBEAM", "IFCCOLUMN", "IFCDOOR"];

  let id = 1000;
  let storeyIndex = 0;
  const storeyIds: number[] = [];
  let seed = 100;

  while (written < targetBytes) {
    const storeyPlacement = (id += 1);
    const storeyId = (id += 1);
    storeyIds.push(storeyId);

    let chunk = `#${storeyPlacement}= IFCLOCALPLACEMENT(#51,#40);
#${storeyId}= IFCBUILDINGSTOREY('${guid((seed += 1))}',#5,'Level ${storeyIndex}',$,$,#${storeyPlacement},$,$,.ELEMENT.,${(storeyIndex * 3.2).toFixed(2)});
`;

    const elementIds: number[] = [];
    for (let i = 0; i < ELEMENTS_PER_STOREY; i += 1) {
      const cls = CLASSES[i % CLASSES.length];
      const x = (i % 20) * 5.5;
      const y = Math.floor(i / 20) * 4.25;

      const point = (id += 1);
      const placementAxis = (id += 1);
      const placement = (id += 1);
      const profile = (id += 1);
      const extrudeAxis = (id += 1);
      const solid = (id += 1);
      const shapeRep = (id += 1);
      const productShape = (id += 1);
      const element = (id += 1);
      elementIds.push(element);

      chunk += `#${point}= IFCCARTESIANPOINT((${x.toFixed(3)},${y.toFixed(3)},0.));
#${placementAxis}= IFCAXIS2PLACEMENT3D(#${point},#11,#12);
#${placement}= IFCLOCALPLACEMENT(#${storeyPlacement},#${placementAxis});
#${profile}= IFCRECTANGLEPROFILEDEF(.AREA.,'P${i}',$,${(0.2 + (i % 7) * 0.05).toFixed(3)},${(0.3 + (i % 5) * 0.1).toFixed(3)});
#${extrudeAxis}= IFCAXIS2PLACEMENT3D(#10,$,$);
#${solid}= IFCEXTRUDEDAREASOLID(#${profile},#${extrudeAxis},#11,${(2.4 + (i % 3) * 0.3).toFixed(3)});
#${shapeRep}= IFCSHAPEREPRESENTATION(#16,'Body','SweptSolid',(#${solid}));
#${productShape}= IFCPRODUCTDEFINITIONSHAPE($,$,(#${shapeRep}));
#${element}= ${cls}('${guid((seed += 1))}',#5,'${cls.slice(3)} ${storeyIndex}-${i}','Generated element',$,#${placement},#${productShape},'TAG-${storeyIndex}-${i}',$);
`;

      // A property set on every third element, so property extraction is
      // exercised without the file becoming mostly Psets.
      if (i % 3 === 0) {
        const p1 = (id += 1);
        const p2 = (id += 1);
        const p3 = (id += 1);
        const pset = (id += 1);
        const rel = (id += 1);
        chunk += `#${p1}= IFCPROPERTYSINGLEVALUE('FireRating',$,IFCLABEL('REI ${30 + (i % 4) * 30}'),$);
#${p2}= IFCPROPERTYSINGLEVALUE('IsExternal',$,IFCBOOLEAN(.${i % 2 === 0 ? "T" : "F"}.),$);
#${p3}= IFCPROPERTYSINGLEVALUE('LoadBearing',$,IFCBOOLEAN(.${i % 5 === 0 ? "T" : "F"}.),$);
#${pset}= IFCPROPERTYSET('${guid((seed += 1))}',#5,'Pset_${cls.slice(3, 4)}${cls.slice(4).toLowerCase()}Common',$,(#${p1},#${p2},#${p3}));
#${rel}= IFCRELDEFINESBYPROPERTIES('${guid((seed += 1))}',#5,$,$,(#${element}),#${pset});
`;
      }
    }

    const containment = (id += 1);
    chunk += `#${containment}= IFCRELCONTAINEDINSPATIALSTRUCTURE('${guid((seed += 1))}',#5,$,$,(${elementIds
      .map((e) => `#${e}`)
      .join(",")}),#${storeyId});
`;

    await write(chunk);
    storeyIndex += 1;
  }

  const aggregate = (id += 1);
  await write(
    `#${aggregate}= IFCRELAGGREGATES('${guid((seed += 1))}',#5,$,$,#52,(${storeyIds
      .map((s) => `#${s}`)
      .join(",")}));
ENDSEC;
END-ISO-10303-21;
`,
  );

  stream.end();
  await once(stream, "finish");

  return { bytes: written, storeys: storeyIndex, elements: storeyIndex * ELEMENTS_PER_STOREY };
}

const [, , mbArg, outArg] = process.argv;
if (mbArg && outArg) {
  const stats = await generate(Number(mbArg) * 1024 * 1024, outArg);
  console.log(
    `${outArg}: ${(stats.bytes / 1024 / 1024).toFixed(1)} MB, ${stats.storeys} storeys, ${stats.elements} elements`,
  );
}
