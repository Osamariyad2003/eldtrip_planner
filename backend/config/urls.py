"""Root URL configuration. Everything the app serves lives under /api/."""

from django.urls import include, path

from planner.errors import api_not_found

urlpatterns = [
    path("api/", include("planner.urls")),
]

# ERR-02: unknown /api/* routes return 404 JSON.
handler404 = api_not_found
