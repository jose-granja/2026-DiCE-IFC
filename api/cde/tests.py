from datetime import timedelta

from django.contrib.auth import get_user_model
from django.test import TestCase
from django.utils import timezone
from rest_framework.test import APIClient

from . import models

User = get_user_model()

DIGEST = "a" * 64


class SignatureAuditModelTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user(email="a@example.com", password="pw")
        self.project = models.Project.objects.create(
            name="Bridge", signature_audit_enabled=True
        )

    def test_rows_are_immutable(self):
        audit = models.SignatureAudit.objects.create(
            project=self.project,
            user=self.user,
            file_name="model.ifczip",
            digest_hex=DIGEST,
            cert_subject="CN=Someone, C=PT",
            cert_serial="0123456789",
            container=models.SignatureAudit.Container.IFCZIP,
            signed_at=timezone.now(),
        )
        audit.file_name = "something-else.ifczip"
        with self.assertRaises(ValueError):
            audit.save()


class SignatureAuditApiTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user(email="a@example.com", password="pw")
        self.other = User.objects.create_user(email="b@example.com", password="pw")
        self.client = APIClient()
        self.client.force_authenticate(self.user)

        self.project = models.Project.objects.create(
            name="Bridge", signature_audit_enabled=True
        )
        models.ProjectMembership.objects.create(
            project=self.project,
            user=self.user,
            role=models.ProjectMembership.Role.OWNER,
        )

    def payload(self, **overrides):
        return {
            "project": str(self.project.id),
            "file_name": "model.ifczip",
            "digest_hex": DIGEST,
            "cert_subject": "CN=Someone, C=PT",
            "cert_serial": "0123456789",
            "container": "ifczip",
            "profile": "B",
            "signed_at": timezone.now().isoformat(),
            **overrides,
        }

    def test_creates_a_row_for_a_member(self):
        response = self.client.post(
            "/api/signature-audits/", self.payload(), format="json"
        )
        self.assertEqual(response.status_code, 201, response.data)
        self.assertEqual(models.SignatureAudit.objects.count(), 1)
        self.assertEqual(
            models.SignatureAudit.objects.get().user_id, self.user.id
        )

    def test_rejects_a_project_that_has_not_opted_in(self):
        self.project.signature_audit_enabled = False
        self.project.save()

        response = self.client.post(
            "/api/signature-audits/", self.payload(), format="json"
        )
        self.assertEqual(response.status_code, 400)
        self.assertEqual(models.SignatureAudit.objects.count(), 0)

    def test_rejects_a_digest_that_is_not_sha256(self):
        response = self.client.post(
            "/api/signature-audits/",
            self.payload(digest_hex="deadbeef"),
            format="json",
        )
        self.assertEqual(response.status_code, 400)
        self.assertIn("digest_hex", response.data)

    def test_normalises_uppercase_digests(self):
        response = self.client.post(
            "/api/signature-audits/",
            self.payload(digest_hex="A" * 64),
            format="json",
        )
        self.assertEqual(response.status_code, 201, response.data)
        self.assertEqual(models.SignatureAudit.objects.get().digest_hex, DIGEST)

    def test_a_retried_submission_does_not_duplicate_the_row(self):
        first = self.client.post(
            "/api/signature-audits/", self.payload(), format="json"
        )
        self.assertEqual(first.status_code, 201)

        # Same digest, same certificate, later wall-clock time: a retry, not a
        # second signing event.
        retry = self.client.post(
            "/api/signature-audits/",
            self.payload(signed_at=(timezone.now() + timedelta(minutes=1)).isoformat()),
            format="json",
        )
        self.assertEqual(retry.status_code, 200)
        self.assertEqual(models.SignatureAudit.objects.count(), 1)

    def test_non_members_cannot_write_or_read(self):
        self.client.force_authenticate(self.other)

        created = self.client.post(
            "/api/signature-audits/", self.payload(), format="json"
        )
        self.assertEqual(created.status_code, 403)

        models.SignatureAudit.objects.create(
            project=self.project,
            user=self.user,
            file_name="model.ifczip",
            digest_hex=DIGEST,
            cert_subject="CN=Someone, C=PT",
            cert_serial="0123456789",
            container=models.SignatureAudit.Container.IFCZIP,
            signed_at=timezone.now(),
        )
        listed = self.client.get("/api/signature-audits/")
        self.assertEqual(listed.data["count"], 0)

    def test_the_log_is_append_only_over_http(self):
        models.SignatureAudit.objects.create(
            project=self.project,
            user=self.user,
            file_name="model.ifczip",
            digest_hex=DIGEST,
            cert_subject="CN=Someone, C=PT",
            cert_serial="0123456789",
            container=models.SignatureAudit.Container.IFCZIP,
            signed_at=timezone.now(),
        )
        audit = models.SignatureAudit.objects.get()

        self.assertEqual(
            self.client.delete(f"/api/signature-audits/{audit.id}/").status_code, 405
        )
        self.assertEqual(
            self.client.patch(
                f"/api/signature-audits/{audit.id}/",
                {"file_name": "x"},
                format="json",
            ).status_code,
            405,
        )


class ProjectApiTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user(email="a@example.com", password="pw")
        self.other = User.objects.create_user(email="b@example.com", password="pw")
        self.client = APIClient()
        self.client.force_authenticate(self.user)

    def test_creating_a_project_makes_the_creator_its_owner(self):
        response = self.client.post(
            "/api/projects/", {"name": "Bridge"}, format="json"
        )
        self.assertEqual(response.status_code, 201, response.data)
        self.assertEqual(response.data["role"], "owner")

    def test_projects_you_are_not_in_are_not_listed(self):
        models.Project.objects.create(name="Someone else's project")
        response = self.client.get("/api/projects/")
        self.assertEqual(response.data["count"], 0)

    def test_the_audit_log_is_off_by_default(self):
        response = self.client.post(
            "/api/projects/", {"name": "Bridge"}, format="json"
        )
        self.assertFalse(response.data["signature_audit_enabled"])

    def test_only_owners_and_managers_change_membership(self):
        project = models.Project.objects.create(name="Bridge")
        models.ProjectMembership.objects.create(
            project=project,
            user=self.user,
            role=models.ProjectMembership.Role.VIEWER,
        )

        response = self.client.post(
            "/api/project-memberships/",
            {
                "project": str(project.id),
                "user": self.other.id,
                "role": "contributor",
            },
            format="json",
        )
        self.assertEqual(response.status_code, 403)
