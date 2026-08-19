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
LOOP_BLOCKED = "loop_blocked"
LOOP_UNBLOCKED = "loop_unblocked"


@dataclass
class Event:
    t: float
    kind: str
    trace_id: str | None
    task_id: int | None
    name: str
    extra: dict = field(default_factory=dict)
    # Process-wide monotonic ordering, assigned authoritatively in
    # Collector.push() (0 until pushed). The client uses it to detect dropped
    # events: a jump in seq between received events means the bounded queue
    # shed some in between.
    seq: int = 0

    def to_dict(self) -> dict:
        return {
            "seq": self.seq,
            "t": self.t,
            "kind": self.kind,
            "trace_id": self.trace_id,
            "task_id": self.task_id,
            "name": self.name,
            "extra": self.extra,
        }
