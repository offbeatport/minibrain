import ipaddress


def ip_of(host: str | None) -> ipaddress.IPv4Address | ipaddress.IPv6Address | None:
    if not host:
        return None
    try:
        found = ipaddress.ip_address(host.strip("[]"))
    except ValueError:
        return None
    if isinstance(found, ipaddress.IPv6Address) and found.ipv4_mapped is not None:
        return found.ipv4_mapped
    return found


def loopback_name(host: str | None) -> bool:
    if not host:
        return False
    lowered = host.lower().rstrip(".")
    if lowered == "localhost" or lowered.endswith(".localhost"):
        return True
    found = ip_of(lowered)
    return found is not None and found.is_loopback
