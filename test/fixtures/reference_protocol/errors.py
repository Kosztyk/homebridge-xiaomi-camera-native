"""Sanitized errors: never include cloud bodies, URLs or credentials."""


class XiaomiError(Exception):
    """Base error with a safe, fixed message."""


class AuthenticationError(XiaomiError):
    """The account needs to be authenticated again."""


class CloudError(XiaomiError):
    """Cloud request failed."""


class ProtocolError(XiaomiError):
    """Invalid or unsupported camera protocol."""


class TransportError(XiaomiError):
    """The local camera connection failed."""


class LoginChallenge(XiaomiError):
    """Interactive Xiaomi verification is required."""

    def __init__(self, kind: str, *, image: str = "", destination: str = "") -> None:
        super().__init__("Xiaomi account verification required")
        self.kind = kind
        self.image = image
        self.destination = destination
