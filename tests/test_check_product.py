from scripts.check_product import AREAS, INVENTORY, ROOT, Surface, check, cli_commands, surface

SURFACE = Surface(
    routes=frozenset({"GET /api/datasets", "POST /api/datasets/{slug}/versions", "POST /v1/chat/completions"}),
    commands=frozenset({"minibrain serve", "minibrain keys rotate"}),
    sections=frozenset({"data", "auth"}),
    policies=frozenset({"network"}),
    roadmap=frozenset({"Recipes", "Retrieval"}),
)

DATA = """\
- **Dataset versions** · shipped · product, ml
  Train on exactly the rows you checked.
  UI: Data · API: GET /api/datasets, POST /api/datasets/{slug}/versions · Config: data.row_limit
- **Recipes** · planned · product
  Start a model from a worked use case.
  Roadmap: Recipes
"""
SERVING = """\
- **Gateway** · shipped · engineer
  Call any model through one OpenAI-compatible endpoint.
  API: POST /v1/chat/completions · CLI: minibrain serve, minibrain keys rotate · Config: auth.oidc · Policy: network
"""
USE_CASES = "- **Ticket routing** · planned · uses: Dataset versions, Recipes\n"


def inventory(sections: dict[str, str] | None = None) -> str:
    bodies = {"Data": DATA, "Serving": SERVING, "Use cases": USE_CASES} | (sections or {})
    areas = "\n".join(f"## {area}\n{bodies.get(area, '')}" for area in AREAS)
    return f"# Product\n\nUsers: product, engineer, ml\nPrinciples: any size\n\n{areas}"


def test_the_inventory_covers_the_product() -> None:
    assert check((ROOT / INVENTORY).read_text(), surface(ROOT)) == []


def test_a_complete_inventory_passes() -> None:
    assert check(inventory(), SURFACE) == []


def test_every_route_command_section_and_policy_needs_a_feature() -> None:
    serving = "- **Gateway** · shipped · engineer\n  Call any model.\n  CLI: minibrain serve\n"
    assert check(inventory({"Serving": serving}), SURFACE) == [
        "route POST /v1/chat/completions is in no feature",
        "command minibrain keys rotate is in no feature",
        "config section auth is in no feature",
        "policy network is in no feature",
    ]


def test_names_are_unique_and_use_cases_name_features() -> None:
    cases = """\
- **Ticket routing** · planned · uses: Dataset versions, Retrieval index
- **Recipes** · planned · uses: Recipes
"""
    assert check(inventory({"Use cases": cases}), SURFACE) == [
        "37: Recipes is listed twice",
        "36: Ticket routing: uses Retrieval index, which is not a feature",
    ]


def test_features_keep_the_shape() -> None:
    data = """\
- **Dataset versions** · done · admin
  Train on exactly the rows you checked, every time, on every model, in every pool.
  API: GET /api/datasets, POST /api/datasets/{slug}/versions, GET /api/gone · Config: data, nowhere.key
- **Recipes** · planned · product
  Start a model from a worked use case.
  UI: Models
- **Index** · partial · product
  Answer from documents.
  Roadmap: Indexing
"""
    assert check(inventory({"Data": data}), SURFACE) == [
        "7: Dataset versions: status done is not one of shipped, partial, planned",
        "7: Dataset versions: users admin must come from the Users line",
        "7: Dataset versions: the value line has more than 12 words",
        "10: Recipes: planned features end the where line with Roadmap: <section>",
        "13: Index: Roadmap Indexing is not a ROADMAP.md section",
    ]


def test_shipped_features_name_only_what_exists() -> None:
    data = DATA.replace("GET /api/datasets, ", "GET /api/datasets, GET /api/gone, ").replace("data.row_limit", "nope.x")
    assert check(inventory({"Data": data}), SURFACE) == [
        "7: Dataset versions: API GET /api/gone: no such route",
        "7: Dataset versions: Config nope.x: no such config section",
        "config section data is in no feature",
    ]


def test_areas_come_in_order() -> None:
    swapped = inventory().replace("## Models", "## Modelz")
    assert check(swapped, SURFACE)[0] == f"areas must be, in order: {', '.join(AREAS)}"


def test_cli_commands_are_the_leaf_subcommands() -> None:
    source = """
import argparse

def main():
    parser = argparse.ArgumentParser(prog="minibrain")
    commands = parser.add_subparsers(dest="command")
    commands.add_parser("serve")
    keys = commands.add_parser("keys")
    actions = keys.add_subparsers(dest="action")
    actions.add_parser("status")
    rotate = actions.add_parser("rotate")
    rotate.add_argument("--retire-now")
"""
    assert cli_commands(source) == {"minibrain serve", "minibrain keys status", "minibrain keys rotate"}
