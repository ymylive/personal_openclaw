from __future__ import annotations

from workspace.modules.shared.contracts import DeliveryRequest, DeliveryTarget


def build_finance_push_request(
    *,
    job_name: str,
    body: str,
    target_channel: str,
    target_recipient: str,
) -> DeliveryRequest:
    return DeliveryRequest(
        job_name=job_name,
        body=body,
        targets=[DeliveryTarget(channel=target_channel, recipient=target_recipient)],
        metadata={"kind": "finance"},
    )
