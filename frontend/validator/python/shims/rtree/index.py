class Property:
    def __init__(self):
        self.dimension = 2


class Index:
    def __init__(self, properties=None, interleaved=True):
        self._dim = getattr(properties, "dimension", 2) if properties is not None else 2
        self._interleaved = interleaved
        self._items = []

    def _box(self, coords):
        coords = tuple(float(c) for c in coords)
        if len(coords) == self._dim:  # a point
            return coords, coords
        n = len(coords) // 2
        if self._interleaved:
            return coords[:n], coords[n:]
        return coords[0::2], coords[1::2]

    def insert(self, id, coordinates, obj=None):
        self._items.append((id, self._box(coordinates)))

    add = insert

    def intersection(self, coordinates, objects=False):
        lo, hi = self._box(coordinates)
        for id, (a, b) in self._items:
            if all(a[k] <= hi[k] and b[k] >= lo[k] for k in range(len(lo))):
                yield id
