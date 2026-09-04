from django.conf import settings
from djoser.email import (
    ActivationEmail, 
    PasswordResetEmail, 
)

class MyActivationEmail(ActivationEmail):
    # Use your own template path
    template_name = "emails/activation.html"

    # Optional: add/modify context values available in the template
    def get_context_data(self):
        context = super().get_context_data()
        context["url"] = f"{settings.FRONTEN_PORTAL_URL}/{context['url']}"
        context.update({
            "product_name": "BIM A+ Applications Portal",
            "cta_label": "Activate account",
        })
        return context


class MyPasswordResetEmail(PasswordResetEmail):
    template_name = "emails/password_reset.html"

    def get_context_data(self):
        context = super().get_context_data()
        context["url"] = f"{settings.FRONTEN_PORTAL_URL}/{context['url']}"
        context["product_name"] = "BIM A+ Applications Portal"
        return context

