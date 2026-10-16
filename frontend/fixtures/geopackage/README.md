`context.gpkg` is the original small polygon/road context fixture.

`curved-map.gpkg` is synthetic test data: a large sea rectangle, a concave land
polygon, and a compound circular curve near (-40000, 180000) in EPSG:3763.
Its local SRS ID is deliberately 103763, with authority EPSG and code 3763,
to catch readers that mistake a database key for a coordinate-system code.

The optional `CONTEXT_TEST_GPKG` browser regression reads the user's
PortugalSmallScaleMap.gpkg in place. That file is never copied into this repository.
