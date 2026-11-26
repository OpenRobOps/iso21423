from iso21423.errors import IllegalTransition

# Figure C.3 — request message state transitions (NP-2 entries copied verbatim from TS).
REQUEST_TRANSITIONS = {
    "RECEIVED": ("ACCEPTED", "CANCELED", "ABORTED"),  # NP-2: RECEIVED->CANCELED disputed
    "ACCEPTED": ("EXECUTING", "CANCELED", "ABORTED", "RECOVERY"),  # NP-2: ->ABORTED, ->RECOVERY disputed
    "EXECUTING": ("SUCCEEDED", "CANCELED", "ABORTED", "RECOVERY"),
    "RECOVERY": ("CANCELED", "ABORTED"),  # NP-2: no RECOVERY->SUCCEEDED
    "CANCELED": (),
    "SUCCEEDED": (),
    "ABORTED": (),
}

# Figure C.4 — requestDetail state transitions (no RECOVERY at detail level).
DETAIL_TRANSITIONS = {
    "RECEIVED": ("ACCEPTED", "CANCELED", "ABORTED"),
    "ACCEPTED": ("EXECUTING", "CANCELED", "ABORTED"),
    "EXECUTING": ("SUCCEEDED", "CANCELED", "ABORTED"),
    "CANCELED": (),
    "SUCCEEDED": (),
    "ABORTED": (),
}


def is_terminal_request_state(s: str) -> bool:
    return not REQUEST_TRANSITIONS[s]


class _Lifecycle:
    def __init__(self, table: dict, initial: str = "RECEIVED"):
        self._table = table
        self.state = initial

    def can_transition(self, to: str) -> bool:
        return to in self._table[self.state]

    def transition(self, to: str) -> None:
        if not self.can_transition(to):
            raise IllegalTransition(f"illegal transition {self.state} -> {to}")
        self.state = to

    def is_terminal(self) -> bool:
        return not self._table[self.state]


class RequestLifecycle(_Lifecycle):
    def __init__(self):
        super().__init__(REQUEST_TRANSITIONS)


class DetailLifecycle(_Lifecycle):
    def __init__(self):
        super().__init__(DETAIL_TRANSITIONS)
