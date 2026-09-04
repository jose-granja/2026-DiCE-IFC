import uuid

from django.conf import settings
from django.db import models
from simple_history.models import HistoricalRecords


class Project(models.Model):
    """A shared context for a set of models — metadata only.

    Deliberately holds no file, no geometry and no georeferencing. Everything
    the user actually works on lives in their browser (see the frontend's
    AGENTS.md §1); a Project exists so a team can agree on a name, a set of
    members and, optionally, a signature audit log.
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    name = models.CharField(max_length=200)
    description = models.TextField(blank=True)

    members = models.ManyToManyField(
        settings.AUTH_USER_MODEL,
        through="ProjectMembership",
        related_name="projects",
    )

    # Opt-in, and off by default. When false the API refuses to write
    # SignatureAudit rows for this project at all, so "we are not logging this"
    # is enforced server-side rather than trusted to the client.
    signature_audit_enabled = models.BooleanField(
        default=False,
        help_text=(
            "Record an audit row (user, time, file name, digest, certificate "
            "subject and serial) each time a member signs a file in this "
            "project. Never records file content or the signature itself."
        ),
    )

    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    history = HistoricalRecords()

    class Meta:
        ordering = ["name"]

    def __str__(self):
        return self.name


class ProjectMembership(models.Model):
    """Who is in a project, and what they may do in it."""

    class Role(models.TextChoices):
        OWNER = "owner", "Owner"
        MANAGER = "manager", "Manager"
        CONTRIBUTOR = "contributor", "Contributor"
        VIEWER = "viewer", "Viewer"

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    project = models.ForeignKey(
        Project, on_delete=models.CASCADE, related_name="memberships"
    )
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="project_memberships",
    )
    role = models.CharField(
        max_length=20, choices=Role.choices, default=Role.CONTRIBUTOR
    )
    created_at = models.DateTimeField(auto_now_add=True)

    history = HistoricalRecords()

    class Meta:
        ordering = ["project__name", "user__email"]
        constraints = [
            models.UniqueConstraint(
                fields=["project", "user"], name="unique_project_membership"
            )
        ]

    def __str__(self):
        return f"{self.user} — {self.role} of {self.project}"


class SignatureAudit(models.Model):
    """A record that a file was signed. Not the signature, and not the file.

    The columns here are the complete list of what the browser is permitted to
    send about a signature, and the model has no field for anything else on
    purpose: no file content, no signature value, no certificate bytes, no PIN,
    no timestamp token. Adding one is a privacy decision, not a schema change —
    see the frontend's AGENTS.md §1 and `/privacy`.

    Rows are immutable: `save()` refuses updates. An audit log that can be
    edited after the fact is not an audit log.
    """

    class Container(models.TextChoices):
        IFCZIP = "ifczip", "Signed IFC (ASiC-E .ifczip)"
        BCFZIP = "bcfzip", "Signed BCF (ASiC-E .bcfzip)"

    class Profile(models.TextChoices):
        B = "B", "XAdES-B"
        T = "T", "XAdES-T"
        LTA = "LTA", "XAdES-LTA"

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    project = models.ForeignKey(
        Project,
        on_delete=models.CASCADE,
        related_name="signature_audits",
        null=True,
        blank=True,
        help_text="Null for a signature made outside any project context.",
    )
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.PROTECT,
        related_name="signature_audits",
    )

    file_name = models.CharField(max_length=255)

    # SHA-256 of the payload exactly as it was read from disk, lowercase hex.
    # 64 characters, always: a shorter value means a different hash function and
    # should be rejected rather than stored.
    digest_hex = models.CharField(max_length=64, db_index=True)

    # Distinguished name and serial of the Cartão de Cidadão signing
    # certificate. Public data, present in every signature the holder makes.
    cert_subject = models.CharField(max_length=500)
    cert_serial = models.CharField(max_length=100)

    container = models.CharField(max_length=10, choices=Container.choices)
    profile = models.CharField(
        max_length=5, choices=Profile.choices, default=Profile.B
    )

    # When the browser says it signed. Not authoritative — a qualified
    # RFC 3161 timestamp inside the container is — but useful for ordering.
    signed_at = models.DateTimeField()
    recorded_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-signed_at"]
        indexes = [
            models.Index(fields=["project", "-signed_at"]),
        ]

    def __str__(self):
        return f"{self.file_name} signed by {self.user} at {self.signed_at:%Y-%m-%d %H:%M}"

    def save(self, *args, **kwargs):
        if self._state.adding is False:
            raise ValueError("SignatureAudit rows are immutable once written.")
        return super().save(*args, **kwargs)
