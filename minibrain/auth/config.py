import ipaddress
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

from minibrain.auth.addresses import ip_of
from minibrain.auth.roles import Role, highest, role_of
from minibrain.policy import config_section

Network = ipaddress.IPv4Network | ipaddress.IPv6Network
USER_HEADER = "x-forwarded-user"
EMAIL_HEADER = "x-forwarded-email"
GROUPS_HEADER = "x-forwarded-groups"
NAME_HEADER = "x-forwarded-preferred-username"
OIDC_CREDENTIAL_ENV = "MINIBRAIN_OIDC_CLIENT_SECRET"


class AuthConfigError(Exception):
    pass


@dataclass(frozen=True)
class OidcConfig:
    issuer: str
    client_id: str
    client_secret: str | None = None
    label: str = "single sign-on"
    scopes: tuple[str, ...] = ("openid", "email", "profile")
    groups_claim: str = "groups"
    redirect_url: str | None = None
    ca_bundle: str | None = None


@dataclass(frozen=True)
class ProxyConfig:
    networks: tuple[Network, ...]
    user_header: str = USER_HEADER
    email_header: str = EMAIL_HEADER
    groups_header: str = GROUPS_HEADER
    name_header: str = NAME_HEADER

    def trusts(self, address: str | None) -> bool:
        found = ip_of(address)
        return found is not None and any(found in network for network in self.networks)


@dataclass(frozen=True)
class AuthConfig:
    roles: dict[str, Role] = field(default_factory=dict)
    proxy: ProxyConfig | None = None
    oidc: OidcConfig | None = None
    admins: frozenset[str] = frozenset()

    @property
    def external(self) -> bool:
        return self.proxy is not None or self.oidc is not None

    def lists_admin(self, email: str | None, subject: str) -> bool:
        return bool(self.admins) and ((email or "").strip().lower() in self.admins or subject.lower() in self.admins)

    def mapped_role(self, groups: list[str]) -> Role | None:
        wanted = {group.strip().lower() for group in groups}
        return highest(role for group, role in self.roles.items() if group in wanted)


def networks_of(values: Any) -> tuple[Network, ...]:
    items = values if isinstance(values, list) else [values] if values else []
    found: list[Network] = []
    for item in items:
        try:
            found.append(ipaddress.ip_network(str(item).strip(), strict=False))
        except ValueError as error:
            raise AuthConfigError(f"auth.proxy.addresses: {item} is not an address or network") from error
    return tuple(found)


def header_of(section: dict[str, Any], key: str, default: str) -> str:
    value = str(section.get(key) or default).strip().lower()
    if not value or any(character.isspace() for character in value):
        raise AuthConfigError(f"auth.proxy.{key} must be a header name")
    return value


def proxy_of(section: Any) -> ProxyConfig | None:
    if not section:
        return None
    if not isinstance(section, dict):
        raise AuthConfigError("auth.proxy must be a mapping with addresses and header names")
    networks = networks_of(section.get("addresses"))
    if not networks:
        raise AuthConfigError("auth.proxy.addresses lists the proxies minibrain trusts; it cannot be empty")
    return ProxyConfig(
        networks=networks,
        user_header=header_of(section, "user_header", USER_HEADER),
        email_header=header_of(section, "email_header", EMAIL_HEADER),
        groups_header=header_of(section, "groups_header", GROUPS_HEADER),
        name_header=header_of(section, "name_header", NAME_HEADER),
    )


def roles_of(section: Any) -> dict[str, Role]:
    if not section:
        return {}
    if not isinstance(section, dict):
        raise AuthConfigError("auth.roles maps group names to viewer, builder or admin")
    found: dict[str, Role] = {}
    for group, value in section.items():
        role = role_of(str(value))
        if role is None:
            raise AuthConfigError(f"auth.roles.{group}: {value} is not viewer, builder or admin")
        found[str(group).strip().lower()] = role
    return found


def admins_of(section: Any) -> frozenset[str]:
    if not section:
        return frozenset()
    if not isinstance(section, list) or not all(isinstance(item, str) and item.strip() for item in section):
        raise AuthConfigError("auth.admins is a list of emails or user names, such as [alice@corp.example]")
    return frozenset(item.strip().lower() for item in section)


def secret_file_of(section: dict[str, Any]) -> str | None:
    path = text_of(section, "client_secret_file")
    if path is None:
        return None
    try:
        return Path(path).expanduser().read_text().strip() or None
    except OSError as error:
        raise AuthConfigError(f"auth.oidc.client_secret_file {path} cannot be read: {error.strerror}") from error


def text_of(section: dict[str, Any], key: str) -> str | None:
    value = section.get(key)
    return str(value).strip() or None if value is not None else None


def oidc_of(section: Any) -> OidcConfig | None:
    if not section:
        return None
    if not isinstance(section, dict):
        raise AuthConfigError("auth.oidc must be a mapping with issuer and client_id")
    issuer = text_of(section, "issuer")
    client_id = text_of(section, "client_id")
    if not issuer or urlparse(issuer).scheme not in ("https", "http") or not client_id:
        raise AuthConfigError("auth.oidc needs an issuer URL and a client_id")
    if section.get("client_secret") is not None:
        raise AuthConfigError(
            "auth.oidc.client_secret writes the secret into minibrain.yaml; set MINIBRAIN_OIDC_CLIENT_SECRET or "
            "name a file with auth.oidc.client_secret_file instead"
        )
    scopes = section.get("scopes") or ["openid", "email", "profile"]
    if not isinstance(scopes, list) or "openid" not in scopes:
        raise AuthConfigError("auth.oidc.scopes is a list that includes openid")
    return OidcConfig(
        issuer=issuer,
        client_id=client_id,
        client_secret=os.environ.get(OIDC_CREDENTIAL_ENV, "").strip() or secret_file_of(section),
        label=text_of(section, "label") or "single sign-on",
        scopes=tuple(str(scope) for scope in scopes),
        groups_claim=text_of(section, "groups_claim") or "groups",
        redirect_url=text_of(section, "redirect_url"),
        ca_bundle=text_of(section, "ca_bundle"),
    )


def load_auth() -> AuthConfig:
    section = config_section("auth")
    return AuthConfig(
        roles=roles_of(section.get("roles")),
        proxy=proxy_of(section.get("proxy")),
        oidc=oidc_of(section.get("oidc")),
        admins=admins_of(section.get("admins")),
    )
