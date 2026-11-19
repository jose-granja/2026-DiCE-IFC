"""Pure-Python stand-in for rtree (libspatialindex is not built for Pyodide).
Only what ifc-gherkin-rules uses: index.Property().dimension, index.Index(properties=…),
.insert(id, bbox) and .intersection(bbox). Brute force over boxes, same answers."""
from . import index  # noqa: F401
