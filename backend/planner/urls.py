"""API routes (section 8.1). Everything is public and unauthenticated."""

from django.urls import path, re_path

from . import views
from .errors import api_not_found

urlpatterns = [
    path("trips/plan/", views.plan, name="plan"),
    path("geocode/", views.geocode, name="geocode"),
    path("health/", views.health, name="health"),
    # ERR-02: unknown /api/* paths return 404 JSON, not Django's HTML page.
    re_path(r"^.*$", api_not_found),
]
