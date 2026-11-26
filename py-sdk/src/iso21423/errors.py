class Iso21423Error(Exception):
    """Base class for all errors this SDK raises."""


class ValidationError(Iso21423Error):
    """A payload failed ISO 21423 JSON Schema validation; `errors` holds the raw error list."""

    def __init__(self, message: str, errors: list | None = None):
        super().__init__(message)
        self.errors = errors if errors is not None else []


class IllegalTransition(Iso21423Error):
    """A lifecycle state change is not allowed from the current state."""


class AuthorizationDenied(Iso21423Error):
    """The broker/ACL rejected a publish or subscribe."""
