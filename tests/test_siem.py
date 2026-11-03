import datetime
import ipaddress
import json
import re
import socket
import ssl
import threading
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID

from minibrain import siem
from minibrain.maintenance import purge_audit_events
from minibrain.registry.audit_chain import head_of, seal_all, verify_records
from minibrain.registry.models import AuditEvent, now
from minibrain.siem import Forwarder, header_value, param_value
from tests.conftest import Harness
from tests.test_audit import add_events
from tests.test_audit_chain import age

HEADER = re.compile(
    r'^<109>1 (?P<at>\S+) mb-host minibrain - (?P<msgid>\S+) \[origin software="minibrain" swVersion="[^"]+"\] '
    r"(?P<body>\{.*\})$"
)


class Listener:
    def __init__(self, context: ssl.SSLContext | None = None) -> None:
        self.server = socket.create_server(("127.0.0.1", 0))
        self.port = int(self.server.getsockname()[1])
        self.context = context
        self.received = bytearray()
        self.connections = 0
        self.thread = threading.Thread(target=self.serve, daemon=True)
        self.thread.start()

    def serve(self) -> None:
        while True:
            try:
                connection, _ = self.server.accept()
            except OSError:
                return
            self.connections += 1
            try:
                self.read(connection)
            except OSError:
                connection.close()

    def read(self, connection: socket.socket) -> None:
        stream = self.context.wrap_socket(connection, server_side=True) if self.context else connection
        with stream:
            while chunk := stream.recv(65536):
                self.received += chunk

    def frames(self) -> list[bytes]:
        found, data = [], bytes(self.received)
        while data:
            length, _, rest = data.partition(b" ")
            size = int(length)
            found.append(rest[:size])
            data = rest[size:]
        return found

    def close(self) -> None:
        self.server.close()


@pytest.fixture
def listener() -> Iterator[Listener]:
    found = Listener()
    yield found
    found.close()


def configure(harness: Harness, **values: Any) -> None:
    for name, value in values.items():
        response = harness.client.put(f"/api/policies/siem_{name}", json={"value": value})
        assert response.status_code == 200, response.text


def seal(harness: Harness) -> None:
    with harness.sessions() as session:
        seal_all(session)


def chain_head(harness: Harness) -> tuple[int, int, str | None]:
    with harness.sessions() as session:
        head = head_of(session)
        return head.seq, head.forwarded_seq, head.forward_error


def parsed(frames: list[bytes]) -> list[dict[str, Any]]:
    records = []
    for frame in frames:
        match = HEADER.match(frame.decode("ascii"))
        assert match is not None, frame
        record = json.loads(match["body"])
        assert match["msgid"] == record["action"] and match["at"] == record["at"]
        records.append(record)
    return records


def test_export_is_off_by_default_and_sends_nothing(harness: Harness, monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[Any] = []
    monkeypatch.setattr(socket, "create_connection", lambda *args, **kwargs: calls.append(args))
    add_events(harness, 2)
    seal(harness)
    assert Forwarder(harness.sessions).drain() == 0
    assert calls == []
    status = harness.client.get("/api/audit/chain").json()["siem"]
    assert (status["target"], status["forwarded_seq"], status["waiting"]) == (None, 0, 2)
    endpoints = harness.client.get("/api/system/install").json()["network"]["endpoints"]
    assert "SIEM export" not in {endpoint["name"] for endpoint in endpoints}


def test_tcp_export_frames_rfc5424_in_order_and_resumes_after_a_restart(
    harness: Harness, listener: Listener, monkeypatch: pytest.MonkeyPatch
) -> None:
    connected: list[Any] = []
    real = socket.create_connection
    monkeypatch.setattr(
        socket, "create_connection", lambda address, **kwargs: connected.append(address) or real(address, **kwargs)
    )
    configure(harness, protocol="tcp", host="127.0.0.1", port=listener.port)
    add_events(harness, 3, detail={"name": 'Café ]"\\', "password": "hunter2-hunter2"})
    seal(harness)
    assert Forwarder(harness.sessions, hostname="mb-host").drain() == 6
    records = parsed(listener.frames())
    assert [record["seq"] for record in records] == list(range(1, 7))
    assert records[-1]["detail"] == {"name": 'Café ]"\\', "password": "[redacted]"}
    assert all(len(frame) < 2048 and frame.isascii() for frame in listener.frames())
    assert verify_records(records).verified
    assert chain_head(harness) == (6, 6, None)
    assert Forwarder(harness.sessions, hostname="mb-host").drain() == 0
    add_events(harness, 2)
    seal(harness)
    restarted = Forwarder(harness.sessions, hostname="mb-host")
    assert restarted.drain() == 2
    again = parsed(listener.frames())
    assert [record["seq"] for record in again] == list(range(1, 9))
    assert verify_records(again).verified
    assert set(connected) == {("127.0.0.1", listener.port)}
    endpoints = harness.client.get("/api/system/install").json()["network"]["endpoints"]
    assert {
        "name": "SIEM export",
        "url": f"tcp://127.0.0.1:{listener.port}",
        "allowed": True,
        "by_policy": False,
    } in endpoints


def test_an_unreachable_siem_keeps_the_cursor_and_says_why(harness: Harness) -> None:
    probe = socket.create_server(("127.0.0.1", 0))
    port = int(probe.getsockname()[1])
    probe.close()
    configure(harness, protocol="tcp", host="127.0.0.1", port=port)
    seal(harness)
    with pytest.raises(OSError):
        Forwarder(harness.sessions, hostname="mb-host").drain()
    sealed, forwarded, error = chain_head(harness)
    assert (sealed, forwarded) == (3, 0)
    assert error is not None and "refused" in error.lower()
    status = harness.client.get("/api/audit/chain").json()["siem"]
    assert (status["target"], status["waiting"], status["error"]) == (f"tcp://127.0.0.1:{port}", 3, error)
    late = Listener()
    try:
        configure(harness, port=late.port)
        seal(harness)
        assert Forwarder(harness.sessions, hostname="mb-host").drain() == 4
        assert [record["seq"] for record in parsed(late.frames())] == [1, 2, 3, 4]
        assert chain_head(harness)[1:] == (4, None)
    finally:
        late.close()


def test_prune_keeps_events_the_siem_has_not_received(harness: Harness, listener: Listener) -> None:
    add_events(harness, 3)
    configure(harness, protocol="tcp", host="127.0.0.1", port=listener.port)
    assert harness.client.put("/api/policies/audit_retention_days", json={"value": 30}).status_code == 200
    age(harness, 100)
    seal(harness)
    with harness.sessions() as session:
        assert purge_audit_events(session) == 0
    assert Forwarder(harness.sessions, hostname="mb-host").drain() == 7
    with harness.sessions() as session:
        assert purge_audit_events(session) == 7


def certificate(
    subject: str, issuer: tuple[x509.Name, ec.EllipticCurvePrivateKey] | None, server: bool
) -> tuple[x509.Certificate, ec.EllipticCurvePrivateKey]:
    key = ec.generate_private_key(ec.SECP256R1())
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, subject)])
    issuer_name, issuer_key = issuer or (name, key)
    start = datetime.datetime.now(datetime.UTC) - datetime.timedelta(minutes=5)
    builder = (
        x509.CertificateBuilder()
        .subject_name(name)
        .issuer_name(issuer_name)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(start)
        .not_valid_after(start + datetime.timedelta(days=1))
        .add_extension(x509.SubjectKeyIdentifier.from_public_key(key.public_key()), critical=False)
        .add_extension(x509.AuthorityKeyIdentifier.from_issuer_public_key(issuer_key.public_key()), critical=False)
    )
    if server:
        builder = (
            builder.add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
            .add_extension(
                x509.SubjectAlternativeName([x509.IPAddress(ipaddress.ip_address("127.0.0.1"))]), critical=False
            )
            .add_extension(x509.ExtendedKeyUsage([ExtendedKeyUsageOID.SERVER_AUTH]), critical=False)
        )
    else:
        usage = x509.KeyUsage(True, False, False, False, False, True, True, False, False)
        builder = builder.add_extension(x509.BasicConstraints(ca=True, path_length=None), critical=True).add_extension(
            usage, critical=True
        )
    return builder.sign(issuer_key, hashes.SHA256()), key


def pem(path: Path, certificate: x509.Certificate) -> Path:
    path.write_bytes(certificate.public_bytes(serialization.Encoding.PEM))
    return path


def tls_listener(tmp_path: Path) -> tuple[Listener, Path]:
    authority, authority_key = certificate("minibrain test CA", None, server=False)
    leaf, leaf_key = certificate("siem.test", (authority.subject, authority_key), server=True)
    pem(tmp_path / "leaf.pem", leaf)
    (tmp_path / "leaf.key").write_bytes(
        leaf_key.private_bytes(
            serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()
        )
    )
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain(tmp_path / "leaf.pem", tmp_path / "leaf.key")
    return Listener(context), pem(tmp_path / "ca.pem", authority)


def test_tls_export_checks_the_siem_certificate(harness: Harness, tmp_path: Path) -> None:
    listener, bundle = tls_listener(tmp_path)
    stranger, _ = certificate("someone else", None, server=False)
    try:
        configure(
            harness,
            protocol="tls",
            host="127.0.0.1",
            port=listener.port,
            ca_bundle=str(pem(tmp_path / "other.pem", stranger)),
        )
        add_events(harness, 2)
        seal(harness)
        with pytest.raises(ssl.SSLCertVerificationError):
            Forwarder(harness.sessions, hostname="mb-host").drain()
        assert "certificate verify failed" in str(chain_head(harness)[2])
        assert listener.frames() == []
        configure(harness, ca_bundle=str(bundle))
        seal(harness)
        assert Forwarder(harness.sessions, hostname="mb-host").drain() == 7
        records = parsed(listener.frames())
        assert [record["seq"] for record in records] == list(range(1, 8))
        assert verify_records(records).verified
        assert chain_head(harness)[1:] == (7, None)
    finally:
        listener.close()


def test_udp_export_sends_one_message_per_datagram(harness: Harness) -> None:
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as receiver:
        receiver.bind(("127.0.0.1", 0))
        receiver.settimeout(5)
        configure(harness, protocol="udp", host="127.0.0.1", port=receiver.getsockname()[1])
        seal(harness)
        assert Forwarder(harness.sessions, hostname="mb-host").drain() == 3
        datagrams = [receiver.recv(65536) for _ in range(3)]
    assert [record["seq"] for record in parsed(datagrams)] == [1, 2, 3]


def test_siem_settings_are_validated_and_lockable(harness: Harness, monkeypatch: pytest.MonkeyPatch) -> None:
    for name, value in (
        ("host", "tls://siem.internal"),
        ("host", "siem.internal:6514"),
        ("host", "siem internal"),
        ("port", 70000),
        ("protocol", "relp"),
    ):
        assert harness.client.put(f"/api/policies/siem_{name}", json={"value": value}).status_code == 403
    configure(harness, host=" fd00::10 ")
    monkeypatch.setenv("MINIBRAIN_POLICY_SIEM_PROTOCOL", "tls")
    found = {item["name"]: item for item in harness.client.get("/api/policies").json()}
    assert (found["siem_host"]["value"], found["siem_port"]["maximum"]) == ("fd00::10", 65535)
    assert (found["siem_protocol"]["value"], found["siem_protocol"]["locked"]) == ("tls", True)
    assert harness.client.get("/api/audit/chain").json()["siem"]["target"] == "tls://[fd00::10]:6514"


def test_header_fields_stay_printable_and_params_escaped() -> None:
    assert header_value("mb host.ünï", 255) == "mbhost.n"
    assert header_value("", 255) == "-"
    assert header_value("x" * 40, siem.MSGID_MAX) == "x" * 32
    assert param_value('a"b]c\\d') == 'a\\"b\\]c\\\\d'
    event = AuditEvent(id=4, seq=2, prev_hash="0" * 64, hash="f" * 64, at=now(), actor="a", ip=None)
    event.action, event.target, event.detail = "key.create", "t", {}
    message = siem.message(event, "host", "1.2.3")
    assert (
        message.startswith(b"<109>1 ")
        and b' minibrain - key.create [origin software="minibrain" swVersion="1.2.3"] {' in message
    )
    assert siem.framed(siem.Target("tcp", "h", 1, ""), b"abc") == b"3 abc"
    assert siem.framed(siem.Target("udp", "h", 1, ""), b"abc") == b"abc"
