import json
import logging
import socket
import ssl
import threading
from dataclasses import dataclass
from importlib.metadata import PackageNotFoundError, version
from typing import Any

from sqlalchemy import func, select, update
from sqlalchemy.orm import Session, sessionmaker

from minibrain.leader import Leader
from minibrain.policy import Policy, load
from minibrain.registry.audit_chain import HEAD, fields_of, head_of
from minibrain.registry.models import AuditChain, AuditEvent, now

FACILITY_LOG_AUDIT = 13
SEVERITY_NOTICE = 5
PRIORITY = FACILITY_LOG_AUDIT * 8 + SEVERITY_NOTICE
PORTS = {"tls": 6514, "tcp": 514, "udp": 514}
APP_NAME = "minibrain"
HOSTNAME_MAX = 255
MSGID_MAX = 32
BATCH = 500
CONNECT_SECONDS = 10.0
CLOSE_SECONDS = 2.0
FORWARD_SECONDS = 2.0
RETRY_SECONDS = 15.0
ERROR_MAX = 500

log = logging.getLogger("minibrain.siem")


@dataclass(frozen=True)
class Target:
    protocol: str
    host: str
    port: int
    ca_bundle: str

    def describe(self) -> str:
        host = f"[{self.host}]" if ":" in self.host else self.host
        return f"{self.protocol}://{host}:{self.port}"


def target_of(policy: Policy) -> Target | None:
    protocol = str(policy["siem_protocol"])
    host = str(policy["siem_host"])
    if protocol not in PORTS or not host:
        return None
    port = int(policy["siem_port"]) or PORTS[protocol]
    return Target(protocol, host, port, str(policy["siem_ca_bundle"]))


def software_version() -> str:
    try:
        return version("minibrain")
    except PackageNotFoundError:
        return "unknown"


def header_value(text: str, limit: int) -> str:
    printable = "".join(character for character in text if "!" <= character <= "~")[:limit]
    return printable or "-"


def param_value(text: str) -> str:
    return text.replace("\\", "\\\\").replace('"', '\\"').replace("]", "\\]")


def record_of(event: AuditEvent) -> dict[str, Any]:
    if event.seq is None or event.prev_hash is None:
        raise ValueError(f"audit event {event.id} is not sealed yet")
    return fields_of(event, event.seq, event.prev_hash) | {"id": event.id, "hash": event.hash}


def message(event: AuditEvent, hostname: str, software: str) -> bytes:
    record = record_of(event)
    origin = f'[origin software="{APP_NAME}" swVersion="{param_value(software)}"]'
    header = f"<{PRIORITY}>1 {record['at']} {hostname} {APP_NAME} - {header_value(event.action, MSGID_MAX)} {origin}"
    body = json.dumps(record, sort_keys=True, separators=(",", ":"), ensure_ascii=True)
    return f"{header} {body}".encode("ascii")


def framed(target: Target, payload: bytes) -> bytes:
    return payload if target.protocol == "udp" else str(len(payload)).encode("ascii") + b" " + payload


def tls_context(ca_bundle: str) -> ssl.SSLContext:
    context = ssl.create_default_context(cafile=ca_bundle or None)
    context.minimum_version = ssl.TLSVersion.TLSv1_2
    return context


def send_datagrams(target: Target, frames: list[bytes]) -> None:
    family, kind, proto, _, address = socket.getaddrinfo(target.host, target.port, type=socket.SOCK_DGRAM)[0]
    with socket.socket(family, kind, proto) as sock:
        sock.settimeout(CONNECT_SECONDS)
        sock.connect(address)
        for frame in frames:
            sock.send(frame)


def finish(sock: socket.socket) -> None:
    try:
        sock.settimeout(CLOSE_SECONDS)
        plain = sock.unwrap() if isinstance(sock, ssl.SSLSocket) else sock
        plain.shutdown(socket.SHUT_WR)
        while plain.recv(4096):
            continue
    except OSError:
        log.debug("the SIEM did not close the connection cleanly")


def deliver(sock: socket.socket, frames: list[bytes]) -> None:
    sock.sendall(b"".join(frames))
    finish(sock)


def send_stream(target: Target, frames: list[bytes]) -> None:
    with socket.create_connection((target.host, target.port), timeout=CONNECT_SECONDS) as raw:
        if target.protocol != "tls":
            deliver(raw, frames)
            return
        with tls_context(target.ca_bundle).wrap_socket(raw, server_hostname=target.host) as sock:
            deliver(sock, frames)


def send(target: Target, frames: list[bytes]) -> None:
    if target.protocol == "udp":
        send_datagrams(target, frames)
    else:
        send_stream(target, frames)


def waiting(session: Session, forwarded: int) -> int:
    return int(session.scalar(select(func.count(AuditEvent.id)).where(AuditEvent.seq > forwarded)) or 0)


class Forwarder:
    def __init__(self, sessions: sessionmaker[Session], hostname: str | None = None) -> None:
        self.sessions = sessions
        self.hostname = header_value(hostname or socket.gethostname(), HOSTNAME_MAX)
        self.software = software_version()

    def forward(self) -> int:
        with self.sessions() as session:
            target = target_of(load(session))
            if target is None:
                return 0
            head = head_of(session)
            query = select(AuditEvent).where(AuditEvent.seq > head.forwarded_seq).order_by(AuditEvent.seq)
            rows = list(session.scalars(query.limit(BATCH)))
            if not rows:
                return 0
            frames = [framed(target, message(event, self.hostname, self.software)) for event in rows]
            last, previous_error = rows[-1].seq or head.forwarded_seq, head.forward_error
            session.commit()
            try:
                send(target, frames)
            except OSError as error:
                self.failed(session, target, previous_error, str(error)[:ERROR_MAX] or type(error).__name__)
                raise
            values = {"forwarded_seq": last, "forwarded_at": now(), "forward_error": None}
            moved = (AuditChain.id == HEAD, AuditChain.forwarded_seq < last)
            session.execute(update(AuditChain).where(*moved).values(**values))
            session.commit()
            return len(frames)

    def failed(self, session: Session, target: Target, previous: str | None, error: str) -> None:
        if previous != error:
            log.warning("audit export to the SIEM at %s failed: %s", target.describe(), error)
            session.execute(update(AuditChain).where(AuditChain.id == HEAD).values(forward_error=error))
            session.commit()

    def drain(self) -> int:
        total = 0
        while (sent := self.forward()) == BATCH:
            total += sent
        return total + sent

    def forever(self, stop: threading.Event, leader: Leader) -> None:
        delay = FORWARD_SECONDS
        while not stop.wait(delay):
            delay = FORWARD_SECONDS
            try:
                if leader.held():
                    self.drain()
            except OSError:
                delay = RETRY_SECONDS
            except Exception:
                log.exception("audit export to the SIEM failed")
                delay = RETRY_SECONDS
