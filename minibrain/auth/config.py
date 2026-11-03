import ipaddress
from dataclasses import dataclass, field
from typing import Any

from minibrain.auth.addresses import ip_of
from minibrain.auth.roles import Role, highest, role_of
from minibrain.policy import config_section

Network = ipaddress.IPv4Network | ipaddress.IPv6Network
USER_HEADER = "x-forwarded-user"
EMAIL_HEADER = "x-forwarded-email"
GROUPS_HEADER = "x-forwarded-groups"
NAME_HEADER = "x-forwarded-preferred-username"


class AuthConfigError(Exception):
    pass


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

    @property
    def external(self) -> bool:
        return self.proxy is not None

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


def load_auth() -> AuthConfig:
    section = config_section("auth")
    return AuthConfig(roles=roles_of(section.get("roles")), proxy=proxy_of(section.get("proxy")))
