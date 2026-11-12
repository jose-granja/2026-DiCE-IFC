from django.db import models


class PropertyName(models.Model):
    """
    One IFC property's name in one language, as the buildingSMART Data
    Dictionary's IFC dictionary has it (ADR 017).

    Keyed by the property's code — `FireRating` — because bSDD defines each IFC
    property once for the whole dictionary: its name is the same in every
    property set and class that uses it.
    """

    language = models.CharField(max_length=16, help_text="bSDD language code, e.g. pt-PT")
    code = models.CharField(max_length=160, help_text="The IFC property name, e.g. FireRating")
    name = models.CharField(max_length=300, help_text="bSDD's name in this language (English where bSDD has no translation)")
    english = models.CharField(max_length=300, help_text="bSDD's English name")
    uri = models.URLField(max_length=400)
    override = models.CharField(
        max_length=300,
        blank=True,
        help_text="Shown instead of bSDD's name. Kept when the table is updated from bSDD.",
    )
    updated_at = models.DateTimeField()

    class Meta:
        ordering = ["language", "code"]
        constraints = [models.UniqueConstraint(fields=["language", "code"], name="one_name_per_language")]

    def __str__(self) -> str:
        return f"{self.code} ({self.language}): {self.shown}"

    @property
    def shown(self) -> str:
        return self.override.strip() or self.name

    @property
    def translated(self) -> bool:
        """A name worth showing beside the code: neither bSDD's English nor the code itself."""
        return bool(self.shown) and self.shown not in (self.english, self.code)


class PropertyNameRefresh(models.Model):
    """One run of "Update from bSDD": requested in the admin or by the command."""

    QUEUED, RUNNING, DONE, FAILED = "queued", "running", "done", "failed"
    STATUSES = [(QUEUED, "Queued"), (RUNNING, "Running"), (DONE, "Done"), (FAILED, "Failed")]

    language = models.CharField(max_length=16)
    dictionary = models.URLField(max_length=400)
    status = models.CharField(max_length=8, choices=STATUSES, default=QUEUED)
    requested_by = models.CharField(max_length=150, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    started_at = models.DateTimeField(null=True, blank=True)
    finished_at = models.DateTimeField(null=True, blank=True)
    total = models.PositiveIntegerField(default=0, help_text="Properties in the dictionary")
    translated = models.PositiveIntegerField(default=0, help_text="Of those, with a name in this language")
    added = models.PositiveIntegerField(default=0)
    changed = models.PositiveIntegerField(default=0)
    removed = models.PositiveIntegerField(default=0)
    error = models.TextField(blank=True)

    class Meta:
        ordering = ["-created_at"]
        verbose_name = "update from bSDD"
        verbose_name_plural = "updates from bSDD"

    def __str__(self) -> str:
        return f"{self.language} — {self.get_status_display()} ({self.created_at:%Y-%m-%d %H:%M})"
