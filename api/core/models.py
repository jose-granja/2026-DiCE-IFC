from django.contrib.auth.models import AbstractUser, BaseUserManager
from django.db import models

from django.contrib.auth.models import Group
from django.contrib.auth.base_user import BaseUserManager


class MyUserManager(BaseUserManager):
    def _create_user(self, email, password, groups=None, **extra_fields):
        """
        Creates and saves a User with the given email and password.
        """
        if not email:
            raise ValueError("Users must have an email address")

        user = self.model(
            email=self.normalize_email(email),
            **extra_fields
        )
        user.set_password(password)
        user.save(using=self._db)

        # Attach groups if provided
        if groups:
            qs = Group.objects.filter(name__in=groups)
            user.groups.add(*qs)

        return user

    def create_user(self, email=None, password=None, **extra_fields):
        extra_fields.setdefault("is_staff", False)
        extra_fields.setdefault("is_superuser", False)

        # pass groups explicitly
        return self._create_user(email, password, groups=["applicant"], **extra_fields)

    def create_superuser(self, email=None, password=None, **extra_fields):
        extra_fields.setdefault("is_staff", True)
        extra_fields.setdefault("is_superuser", True)

        if extra_fields.get("is_staff") is not True:
            raise ValueError("Superuser must have is_staff=True.")
        if extra_fields.get("is_superuser") is not True:
            raise ValueError("Superuser must have is_superuser=True.")

        return self._create_user(email, password, groups=["admin"], **extra_fields)


class User(AbstractUser):
    username = None
    email = models.EmailField(unique=True)
    objects = MyUserManager()
    USERNAME_FIELD = "email"
    REQUIRED_FIELDS = []
