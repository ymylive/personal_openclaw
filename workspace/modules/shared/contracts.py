"""Delivery contract payload helpers."""

from __future__ import annotations

from dataclasses import dataclass, field


@dataclass(frozen=True)
class DeliveryTarget:
    channel: str
    recipient: str

    def to_dict(self) -> dict:
        return {"channel": self.channel, "recipient": self.recipient}


@dataclass(frozen=True)
class DeliveryRequest:
    job_name: str
    body: str
    targets: list[DeliveryTarget] = field(default_factory=list)
    metadata: dict[str, object] = field(default_factory=dict)

    def to_dict(self) -> dict:
        return {
            "job_name": self.job_name,
            "body": self.body,
            "targets": [target.to_dict() for target in self.targets],
            "metadata": dict(self.metadata),
        }
