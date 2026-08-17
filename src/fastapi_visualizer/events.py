"""Event schema shared by the collector, instrumentation, and dashboard."""

from __future__ import annotations

from dataclasses import dataclass, field

REQUEST_START = "request_start"
REQUEST_END = "request_end"
CALL_ENTER = "call_enter"
CALL_EXIT = "call_exit"
SUSPEND = "suspend"
RESUME = "resume"
OFFLOAD_START = "offload_start"
OFFLOAD_END = "offload_end"
POOL_SAMPLE = "pool_sample"


@dataclass
class Event:
    t: float
    kind: str
    trace_id: str | None
    task_id: int | None
    name: str
    extra: dict = field(default_factory=dict)

    def to_dict(self) -> dict:
        return {
            "t": self.t,
            "kind": self.kind,
            "trace_id": self.trace_id,
            "task_id": self.task_id,
            "name": self.name,
            "extra": self.extra,
        }
