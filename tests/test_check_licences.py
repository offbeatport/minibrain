import pytest

from scripts.check_licences import Package, allowed, problems, pypi_licence, web_packages


@pytest.mark.parametrize(
    ("expression", "expected"),
    [
        ("MIT", True),
        ("Apache-2.0 OR GPL-3.0-only", True),
        ("(MIT OR CC0-1.0)", True),
        ("MIT AND ISC AND BSD-3-Clause", True),
        ("Apache-2.0 WITH LLVM-exception", True),
        ("GPL-3.0-only", False),
        ("MIT AND AGPL-3.0-or-later", False),
        ("(GPL-2.0-only OR SSPL-1.0) AND MIT", False),
        ("Apache-2.0 WITH Classpath-exception-2.0", False),
        ("LicenseRef-Proprietary", False),
    ],
)
def test_licence_expressions(expression: str, expected: bool) -> None:
    assert allowed(expression) is expected


@pytest.mark.parametrize("expression", ["(MIT", "MIT OR", "MIT )"])
def test_broken_expressions_are_reported(expression: str) -> None:
    with pytest.raises(ValueError):
        allowed(expression)


def test_pypi_metadata_prefers_the_expression_then_classifiers_then_the_short_licence() -> None:
    classifiers = ["License :: OSI Approved :: MIT License", "License :: OSI Approved :: BSD License"]
    assert pypi_licence({"license_expression": "Apache-2.0", "classifiers": classifiers}) == "Apache-2.0"
    assert pypi_licence({"license": "whatever", "classifiers": classifiers}) == "MIT OR BSD"
    assert pypi_licence({"license": "Apache 2.0", "classifiers": []}) == "Apache-2.0"
    assert pypi_licence({"license": "Copyright\nfull text", "classifiers": []}) == ""


def test_problems_flag_copyleft_and_missing_licences_but_accept_listed_exceptions() -> None:
    packages = [
        Package("python", "fine", "1", "MIT"),
        Package("python", "copyleft", "1", "GPL-3.0-only"),
        Package("python", "unknown", "1", ""),
        Package("python", "nvidia-cublas", "1", "LicenseRef-NVIDIA-Software-License"),
        Package("python", "other", "1", "LicenseRef-NVIDIA-Software-License"),
        Package("python", "pykcs11", "1", "GPL-2.0-or-later"),
    ]
    found = problems(packages)
    assert [line.split(":")[0] for line in found] == ["python copyleft 1", "python unknown 1", "python other 1"]


def test_web_listing_is_read_per_version() -> None:
    listing = {"CC0 1.0 OR MIT": [{"name": "styles", "versions": ["1.0.0", "2.0.0"]}]}
    assert web_packages(listing) == [
        Package("web", "styles", "1.0.0", "CC0-1.0 OR MIT"),
        Package("web", "styles", "2.0.0", "CC0-1.0 OR MIT"),
    ]
    assert problems(web_packages(listing)) == []
