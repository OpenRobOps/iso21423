# Copyright 2026 InOrbit, Inc.
#
#    Licensed under the Apache License, Version 2.0 (the "License");
#    you may not use this file except in compliance with the License.
#    You may obtain a copy of the License at
#
#      http://www.apache.org/licenses/LICENSE-2.0
#
#    Unless required by applicable law or agreed to in writing, software
#    distributed under the License is distributed on an "AS IS" BASIS,
#    WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
#    See the License for the specific language governing permissions and
#    limitations under the License.

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
