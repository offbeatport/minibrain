import argparse
import json
from dataclasses import asdict
from datetime import timedelta
from typing import Any

from minibrain.encryption.keys import LABELS, ensure_master_key, keys_for, records_of
from minibrain.encryption.rekey import GRACE, Plan, Tally, retire_unused, rotate_key, run_pass, save_last
from minibrain.registry.models import AuditEvent, now

ACTOR = "command line"


def lines(kind: str, current: str, where: str, tally: Tally, records: list[dict[str, Any]]) -> list[str]:
    found = [
        f"Provider: {LABELS.get(kind, kind)} ({where})" if kind != "off" else "Encryption at rest is off",
        f"Current key: {kind}:{current}" if current else "Current key: none",
        f"Files: {tally.files} ({tally.current} under the current key, {tally.older} under older keys, "
        f"{tally.plain} not encrypted, {tally.damaged} unreadable)",
        f"Secrets: {tally.secrets} ({tally.secrets_older} under older keys or the old format)",
    ]
    if tally.encrypted or tally.rewrapped or tally.resealed or tally.removed:
        found.append(
            f"This run: {tally.encrypted} encrypted, {tally.rewrapped} re-wrapped, {tally.resealed} secrets resealed, "
            f"{tally.removed} plaintext copies removed"
        )
    for item in records:
        state = f"retired {item['retired_at']}" if item.get("retired_at") else "live"
        used = tally.keys.get(f"{item.get('provider')}:{item.get('key')}", 0)
        found.append(
            f"  {item.get('provider')}:{item.get('key')}  {state}, used by {used}, made {item.get('created_at')}"
        )
    found += [f"  problem: {problem}" for problem in tally.problems]
    return found


def run(args: argparse.Namespace) -> None:
    from minibrain.object_store import apply as apply_storage
    from minibrain.registry.db import make_sessions, migrate
    from minibrain.registry.files import store_for
    from minibrain.settings import load_settings

    settings = load_settings()
    migrate(settings.database_url)
    sessions = make_sessions(settings.database_url)
    keys = keys_for(settings)
    keys.attach(sessions)
    store = store_for(settings)
    with sessions() as session:
        apply_storage(store, session, settings)
        ensure_master_key(session, keys, ACTOR)
        session.commit()
        started = now()
        note = ""
        if args.action == "rotate":
            before, after, note = rotate_key(session, keys, ACTOR)
            session.commit()
            print(f"Master key {before} -> {after}" if before != after else f"Master key stays {after}")
            tally = run_pass(session, store, keys, Plan(rewrap=True))
            grace = timedelta(0) if args.retire_now else GRACE
            retired = retire_unused(session, keys, tally, grace, ACTOR)
            if retired:
                print(f"Retired {', '.join(retired)}")
            elif not tally.older and not tally.secrets_older:
                print(f"Older key versions stay readable until {(now() + grace).isoformat(timespec='minutes')}")
        elif args.action == "encrypt-existing":
            tally = run_pass(session, store, keys, Plan(encrypt=True))
        else:
            tally = run_pass(session, store, keys, Plan())
        if args.action != "status":
            action = "encryption.rewrap" if args.action == "rotate" else "encryption.encrypt_existing"
            detail = {key: value for key, value in asdict(tally).items() if key != "problems"}
            session.add(AuditEvent(actor=ACTOR, action=action, target="encryption", detail=detail))
        save_last(session, {"status": "check", "rotate": "rotate"}.get(args.action, "encrypt"), tally, started)
        session.commit()
        records = records_of(session)
    sealing = keys.sealing()
    kind = keys.kind()
    current = keys.target().current() if sealing else ""
    where = keys.target().describe() if sealing else ""
    if getattr(args, "json", False):
        print(json.dumps({"provider": kind, "key": current, "where": where, "keys": records} | asdict(tally), indent=2))
    else:
        print("\n".join(lines(kind, current, where, tally, records)))
        if note:
            print(note)
    if tally.damaged:
        raise SystemExit(1)
