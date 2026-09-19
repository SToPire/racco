#!/usr/bin/env python3
"""Check Agent Notes and append archive seals.

Requires Python 3.10+. Archive verification uses Git's committed manifest as
the local baseline; CI must supply a trusted pre-change commit with --base-ref.
"""

from __future__ import annotations

import argparse
from datetime import date
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys


LIFECYCLES = ("proposed", "implemented", "rejected")
CLASSES = ("architecture", "process", "feature", "bug-fix", "simplification", "testing")
NOTE_NAME = re.compile(r"(\d{4}-\d{2}-\d{2})-.+\.md")
MANIFEST = Path(".agents/notes/archived/manifest.json")
REQUIRED = {
    "proposed": ("## Proposal", "## Acceptance criteria", "## Risks"),
    "implemented": ("## Decision", "## Consequences"),
    "rejected": ("## Proposal",),
}


def content_hash(content: bytes) -> str:
    """Return a SHA-256 archive seal, independent of Git's object format."""
    return "sha256:" + hashlib.sha256(content).hexdigest()


def prose_lines(text: str) -> list[str]:
    """Exclude fenced examples and HTML comments from structural checks."""
    text = re.sub(r"<!--[\s\S]*?-->", "", text)
    result = []
    fence = None
    for line in text.splitlines():
        match = re.match(r"^ {0,3}(`{3,}|~{3,})(.*)$", line)
        if match:
            marker, rest = match.groups()
            if fence is None:
                fence = marker
            elif marker[0] == fence[0] and len(marker) >= len(fence) and not rest.strip():
                fence = None
            continue
        if fence is None:
            result.append(line)
    return result


def valid_date(value: str) -> bool:
    """Accept calendar dates written exactly as YYYY-MM-DD."""
    try:
        return date.fromisoformat(value).isoformat() == value
    except ValueError:
        return False


def read_text(path: Path) -> str:
    """Read literal UTF-8 bytes so newline checks do not normalize CRLF."""
    return path.read_bytes().decode("utf-8")


def validate_note(source: Path, lifecycle: str, errors: list[str]) -> None:
    """Validate lifecycle headers and the required section grammar."""
    archived = lifecycle == "archived"
    status = "implemented" if archived else lifecycle
    lines = read_text(source).splitlines()
    if len(lines) < (5 if archived else 4):
        errors.append(f"{source}: incomplete header")
        return
    if not re.match(r"^# Agent Note: \S", lines[0]) or lines[1] != "":
        errors.append(f"{source}: expected title on line 1 and blank line 2")
    grammar = r"Status: rejected — \S.*" if status == "rejected" else f"Status: {status}"
    if not re.fullmatch(grammar, lines[2]):
        errors.append(f"{source}: status must match {status}")
    offset = 1 if archived else 0
    if archived:
        value = lines[3].removeprefix("Archived: ")
        if not lines[3].startswith("Archived: ") or not valid_date(value) or value < source.name[:10]:
            errors.append(f"{source}: invalid archive date or date before proposal")
    if lines[3 + offset] != "":
        errors.append(f"{source}: blank line required after metadata")
    prose = prose_lines(read_text(source))
    if sum(line.startswith("Status:") for line in prose) != 1:
        errors.append(f"{source}: expected exactly one Status line")
    if sum(line.startswith("Archived:") for line in prose) != offset:
        errors.append(f"{source}: unexpected or duplicate Archived line")
    if archived:
        return
    headings = [line.rstrip() for line in prose if line.startswith("## ")]
    if not headings or headings[0] != "## Problem":
        errors.append(f"{source}: first section must be ## Problem")
    for required in (*REQUIRED[lifecycle], "## Alternatives considered"):
        if required not in headings:
            errors.append(f"{source}: missing {required}")
    if lifecycle == "implemented" and any(
        re.match(r"## (Proposal\b|Plan\b|Migration plan\b|Acceptance criteria\b)", h, re.I)
        for h in headings
    ):
        errors.append(f"{source}: implemented notes cannot contain proposal-era headings")


def inventory(root: Path, errors: list[str]) -> tuple[list[tuple[Path, str]], dict[str, bytes]]:
    """Discover note files and reject unknown or hidden note locations."""
    notes_root = root / ".agents/notes"
    if not notes_root.is_dir() or notes_root.is_symlink():
        errors.append(f"{notes_root}: missing regular Agent Notes directory")
        return [], {}
    allowed_root = {"README.md", "AGENTS.md", ".gitattributes"}
    for entry in notes_root.iterdir():
        if entry.is_symlink() or entry.name not in {*LIFECYCLES, "archived", *allowed_root}:
            errors.append(f"{entry}: unexpected entry in Agent Notes root")
    for required in ("README.md", "AGENTS.md", ".gitattributes",
                     "implemented/AGENTS.md", "archived/AGENTS.md", "archived/manifest.json"):
        if not (notes_root / required).is_file():
            errors.append(f"{notes_root / required}: required file is missing")
    notes = []
    artifacts = {}
    identities = {}
    for lifecycle in (*LIFECYCLES, "archived"):
        folder = notes_root / lifecycle
        if folder.is_symlink() or not folder.is_dir():
            errors.append(f"{folder}: required regular lifecycle directory is missing")
            continue
        if lifecycle == "archived":
            for kind in CLASSES:
                if not (folder / kind).is_dir():
                    errors.append(f"{folder / kind}: required archive class directory is missing")
        for entry in sorted(folder.iterdir()):
            allowed = {"AGENTS.md", "manifest.json"} if lifecycle == "archived" else {"AGENTS.md"}
            if entry.is_file() and not entry.is_symlink() and entry.name in allowed:
                continue
            if entry.is_symlink() or not entry.is_dir() or entry.name not in CLASSES:
                errors.append(f"{entry}: expected a known class directory")
                continue
            for source in sorted(entry.iterdir()):
                if source.is_symlink() or not source.is_file():
                    errors.append(f"{source}: classes contain regular note files only")
                    continue
                if source.name == ".gitkeep" and source.read_bytes() == b"":
                    continue
                match = NOTE_NAME.fullmatch(source.name)
                if not match or not valid_date(match[1]):
                    errors.append(f"{source}: expected yyyy-mm-dd-topic.md filename")
                    continue
                if source.name in identities:
                    errors.append(f"{source}: duplicate note also exists at {identities[source.name]}")
                identities[source.name] = source
                notes.append((source, lifecycle))
                if lifecycle == "archived":
                    artifacts[f"{entry.name}/{source.name}"] = source.read_bytes()
    return notes, artifacts


def parse_manifest(text: str) -> dict[str, str]:
    """Parse the versioned, closed archive manifest schema."""
    def unique_object(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError(f"duplicate manifest key: {key}")
            result[key] = value
        return result
    value = json.loads(text, object_pairs_hook=unique_object)
    if not isinstance(value, dict) or set(value) != {"version", "files"} or type(value["version"]) is not int or value["version"] != 1:
        raise ValueError("expected manifest version 1 and exactly version/files fields")
    files = value["files"]
    if not isinstance(files, dict):
        raise ValueError("manifest files must be an object")
    for path, seal in files.items():
        parts = path.split("/")
        if len(parts) != 2 or parts[0] not in CLASSES or not isinstance(seal, str) or not re.fullmatch(r"sha256:[0-9a-f]{64}", seal):
            raise ValueError(f"invalid manifest entry: {path}")
    return files


def git(root: Path, *args: str) -> subprocess.CompletedProcess[str]:
    """Run Git synchronously in the target repository without changing global state."""
    return subprocess.run(["git", "-C", str(root), *args], capture_output=True, text=True, check=False)


def baseline_manifest(root: Path, ref: str | None, has_archive: bool) -> dict[str, str]:
    """Read committed seals, allowing an empty archive before the first Git commit."""
    if ref is not None and not ref.strip():
        raise ValueError("archive baseline cannot be empty")
    top = git(root, "rev-parse", "--show-toplevel")
    if top.returncode:
        if ref is None and not has_archive and not (root / ".git").exists():
            return {}
        raise ValueError("archive verification requires a readable Git repository")
    actual_ref = ref or "HEAD"
    commit = git(root, "rev-parse", "--verify", f"{actual_ref}^{{commit}}")
    if commit.returncode:
        branch = git(root, "symbolic-ref", "--quiet", "HEAD")
        if ref is None and not has_archive and branch.returncode == 0:
            exists = git(root, "show-ref", "--verify", "--quiet", branch.stdout.strip())
            if exists.returncode == 1:
                return {}
        raise ValueError(f"cannot resolve archive baseline {actual_ref!r}")
    repo = Path(top.stdout.strip()).resolve()
    manifest_path = (root / MANIFEST).relative_to(repo).as_posix()
    # Resolve once to a commit id; a branch moving during validation cannot swap the baseline.
    oid = commit.stdout.strip()
    entry = git(root, "ls-tree", "--name-only", oid, "--", manifest_path)
    if entry.returncode:
        raise ValueError(entry.stderr.strip())
    if not entry.stdout.strip():
        return {}
    content = git(root, "show", f"{oid}:{manifest_path}")
    if content.returncode:
        raise ValueError(content.stderr.strip())
    return parse_manifest(content.stdout)


def validate_archive(root: Path, artifacts: dict[str, bytes], ref: str | None,
                     errors: list[str], allow_new: bool = False) -> dict[str, str]:
    """Verify prior seals and return an append-only candidate manifest."""
    try:
        current = parse_manifest(read_text(root / MANIFEST))
        baseline = baseline_manifest(root, ref, bool(current or artifacts))
    except (ValueError, OSError) as error:
        errors.append(f"{MANIFEST}: {error}")
        return {}
    for path, seal in baseline.items():
        if current.get(path) != seal:
            errors.append(f"{path}: committed archive seal changed or was removed")
    for path, seal in current.items():
        if path not in artifacts:
            errors.append(f"{path}: sealed artifact is missing")
        elif content_hash(artifacts[path]) != seal:
            errors.append(f"{path}: sealed artifact content changed")
    extended = dict(current)
    for path, data in artifacts.items():
        if path not in current:
            if not allow_new:
                errors.append(f"{path}: unsealed archive artifact; run seal after review")
            extended[path] = content_hash(data)
    return extended


def check(root: Path, ref: str | None = None, seal: bool = False) -> list[str]:
    """Run structural checks and optionally append immutable archive seals."""
    errors = []
    notes, artifacts = inventory(root, errors)
    documents = [root / ".agents/notes/README.md", *(source for source, _ in notes)]
    for source in documents:
        if source.is_file() and not source.is_symlink():
            content = read_text(source)
            if not content.endswith("\n") or content.endswith("\n\n") or "\r" in content:
                errors.append(f"{source}: use LF and exactly one trailing newline")
    for source, lifecycle in notes:
        validate_note(source, lifecycle, errors)
    extended = validate_archive(root, artifacts, ref, errors, allow_new=seal)
    if seal and not errors:
        data = json.dumps({"version": 1, "files": dict(sorted(extended.items()))}, indent=2) + "\n"
        (root / MANIFEST).write_bytes(data.encode())
    return errors


def main() -> int:
    """Run the requested local operation; invalid content exits with status 1."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path.cwd(), help="target repository root")
    commands = parser.add_subparsers(dest="command", required=True)
    for command in ("check", "seal"):
        sub = commands.add_parser(command)
        sub.add_argument("--base-ref", default=os.environ.get("AGENT_NOTES_BASE_REF"),
                         help="trusted pre-change Git commit; defaults to local HEAD")
    args = parser.parse_args()
    root = args.root.resolve()
    try:
        errors = check(root, args.base_ref, seal=args.command == "seal")
    except (OSError, ValueError) as error:
        errors = [str(error)]
    if errors:
        print("Agent Notes validation failed:", file=sys.stderr)
        for error in errors:
            print(f"  {error}", file=sys.stderr)
        return 1
    print(f"Agent Notes {args.command}: OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
